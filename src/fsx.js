import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function writeText(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, value.endsWith('\n') ? value : `${value}\n`, { mode: 0o600 });
}

export function sanitizeSlug(value, fallback = 'session') {
  const clean = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return clean || fallback;
}

export function isSubPath(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
