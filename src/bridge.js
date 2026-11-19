import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { WorkspaceIndex } from './rag.js';
import { isAuthorized, isCommandBlocked, resolveSafePath } from './security.js';
import { geminiToOllama, ollamaToGemini } from './translators.js';

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Payload too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON payload');
        err.status = 400;
        reject(err);
      }
    });

    req.on('error', (err) => reject(err));
  });
}

/**
 * Create a local-agent-bridge HTTP server instance.
 */
export function createBridgeServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 8081;
  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  const ollamaUrl = (options.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const enableExec = Boolean(options.enableExec);
  const apiToken = options.apiToken || '';
  const geminiApiKey = options.geminiApiKey || '';
  const corsOrigin = options.corsOrigin || '*';
  const configPath = options.configPath || null;
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;

  const state = {
    useCloud: Boolean(options.useCloud),
    activeModel: options.activeModel || 'gemma4:latest',
    embedModel: options.embedModel || '',
  };

  const index = new WorkspaceIndex();
  const sseClients = new Set();

  function log(msg) {
    const line = `[local-agent-bridge] ${msg}`;
    const event = `data: ${JSON.stringify({ timestamp: Date.now(), msg: line })}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(event);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  async function persistConfig() {
    if (!configPath) return;
    await fs.writeFile(configPath, JSON.stringify(state, null, 2), 'utf8');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        mode: state.useCloud ? 'cloud' : 'local',
        activeModel: state.activeModel,
        embedModel: state.embedModel,
        ollamaUrl,
        workspaceRoot,
        enableExec,
        indexedDocs: index.docs.length,
      });
    }

    if (!isAuthorized(req, apiToken)) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    try {
      if (req.method === 'GET') {
        if (pathname === '/api/config') {
          return sendJson(res, 200, { config: { ...state } });
        }

        if (pathname === '/api/models') {
          try {
            const upstream = await fetch(`${ollamaUrl}/api/tags`);
            if (!upstream.ok) {
              return sendJson(res, 502, { error: `Ollama responded with ${upstream.status}` });
            }
            const data = await upstream.json();
            return sendJson(res, 200, { models: data.models || [] });
          } catch (err) {
            return sendJson(res, 502, { error: `Unable to reach Ollama at ${ollamaUrl}: ${err.message}` });
          }
        }

        if (pathname === '/api/logs/stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({ timestamp: Date.now(), msg: 'Connected to local-agent-bridge log stream' })}\n\n`);
          sseClients.add(res);
          req.on('close', () => sseClients.delete(res));
          return;
        }

        return sendJson(res, 404, { error: 'Not found' });
      }

      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: 'Method not allowed' });
      }

      const data = await readJsonBody(req, maxBodyBytes);

      if (pathname === '/api/config') {
        if (typeof data.useCloud === 'boolean') state.useCloud = data.useCloud;
        if (typeof data.activeModel === 'string' && data.activeModel.trim()) {
          state.activeModel = data.activeModel.trim();
        }
        if (typeof data.embedModel === 'string') state.embedModel = data.embedModel.trim();
        await persistConfig();
        log(`Updated config: model=${state.activeModel}, useCloud=${state.useCloud}`);
        return sendJson(res, 200, { config: { ...state } });
      }

      // Drop-in Gemini REST proxy
      if (pathname.startsWith('/v1beta/models/') || pathname.startsWith('/v1/models/')) {
        if (state.useCloud) {
          if (!geminiApiKey) {
            return sendJson(res, 400, { error: 'Cloud mode enabled but GEMINI_API_KEY is not configured' });
          }
          const cloudRes = await fetch(`https://generativelanguage.googleapis.com${req.url}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': geminiApiKey,
            },
            body: JSON.stringify(data),
          });
          const cloudData = await cloudRes.json();
          return sendJson(res, cloudRes.status, cloudData);
        }

        const ollamaBody = geminiToOllama(data, state.activeModel);
        log(`Proxying Gemini request -> local Ollama (${state.activeModel})`);
        const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ollamaBody),
        });
        if (!ollamaRes.ok) {
          return sendJson(res, 502, { error: `Ollama error: ${ollamaRes.statusText}` });
        }
        const ollamaData = await ollamaRes.json();
        return sendJson(res, 200, ollamaToGemini(ollamaData));
      }

      if (pathname === '/api/chat') {
        const targetModel = (typeof data.model === 'string' && data.model.trim()) || state.activeModel;
        const messages = Array.isArray(data.messages)
          ? [...data.messages]
          : data.prompt
            ? [{ role: 'user', content: String(data.prompt) }]
            : [];
        if (messages.length === 0) {
          return sendJson(res, 400, { error: 'Missing prompt or messages' });
        }

        if (data.useRag && index.docs.length > 0) {
          const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
          const hits = await index.search(lastUser, { topK: 3, ollamaUrl, embedModel: state.embedModel });
          if (hits.length > 0) {
            const contextBlock = hits.map((h) => `[${h.path}]\n${h.snippet}`).join('\n---\n');
            messages.unshift({ role: 'system', content: `Workspace context:\n${contextBlock}` });
          }
        }

        const ollamaRes = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: targetModel,
            messages,
            stream: false,
            options: { temperature: data.temperature ?? 0.7 },
          }),
        });
        if (!ollamaRes.ok) {
          return sendJson(res, 502, { error: `Ollama error: ${ollamaRes.statusText}` });
        }
        const raw = await ollamaRes.json();
        return sendJson(res, 200, { model: targetModel, message: raw.message || null, raw });
      }

      if (pathname === '/api/fs/list') {
        const dirPath = resolveSafePath(workspaceRoot, data.path || '.');
        const dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
        const entries = [];
        for (const entry of dirEntries) {
          const full = path.join(dirPath, entry.name);
          const stat = await fs.lstat(full);
          entries.push({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: stat.size,
          });
        }
        return sendJson(res, 200, { entries });
      }

      if (pathname === '/api/fs/read') {
        const filePath = resolveSafePath(workspaceRoot, data.path);
        try {
          const content = await fs.readFile(filePath, 'utf8');
          return sendJson(res, 200, { content });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return sendJson(res, 404, { error: 'File not found' });
          }
          throw err;
        }
      }

      if (pathname === '/api/fs/write') {
        if (data.content === undefined) {
          return sendJson(res, 400, { error: 'Missing content' });
        }
        const filePath = resolveSafePath(workspaceRoot, data.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const content = typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2);
        await fs.writeFile(filePath, content, 'utf8');
        return sendJson(res, 200, { success: true });
      }

      if (pathname === '/api/rag/ingest') {
        const result = await index.ingestDirectory(data.path || '.', workspaceRoot, {
          ollamaUrl,
          embedModel: state.embedModel,
        });
        log(`Ingested ${result.count} files (skipped ${result.skipped})`);
        return sendJson(res, 200, { success: true, ...result });
      }

      if (pathname === '/api/search') {
        if (!data.query) {
          return sendJson(res, 400, { error: 'Missing query' });
        }
        const results = await index.search(String(data.query), {
          topK: data.topK ?? 5,
          ollamaUrl,
          embedModel: state.embedModel,
        });
        return sendJson(res, 200, { results });
      }

      if (pathname === '/api/exec') {
        if (!enableExec) {
          return sendJson(res, 403, {
            error: 'Shell execution is disabled (start with --enable-exec or ENABLE_EXEC=true)',
          });
        }
        if (isCommandBlocked(data.command)) {
          return sendJson(res, 403, { error: 'Command blocked by safety filter' });
        }
        const cwd = data.cwd ? resolveSafePath(workspaceRoot, data.cwd) : workspaceRoot;
        const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
        const args = process.platform === 'win32' ? ['-NoProfile', '-Command', data.command] : ['-c', data.command];

        execFile(shell, args, { cwd, timeout: 15000 }, (error, stdout, stderr) => {
          sendJson(res, 200, {
            stdout: stdout || '',
            stderr: stderr || '',
            error: error ? error.message : null,
          });
        });
        return;
      }

      return sendJson(res, 404, { error: 'Endpoint not found' });
    } catch (err) {
      if (err.code === 'E_UNSAFE_PATH') {
        return sendJson(res, 403, { error: err.message });
      }
      if (err.status) {
        return sendJson(res, err.status, { error: err.message });
      }
      return sendJson(res, 500, { error: err.message || 'Internal server error' });
    }
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const addr = server.address();
        resolve({ host, port: typeof addr === 'object' && addr ? addr.port : port });
      });
    });
  }

  function close() {
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // Ignore already-closed client
      }
    }
    sseClients.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, state, index, listen, close };
}
