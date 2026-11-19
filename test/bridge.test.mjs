import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBridgeServer } from '../src/bridge.js';
import { geminiToOllama, ollamaToGemini } from '../src/translators.js';

function startMockOllama() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const parsed = bodyStr ? JSON.parse(bodyStr) : {};
      requests.push({ url: req.url, method: req.method, body: parsed });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'gemma4:latest' }, { name: 'qwen2.5-coder:7b' }] }));
        return;
      }
      if (req.url === '/api/chat') {
        res.end(
          JSON.stringify({
            model: parsed.model || 'gemma4:latest',
            message: { role: 'assistant', content: `mock-reply:${parsed.messages?.at(-1)?.content || ''}` },
            prompt_eval_count: 12,
            eval_count: 8,
          })
        );
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test('geminiToOllama and ollamaToGemini map roles, images, and usage', () => {
  const ollamaReq = geminiToOllama(
    {
      systemInstruction: { parts: [{ text: 'System prompt' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Inspect this image' },
            { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
          ],
        },
        { role: 'model', parts: [{ text: 'Previous answer' }] },
      ],
      generationConfig: { temperature: 0.25, maxOutputTokens: 256 },
    },
    'qwen2.5-coder:7b'
  );

  assert.equal(ollamaReq.model, 'qwen2.5-coder:7b');
  assert.equal(ollamaReq.stream, false);
  assert.deepEqual(ollamaReq.options, { temperature: 0.25, num_predict: 256 });
  assert.equal(ollamaReq.messages.length, 3);
  assert.deepEqual(ollamaReq.messages[0], { role: 'system', content: 'System prompt' });
  assert.deepEqual(ollamaReq.messages[1], {
    role: 'user',
    content: 'Inspect this image',
    images: ['QUJD'],
  });
  assert.deepEqual(ollamaReq.messages[2], { role: 'assistant', content: 'Previous answer' });

  const gemRes = ollamaToGemini({
    message: { role: 'assistant', content: 'Looks clean!' },
    prompt_eval_count: 10,
    eval_count: 5,
  });
  assert.equal(gemRes.candidates[0].content.parts[0].text, 'Looks clean!');
  assert.equal(gemRes.candidates[0].finishReason, 'STOP');
  assert.deepEqual(gemRes.usageMetadata, {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15,
  });
});

test('health, models, Gemini proxy, and config security', async () => {
  const mockOllama = await startMockOllama();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-basic-'));
  const bridge = createBridgeServer({
    port: 0,
    workspaceRoot: tmpDir,
    ollamaUrl: mockOllama.url,
    activeModel: 'gemma4:latest',
    geminiApiKey: 'super-secret-gemini-key',
    apiToken: '',
  });
  const addr = await bridge.listen();
  const baseUrl = `http://${addr.host}:${addr.port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'local');
    assert.equal(health.activeModel, 'gemma4:latest');

    const modelsRes = await fetch(`${baseUrl}/api/models`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    assert.equal(modelsJson.models.length, 2);

    const gemRes = await fetch(`${baseUrl}/v1beta/models/gemini-2.5-flash:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello bridge' }] }] }),
    });
    assert.equal(gemRes.status, 200);
    const gemData = await gemRes.json();
    assert.equal(gemData.candidates[0].content.parts[0].text, 'mock-reply:hello bridge');
    assert.deepEqual(gemData.usageMetadata, {
      promptTokenCount: 12,
      candidatesTokenCount: 8,
      totalTokenCount: 20,
    });

    const cfgRes = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeModel: 'qwen2.5-coder:7b' }),
    });
    assert.equal(cfgRes.status, 200);
    const cfgRaw = await cfgRes.text();
    const cfgJson = JSON.parse(cfgRaw);
    assert.equal(cfgJson.config.activeModel, 'qwen2.5-coder:7b');
    assert.equal(cfgRaw.includes('super-secret-gemini-key'), false);
    assert.equal('geminiApiKey' in cfgJson.config, false);
    assert.equal('apiToken' in cfgJson.config, false);
  } finally {
    await bridge.close();
    await mockOllama.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('workspace filesystem jail and RAG ingest/search', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-fs-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-outside-'));
  const bridge = createBridgeServer({ port: 0, workspaceRoot: tmpDir });
  const addr = await bridge.listen();
  const baseUrl = `http://${addr.host}:${addr.port}`;

  try {
    const writeRes = await fetch(`${baseUrl}/api/fs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'notes/shader.md',
        content: 'Signed distance fields compute analytic raymarching geometry cleanly.',
      }),
    });
    assert.equal(writeRes.status, 200);

    const readRes = await fetch(`${baseUrl}/api/fs/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes/shader.md' }),
    });
    assert.equal(readRes.status, 200);
    const readJson = await readRes.json();
    assert.match(readJson.content, /Signed distance fields/);

    const listRes = await fetch(`${baseUrl}/api/fs/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes' }),
    });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.entries[0].name, 'shader.md');

    const traversalRes = await fetch(`${baseUrl}/api/fs/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../escape.txt' }),
    });
    assert.equal(traversalRes.status, 403);

    const absOutsideRes = await fetch(`${baseUrl}/api/fs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path.join(outsideDir, 'pwn.txt'), content: 'nope' }),
    });
    assert.equal(absOutsideRes.status, 403);

    const ingestRes = await fetch(`${baseUrl}/api/rag/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '.' }),
    });
    assert.equal(ingestRes.status, 200);
    const ingestJson = await ingestRes.json();
    assert.equal(ingestJson.count, 1);

    const searchRes = await fetch(`${baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'raymarching distance fields' }),
    });
    assert.equal(searchRes.status, 200);
    const searchJson = await searchRes.json();
    assert.equal(searchJson.results.length, 1);
    assert.match(searchJson.results[0].path, /shader\.md$/);
  } finally {
    await bridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('exec gating (disabled by default, sandboxed when enabled) and bearer auth', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-exec-'));
  const safeBridge = createBridgeServer({ port: 0, workspaceRoot: tmpDir, enableExec: false });
  const safeAddr = await safeBridge.listen();

  try {
    const blockedRes = await fetch(`http://${safeAddr.host}:${safeAddr.port}/api/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo ok' }),
    });
    assert.equal(blockedRes.status, 403);
  } finally {
    await safeBridge.close();
  }

  const authedBridge = createBridgeServer({
    port: 0,
    workspaceRoot: tmpDir,
    enableExec: true,
    apiToken: 'secret-token-123',
  });
  const authAddr = await authedBridge.listen();
  const baseUrl = `http://${authAddr.host}:${authAddr.port}`;

  try {
    const unauthRes = await fetch(`${baseUrl}/api/config`);
    assert.equal(unauthRes.status, 401);

    const okExecRes = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token-123',
      },
      body: JSON.stringify({ command: 'echo ok' }),
    });
    assert.equal(okExecRes.status, 200);
    const execJson = await okExecRes.json();
    assert.match(execJson.stdout.trim(), /ok/);

    const rmRes = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token-123',
      },
      body: JSON.stringify({ command: 'rm -rf /' }),
    });
    assert.equal(rmRes.status, 403);
  } finally {
    await authedBridge.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
