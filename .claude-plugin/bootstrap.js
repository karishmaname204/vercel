#!/usr/bin/env node
"use strict";
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { execSync, fork, spawn } = require("child_process");

const CONXA_HOME       = path.join(os.homedir(), ".conxa");
const RUNTIME_DIR      = path.join(CONXA_HOME, "runtime");
const SERVER_JS        = path.join(RUNTIME_DIR, "server.js");
const PID_FILE         = path.join(RUNTIME_DIR, "server.pid");
const BOOTSTRAP_FLAG   = path.join(CONXA_HOME, ".bootstrapped");
const SETTINGS_JSON    = path.join(os.homedir(), ".claude", "settings.json");
const GLOBAL_CLAUDE_MD = path.join(os.homedir(), ".claude", "CLAUDE.md");
const CONXA_CLAUDE_MD  = path.join(CONXA_HOME, "CLAUDE.md");

function registerGlobalClaudeMd() {
  const importLine = `@${CONXA_CLAUDE_MD}`;
  let existing = "";
  try { existing = fs.readFileSync(GLOBAL_CLAUDE_MD, "utf8"); } catch (_) {}
  if (existing.includes(importLine)) return;
  fs.mkdirSync(path.dirname(GLOBAL_CLAUDE_MD), { recursive: true });
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(GLOBAL_CLAUDE_MD, `${separator}\n${importLine}\n`, "utf8");
  process.stderr.write(`[conxa] Registered ~/.conxa/CLAUDE.md in ${GLOBAL_CLAUDE_MD}\n`);
}

function registerGlobalMcp() {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8")); } catch (_) {}
  const existing = settings.mcpServers && settings.mcpServers.conxa;
  if (existing && existing.args && existing.args[0] === SERVER_JS) return;
  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers.conxa = { command: "node", args: [SERVER_JS] };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_JSON), { recursive: true });
    fs.writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2) + "\n", "utf8");
    process.stderr.write(`[conxa] Registered shared MCP server in ${SETTINGS_JSON}\n`);
  } catch (e) {
    process.stderr.write(`[conxa] Warning: could not update settings.json: ${e.message}\n`);
  }
}

function installThisPlugin() {
  const pluginDir = path.join(__dirname, "..");
  const runtimeCli = path.join(RUNTIME_DIR, "cli.js");
  const cli = fs.existsSync(runtimeCli) ? runtimeCli : path.join(__dirname, "cli.js");
  try {
    execSync(`node "${cli}" install "${pluginDir}"`, { stdio: ["ignore", "pipe", "inherit"] });
  } catch (e) {
    process.stderr.write(`[conxa] Warning: plugin install step failed: ${e.message}\n`);
  }
}

function isServerRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // throws if dead
    // Verify the live PID is actually our server (guards against PID reuse)
    const { execSync: _exec } = require("child_process");
    const cmd = process.platform === "win32"
      ? `wmic process where "ProcessId=${pid}" get CommandLine /value 2>nul`
      : `ps -p ${pid} -o args=`;
    const out = _exec(cmd, { encoding: "utf8", stdio: ["ignore","pipe","ignore"] }).toLowerCase();
    return out.includes("server.js");
  } catch (_) {
    return false;
  }
}

function startServer() {
  if (isServerRunning()) {
    process.stderr.write("[conxa] Shared runtime already running, plugin data installed.\n");
    process.exit(0);
    return;
  }
  const child = fork(SERVER_JS, [], { stdio: "inherit" });
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch (_) {}
  child.on("exit", code => {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(code || 0);
  });
}

// ─── Setup MCP server (no-dependency inline server for first-time init) ────────
// Spawns init in the background and serves a minimal MCP server immediately so
// Claude Code does not time out. Exits cleanly when init finishes so Claude Code
// auto-reconnects and gets the real server.

function runSetupMcpServer(srcCli) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  const initProc = spawn(process.execPath, [srcCli, "init"], {
    stdio: ["ignore", "ignore", "inherit"],
    detached: false,
  });

  function mcpSend(obj) {
    const body = JSON.stringify(obj);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  function finishAndExit() {
    try { registerGlobalMcp(); } catch (_) {}
    try { registerGlobalClaudeMd(); } catch (_) {}
    try { installThisPlugin(); } catch (_) {}
    // Small delay so any in-flight MCP response is flushed before we exit.
    // Claude Code will auto-reconnect and this time bootstrap takes the normal path.
    setTimeout(() => process.exit(0), 300);
  }

  function handleMsg(msg) {
    const { id, method } = msg;
    if (method === "initialize") {
      mcpSend({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "conxa-setup", version: "1.0.0" },
      }});
    } else if (!method || method.startsWith("notifications/")) {
      // notifications have no id — no response needed
    } else if (method === "tools/list") {
      mcpSend({ jsonrpc: "2.0", id, result: { tools: [{
        name: "setup_status",
        description: "Check Conxa runtime setup. npm packages + Playwright Chromium are installing in the background (~2 min on first run).",
        inputSchema: { type: "object", properties: {}, required: [] },
      }]}});
    } else if (method === "tools/call") {
      const ready = fs.existsSync(BOOTSTRAP_FLAG) && fs.existsSync(SERVER_JS);
      mcpSend({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: ready
        ? "Conxa runtime setup complete. Run /reload-plugins to activate all skills."
        : "Conxa runtime is still setting up (npm install + Playwright Chromium). Takes ~2 min on first run. Call setup_status again to check."
      }]}});
      if (ready) finishAndExit();
    } else if (id !== undefined) {
      mcpSend({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" }});
    }
  }

  // Auto-exit when init finishes so Claude Code reconnects to the real server
  initProc.on("exit", (code) => {
    if (fs.existsSync(BOOTSTRAP_FLAG) && fs.existsSync(SERVER_JS)) {
      process.stderr.write("[conxa] Runtime init complete — handing off to real server.\n");
      finishAndExit();
    } else {
      process.stderr.write(`[conxa] Init exited with code ${code} but runtime not ready.\n`);
    }
  });

  process.stdin.on("end", () => {
    initProc.kill();
    process.exit(0);
  });

  // MCP stdio framing parser (byte-correct, no external deps)
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);
    while (true) {
      let sep = -1;
      for (let i = 0; i <= buf.length - 4; i++) {
        if (buf[i] === 0x0d && buf[i+1] === 0x0a && buf[i+2] === 0x0d && buf[i+3] === 0x0a) {
          sep = i; break;
        }
      }
      if (sep === -1) break;
      const headerStr = buf.slice(0, sep).toString("utf8");
      const m = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!m) { buf = buf.slice(sep + 4); continue; }
      const len = parseInt(m[1], 10);
      const bodyStart = sep + 4;
      if (buf.length < bodyStart + len) break;
      const body = buf.slice(bodyStart, bodyStart + len).toString("utf8");
      buf = buf.slice(bodyStart + len);
      try { handleMsg(JSON.parse(body)); } catch (_) {}
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (fs.existsSync(BOOTSTRAP_FLAG) && fs.existsSync(SERVER_JS)) {
  registerGlobalMcp();
  registerGlobalClaudeMd();
  installThisPlugin();
  startServer();
} else {
  const srcCli = path.join(__dirname, "cli.js");
  if (!fs.existsSync(srcCli)) {
    process.stderr.write("[conxa] bootstrap: cli.js not found next to bootstrap.js\n");
    process.exit(1);
  }
  runSetupMcpServer(srcCli);
}
