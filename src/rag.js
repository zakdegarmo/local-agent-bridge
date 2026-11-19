import fs from 'fs/promises';
import path from 'path';
import { resolveSafePath } from './security.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  'coverage',
]);

const ALLOWED_EXTS = new Set([
  '.md',
  '.txt',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.json',
  '.html',
  '.css',
  '.glsl',
  '.yaml',
  '.yml',
]);

const MAX_FILE_BYTES = 512 * 1024;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
}

function buildSnippet(content, queryTerms) {
  const lines = content.split(/\r?\n/);
  let bestLineIdx = 0;
  let bestHits = -1;

  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    let hits = 0;
    for (const q of queryTerms) {
      if (low.includes(q)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestLineIdx = i;
    }
  }

  const start = Math.max(0, bestLineIdx - 1);
  const end = Math.min(lines.length, bestLineIdx + 3);
  return lines.slice(start, end).join('\n').slice(0, 320);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

async function fetchEmbedding(text, ollamaUrl, embedModel) {
  if (!ollamaUrl || !embedModel) return null;
  try {
    const res = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, prompt: text.slice(0, 1400) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.embedding) ? data.embedding : null;
  } catch {
    return null;
  }
}

export class WorkspaceIndex {
  constructor() {
    this.docs = [];
  }

  /**
   * Recursively index text/code files under `dirPath` inside `workspaceRoot`.
   * @param {string} dirPath
   * @param {string} workspaceRoot
   * @param {{ ollamaUrl?: string, embedModel?: string }} [opts]
   */
  async ingestDirectory(dirPath, workspaceRoot, opts = {}) {
    const safeRoot = resolveSafePath(workspaceRoot, dirPath || '.');
    let count = 0;
    let skipped = 0;

    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          skipped++;
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) {
            skipped++;
            continue;
          }
          await walk(full);
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) {
          skipped++;
          continue;
        }

        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
          skipped++;
          continue;
        }

        const content = await fs.readFile(full, 'utf8');
        const tokens = tokenize(`${entry.name}\n${content}`);
        const termFreq = new Map();
        for (const tok of tokens) {
          termFreq.set(tok, (termFreq.get(tok) || 0) + 1);
        }

        const relPath = path.relative(workspaceRoot, full) || entry.name;
        const embedding = opts.embedModel
          ? await fetchEmbedding(`${relPath}\n${content}`, opts.ollamaUrl, opts.embedModel)
          : null;

        // Replace existing doc entry for this path if re-ingested
        this.docs = this.docs.filter((d) => d.id !== relPath);
        this.docs.push({
          id: relPath,
          title: entry.name,
          path: relPath,
          content,
          tokens,
          termFreq,
          length: tokens.length,
          embedding,
        });
        count++;
      }
    };

    const st = await fs.lstat(safeRoot);
    if (st.isDirectory()) {
      await walk(safeRoot);
    } else {
      const content = await fs.readFile(safeRoot, 'utf8');
      const tokens = tokenize(content);
      const termFreq = new Map();
      for (const tok of tokens) termFreq.set(tok, (termFreq.get(tok) || 0) + 1);
      const relPath = path.relative(workspaceRoot, safeRoot) || path.basename(safeRoot);
      this.docs = this.docs.filter((d) => d.id !== relPath);
      this.docs.push({
        id: relPath,
        title: path.basename(safeRoot),
        path: relPath,
        content,
        tokens,
        termFreq,
        length: tokens.length,
        embedding: null,
      });
      count = 1;
    }

    return { count, skipped };
  }

  /**
   * Search indexed documents using BM25 lexical scoring plus optional embedding similarity.
   * @param {string} query
   * @param {{ topK?: number, ollamaUrl?: string|null, embedModel?: string }} [options]
   */
  async search(query, { topK = 5, ollamaUrl = null, embedModel = '' } = {}) {
    if (!query || this.docs.length === 0) return [];
    const qTerms = tokenize(query);
    if (qTerms.length === 0) return [];

    const avgLen = this.docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, this.docs.length);
    const k1 = 1.5;
    const b = 0.75;

    const queryVec = embedModel && ollamaUrl ? await fetchEmbedding(query, ollamaUrl, embedModel) : null;

    const scored = [];
    for (const doc of this.docs) {
      let bm25 = 0;
      for (const term of qTerms) {
        const tf = doc.termFreq.get(term) || 0;
        if (tf === 0) continue;
        let df = 0;
        for (const d of this.docs) {
          if (d.termFreq.has(term)) df++;
        }
        const idf = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
        bm25 += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / Math.max(1, avgLen)))));
      }

      const vecSim = queryVec && doc.embedding ? Math.max(0, cosineSimilarity(queryVec, doc.embedding)) : 0;
      const score = bm25 + vecSim * 5.0;
      if (score > 0) {
        scored.push({
          title: doc.title,
          path: doc.path,
          score: Number(score.toFixed(4)),
          snippet: buildSnippet(doc.content, qTerms),
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}
