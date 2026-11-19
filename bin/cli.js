#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { createBridgeServer } from '../src/bridge.js';

function loadEnvFiles(workspaceRoot) {
  for (const name of ['.env', '.env.local']) {
    const p = path.join(workspaceRoot, name);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--port' && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (arg === '--host' && argv[i + 1]) {
      opts.host = argv[++i];
    } else if (arg === '--workspace' && argv[i + 1]) {
      opts.workspaceRoot = path.resolve(argv[++i]);
    } else if (arg === '--model' && argv[i + 1]) {
      opts.activeModel = argv[++i];
    } else if (arg === '--ollama-url' && argv[i + 1]) {
      opts.ollamaUrl = argv[++i];
    } else if (arg === '--embed-model' && argv[i + 1]) {
      opts.embedModel = argv[++i];
    } else if (arg === '--enable-exec') {
      opts.enableExec = true;
    } else if (arg === '--cloud') {
      opts.useCloud = true;
    } else if (arg === '--token' && argv[i + 1]) {
      opts.apiToken = argv[++i];
    }
  }
  return opts;
}

const cliOpts = parseArgs(process.argv.slice(2));
if (cliOpts.help) {
  console.log(`local-agent-bridge — Zero-dependency local AI proxy & workspace bridge

Usage:
  local-agent-bridge [options]

Options:
  --port <n>            Listen port (default: 8081)
  --host <addr>         Bind address (default: 127.0.0.1)
  --workspace <dir>     Workspace jail directory (default: cwd)
  --model <name>        Ollama chat model (default: gemma4:latest)
  --ollama-url <url>    Ollama base URL (default: http://127.0.0.1:11434)
  --embed-model <name>  Optional Ollama embedding model for hybrid RAG
  --enable-exec         Opt-in to /api/exec shell endpoint (default: off)
  --cloud               Start in cloud forwarding mode (requires GEMINI_API_KEY)
  --token <secret>      Require Bearer / x-api-key auth on requests
  --help, -h            Show this help message`);
  process.exit(0);
}

const workspaceRoot = cliOpts.workspaceRoot || path.resolve(process.env.WORKSPACE_ROOT || process.cwd());
loadEnvFiles(workspaceRoot);

const bridge = createBridgeServer({
  host: cliOpts.host || process.env.HOST || '127.0.0.1',
  port: cliOpts.port ?? (process.env.PORT ? Number(process.env.PORT) : 8081),
  workspaceRoot,
  ollamaUrl: cliOpts.ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  activeModel: cliOpts.activeModel || process.env.ACTIVE_MODEL || 'gemma4:latest',
  embedModel: cliOpts.embedModel || process.env.EMBED_MODEL || '',
  enableExec: cliOpts.enableExec ?? process.env.ENABLE_EXEC === 'true',
  useCloud: cliOpts.useCloud ?? process.env.USE_CLOUD === 'true',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  apiToken: cliOpts.apiToken || process.env.BRIDGE_TOKEN || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
});

const addr = await bridge.listen();
console.log(`
local-agent-bridge running on http://${addr.host}:${addr.port}
  Mode       : ${bridge.state.useCloud ? 'cloud (Gemini API)' : 'local (Ollama)'}
  Model      : ${bridge.state.activeModel}
  Workspace  : ${workspaceRoot}
  Shell Exec : ${Boolean(cliOpts.enableExec || process.env.ENABLE_EXEC === 'true') ? 'ENABLED (sandbox filter)' : 'disabled (safe default)'}
  Auth Token : ${(cliOpts.apiToken || process.env.BRIDGE_TOKEN) ? 'required' : 'none (localhost bind)'}
`);
