import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
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
  const receipt = await writeMessageReceipt(messageDir, data);
  return receipt;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

async function listReceiptFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listReceiptFiles(root, absolute));
    } else if (entry.isFile() && !['receipt.json', 'receipt.md'].includes(entry.name)) {
      const stat = await fs.stat(absolute);
      files.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        bytes: stat.size,
        sha256: await sha256File(absolute),
      });
    }
  }
  return files;
}

function receiptWarnings(data) {
  const warnings = [];
  const meta = data.meta || {};
  if (!String(data.answer || '').trim()) warnings.push('answer is empty');
  for (const item of meta.downloadErrors || []) {
    warnings.push(`download failed: ${item.label || item.url || 'download'}${item.error ? ` (${item.error.split('\n')[0]})` : ''}`);
  }
  if (!meta.project) warnings.push('project is missing in metadata');
  if (!meta.sessionUrl) warnings.push('session URL is missing in metadata');
  return warnings;
}

function receiptMarkdown(receipt) {
  const lines = [
    '# gpt-pro receipt',
    '',
    `status: ${receipt.status}`,
    `project: ${receipt.project || ''}`,
    `session: ${receipt.sessionUrl || ''}`,
    `created: ${receipt.createdAt}`,
    `files: ${receipt.counts.files}`,
    `downloads: ${receipt.counts.downloads}`,
    `download_errors: ${receipt.counts.downloadErrors}`,
    `extracted_files: ${receipt.counts.extractedFiles}`,
    '',
    '## Warnings',
  ];
  lines.push(...(receipt.warnings.length > 0 ? receipt.warnings.map((warning) => `- ${warning}`) : ['- none']));
  lines.push('', '## Hashes');
  for (const file of receipt.files) {
    lines.push(`- ${file.sha256}  ${file.bytes}  ${file.path}`);
  }
  return lines.join('\n');
}

async function writeMessageReceipt(messageDir, data) {
  const meta = data.meta || {};
  const files = await listReceiptFiles(messageDir);
  const warnings = receiptWarnings(data);
  const receipt = {
    version: 1,
    status: warnings.length > 0 ? 'warn' : 'ok',
    createdAt: new Date().toISOString(),
    messageDir: path.resolve(messageDir),
    project: meta.project || null,
    sessionUrl: meta.sessionUrl || null,
    command: meta.command || null,
    elapsedMs: meta.elapsedMs || null,
    counts: {
      files: files.length,
      downloads: Array.isArray(meta.downloads) ? meta.downloads.length : 0,
      linkDownloads: Array.isArray(meta.linkDownloads) ? meta.linkDownloads.length : 0,
      downloadErrors: Array.isArray(meta.downloadErrors) ? meta.downloadErrors.length : 0,
      extractedFiles: Array.isArray(meta.extractedFiles) ? meta.extractedFiles.length : 0,
    },
    warnings,
    files,
  };
  await writeJson(path.join(messageDir, 'receipt.json'), receipt);
  await writeText(path.join(messageDir, 'receipt.md'), receiptMarkdown(receipt));
  return {
    path: path.join(messageDir, 'receipt.json'),
    markdownPath: path.join(messageDir, 'receipt.md'),
    receipt,
  };
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

function uniqueSessionIds(sessions) {
  const ids = [];
  const seen = new Set();
  for (const session of sessions || []) {
    const id = session.id || sessionIdFromUrl(session.url);
    if (!id) continue;
    const safeId = sanitizeSlug(id, 'session');
    if (seen.has(safeId)) continue;
    seen.add(safeId);
    ids.push(safeId);
  }
  return ids;
}

function pushUnique(ids, seen, id) {
  if (!id) return;
  const safeId = sanitizeSlug(id, 'session');
  if (seen.has(safeId)) return;
  seen.add(safeId);
  ids.push(safeId);
}

async function localProjectSessionIds(projectName, chatsDir) {
  const ids = [];
  const seen = new Set();
  const localSessionDirs = await fs.readdir(chatsDir, { withFileTypes: true }).catch(() => []);
  for (const sessionEntry of localSessionDirs) {
    if (!sessionEntry.isDirectory()) continue;
    const sessionDir = path.join(chatsDir, sessionEntry.name);
    const messageDirs = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
    for (const messageEntry of messageDirs) {
      if (!messageEntry.isDirectory() || !/^message-\d+$/.test(messageEntry.name)) continue;
      try {
        const metaPath = path.join(sessionDir, messageEntry.name, 'meta.json');
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        if (meta.project === projectName) {
          pushUnique(ids, seen, sessionEntry.name);
          break;
        }
      } catch {
        // Older local chats may not have metadata. They stay out unless the project cache names them.
      }
    }
  }
  return ids;
}

async function localSessionBelongsToProject(projectName, chatsDir, sessionId) {
  const sessionDir = path.join(chatsDir, sanitizeSlug(sessionId, 'session'));
  const messageDirs = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  for (const messageEntry of messageDirs) {
    if (!messageEntry.isDirectory() || !/^message-\d+$/.test(messageEntry.name)) continue;
    try {
      const metaPath = path.join(sessionDir, messageEntry.name, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      if (meta.project === projectName) return true;
    } catch {
      // Keep looking. A session can contain older messages before metadata existed.
    }
  }
  return false;
}

function normalizedProjectUrlHint(projectName) {
  return sanitizeSlug(projectName, 'project').toLowerCase().replace(/[._]+/g, '-');
}

function urlLooksLikeProjectSession(url, projectName) {
  const value = String(url || '').toLowerCase();
  const hint = normalizedProjectUrlHint(projectName);
  return value.includes('/g/') && value.includes('/c/') && value.includes(hint);
}

function resolveArchiveSessionId(sessionRef, sessions) {
  if (sessionRef === 'latest') return sessions[0]?.id || '';
  const cached = resolveSessionFromCache({ sessions }, sessionRef);
  if (cached?.id) return cached.id;
  if (/^https?:\/\//.test(String(sessionRef || ''))) {
    return sessionIdFromUrl(sessionRef) || sessionRef;
  }
  if (/^\d+$/.test(String(sessionRef || ''))) return '';
  return sessionRef;
}

function archiveTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-').replace('Z', '');
}

export async function archiveLocalChats({ projectName, sessionRef = 'all', sessions = [], warnings = [] }) {
  const rootPaths = paths();
  await ensureDir(rootPaths.archivesDir);
  const zip = new AdmZip();
  const selected = [];

  if (sessionRef === 'all') {
    const seen = new Set();
    for (const id of uniqueSessionIds(sessions)) pushUnique(selected, seen, id);
    for (const id of await localProjectSessionIds(projectName, rootPaths.chatsDir)) pushUnique(selected, seen, id);
    if (selected.length === 0) {
      warnings.push(`no sessions found for project ${projectName}; run "gpt-pro sessions" after login`);
    }
  } else {
    const id = resolveArchiveSessionId(sessionRef, sessions);
    if (id) {
      const safeId = sanitizeSlug(id, 'session');
      const cachedIds = new Set(uniqueSessionIds(sessions));
      const isProjectSession = cachedIds.has(safeId)
        || await localSessionBelongsToProject(projectName, rootPaths.chatsDir, safeId)
        || urlLooksLikeProjectSession(sessionRef, projectName);
      if (isProjectSession) {
        selected.push(safeId);
      } else {
        warnings.push(`session ${sessionRef} is not known in project ${projectName}`);
      }
    } else {
      warnings.push(`session ${sessionRef} was not found in cached project sessions`);
    }
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
