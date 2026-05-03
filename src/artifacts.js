import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { paths } from './config.js';
import { ensureDir, sanitizeSlug, writeJson, writeText } from './fsx.js';

export function sessionIdFromUrl(url) {
  return String(url || '').match(/\/c\/([a-zA-Z0-9-]+)/)?.[1] || '';
}

export function sessionSlugFromUrl(url, title = '') {
  const id = sessionIdFromUrl(url);
  if (id) return sanitizeSlug(id, 'session');
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
  if (Array.isArray(data.downloads) && data.downloads.length > 0) {
    await writeText(path.join(messageDir, 'downloads.md'), data.downloads.map((item) => {
      if (typeof item === 'string') return `- saved ${item}`;
      const detail = item.path || item.error || '';
      return `- ${item.status || 'unknown'} ${item.url || item.label || ''}${detail ? ` -> ${detail}` : ''}`.trim();
    }).join('\n'));
  }
  await writeJson(path.join(messageDir, 'meta.json'), data.meta || {});
}

function sessionCacheFile(projectName) {
  return path.join(paths().sessionsDir, `${sanitizeSlug(projectName, 'project')}.json`);
}

export function normalizeSession(session, index = 0) {
  const id = session.id || sessionIdFromUrl(session.url);
  return {
    index: index + 1,
    title: String(session.title || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled',
    id,
    shortId: id.slice(0, 8),
    url: session.url,
  };
}

export async function writeSessionCache(projectName, sessions, extra = {}) {
  const normalized = sessions.map((session, index) => normalizeSession(session, index));
  const cache = {
    project: projectName,
    updatedAt: new Date().toISOString(),
    url: extra.url || null,
    projectUrl: extra.projectUrl || null,
    sessions: normalized,
  };
  await writeJson(sessionCacheFile(projectName), cache);
  return cache;
}

export async function readSessionCache(projectName) {
  try {
    const raw = await fs.readFile(sessionCacheFile(projectName), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function resolveSessionFromCache(cache, ref) {
  const value = String(ref || '').trim();
  if (!cache || !Array.isArray(cache.sessions) || cache.sessions.length === 0) return null;
  if (value === 'latest') return cache.sessions[0];
  if (/^\d+$/.test(value)) {
    return cache.sessions[Number.parseInt(value, 10) - 1] || null;
  }
  const matches = cache.sessions.filter((session) => {
    return session.id === value
      || session.shortId === value
      || session.id.startsWith(value)
      || session.url === value;
  });
  return matches.length === 1 ? matches[0] : null;
}

async function addDirToArchive(zip, root, current, prefix) {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const rel = path.relative(root, absolute).split(path.sep).join('/');
    const archivePath = path.posix.join(prefix, rel);
    if (entry.isDirectory()) {
      await addDirToArchive(zip, root, absolute, prefix);
    } else if (entry.isFile()) {
      zip.addLocalFile(absolute, path.posix.dirname(archivePath) === '.' ? '' : path.posix.dirname(archivePath), path.posix.basename(archivePath));
    }
  }
}

async function countMessages(sessionDir) {
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && /^message-\d+$/.test(entry.name)).length;
}

function archiveTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-').replace('Z', '');
}

export async function archiveLocalChats({ projectName, sessionRef = 'all', sessions = [], warnings = [] }) {
  const rootPaths = paths();
  await ensureDir(rootPaths.archivesDir);
  const zip = new AdmZip();
  const selected = [];
  const localSessionDirs = await fs.readdir(rootPaths.chatsDir, { withFileTypes: true }).catch(() => []);
  const localIds = localSessionDirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  if (sessionRef === 'all') {
    selected.push(...localIds);
  } else {
    const id = sessionRef === 'latest'
      ? sessions[0]?.id
      : resolveSessionFromCache({ sessions }, sessionRef)?.id || sessionRef;
    if (id) selected.push(sanitizeSlug(id, 'session'));
  }

  let messagesCount = 0;
  const archivedSessions = [];
  for (const id of selected) {
    const sessionDir = path.join(rootPaths.chatsDir, id);
    const messages = await countMessages(sessionDir);
    if (messages === 0) {
      warnings.push(`no local messages for session ${id}`);
      continue;
    }
    messagesCount += messages;
    archivedSessions.push({ id, messages });
    await addDirToArchive(zip, sessionDir, sessionDir, `chats/${id}`);
  }

  const manifest = {
    project: projectName,
    createdAt: new Date().toISOString(),
    sessionRef,
    sessionsCount: archivedSessions.length,
    messagesCount,
    archivedSessions,
    warnings,
  };
  zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  zip.addFile('project-sessions.json', Buffer.from(`${JSON.stringify(sessions, null, 2)}\n`));

  const archivePath = path.join(rootPaths.archivesDir, `gpt-pro-${sanitizeSlug(projectName, 'project')}-${archiveTimestamp()}.zip`);
  zip.writeZip(archivePath);
  return {
    path: archivePath,
    manifest,
  };
}
