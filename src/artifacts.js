import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './config.js';
import { ensureDir, sanitizeSlug, writeJson, writeText } from './fsx.js';

export function sessionSlugFromUrl(url, title = '') {
  const match = String(url || '').match(/\/c\/([a-zA-Z0-9-]+)/);
  if (match) return sanitizeSlug(match[1], 'session');
  return sanitizeSlug(title || 'new-session', 'session');
}

export async function nextMessageDir(sessionSlug) {
  const base = path.join(paths().chatsDir, sanitizeSlug(sessionSlug));
  await ensureDir(base);
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  let max = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^message-(\d+)$/);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  const messageDir = path.join(base, `message-${max + 1}`);
  await ensureDir(messageDir);
  await ensureDir(path.join(messageDir, 'attachments'));
  await ensureDir(path.join(messageDir, 'files'));
  return messageDir;
}

export async function writeMessageArtifacts(messageDir, data) {
  await writeText(path.join(messageDir, 'prompt.md'), data.prompt || '');
  await writeText(path.join(messageDir, 'answer.md'), data.answer || '');
  if (data.reasoning) {
    await writeText(path.join(messageDir, 'reasoning.md'), data.reasoning);
  }
  if (Array.isArray(data.links) && data.links.length > 0) {
    await writeText(path.join(messageDir, 'links.md'), data.links.map((link) => `- ${link}`).join('\n'));
  }
  await writeJson(path.join(messageDir, 'meta.json'), data.meta || {});
}
