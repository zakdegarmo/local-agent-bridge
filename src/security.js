import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function normalizeCase(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isWithinCanonicalRoot(canonicalRoot, canonicalTarget) {
  const rootCmp = normalizeCase(canonicalRoot);
  const targetCmp = normalizeCase(canonicalTarget);
  return targetCmp === rootCmp || targetCmp.startsWith(rootCmp + path.sep);
}

function realpathNearestAncestor(absPath) {
  const missingParts = [];
  let cursor = absPath;

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missingParts.unshift(path.basename(cursor));
    cursor = parent;
  }

  let baseReal;
  try {
    baseReal = fs.realpathSync(cursor);
  } catch {
    baseReal = path.resolve(cursor);
  }
  return path.join(baseReal, ...missingParts);
}

function unsafeError(message) {
  const err = new Error(message);
  err.code = 'E_UNSAFE_PATH';
  return err;
}

/**
 * Resolve `targetPath` strictly inside `workspaceRoot`, defending against traversal and symlinks.
 * @param {string} workspaceRoot
 * @param {string} targetPath
 * @returns {string}
 */
export function resolveSafePath(workspaceRoot, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '' || targetPath.includes('\0')) {
    throw unsafeError('Invalid or empty path');
  }

  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(path.resolve(workspaceRoot));
  } catch {
    canonicalRoot = path.resolve(workspaceRoot);
  }

  const candidate = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(canonicalRoot, targetPath);

  const canonicalTarget = realpathNearestAncestor(candidate);
  if (!isWithinCanonicalRoot(canonicalRoot, canonicalTarget)) {
    throw unsafeError(`Path escapes workspace jail: ${targetPath}`);
  }

  return canonicalTarget;
}

/**
 * Validate bearer or x-api-key header using timing-safe comparison when `apiToken` is set.
 * @param {import('http').IncomingMessage} req
 * @param {string} apiToken
 */
export function isAuthorized(req, apiToken) {
  if (!apiToken) return true;

  const authHeader = String(req.headers['authorization'] || '');
  let presented = '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    presented = authHeader.slice(7).trim();
  } else if (req.headers['x-api-key']) {
    presented = String(req.headers['x-api-key']).trim();
  }

  const expectedBuf = Buffer.from(String(apiToken), 'utf8');
  const actualBuf = Buffer.from(presented, 'utf8');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

const BLOCKED_COMMAND_PATTERNS = [
  'rm -rf',
  'rm ',
  'del ',
  'erase ',
  'rmdir',
  'rd ',
  'remove-item',
  'format ',
  'shutdown',
  'reboot',
  'mkfs',
  'dd if=',
];

/**
 * Return true if `command` matches common destructive shell patterns.
 * @param {string} command
 */
export function isCommandBlocked(command) {
  if (typeof command !== 'string' || !command.trim()) return true;
  const lower = command.toLowerCase();
  return BLOCKED_COMMAND_PATTERNS.some((pattern) => lower.includes(pattern));
}
