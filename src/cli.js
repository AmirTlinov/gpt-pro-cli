#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { paths, settings } from './config.js';
import {
  archiveLocalChats,
  nextMessageDir,
  readSessionCache,
  resolveSessionFromCache,
  sessionSlugFromUrl,
  writeMessageArtifacts,
  writeSessionCache,
} from './artifacts.js';
import { ensureDir, pathExists, writeText } from './fsx.js';
import { safeExtractZip, stageAttachment } from './zip.js';
import {
  cleanupStaleRuntime,
  ensureKeeper,
  keeperRequest,
  runtimeStatus,
  stopKeeper,
} from './runtime.js';

function usage() {
  return `gpt-pro

Commands:
  gpt-pro doctor
  gpt-pro login
  gpt-pro sessions [--project CLI_QUESTIONS]
  gpt-pro ask [--session new|current|<url>] [--project CLI_QUESTIONS] [--attach <zip-or-dir>] [--timeout <ms>] -- <prompt>
  gpt-pro smoke [--timeout <ms>]
  gpt-pro archive [--session all|latest|<index|id>] [--project CLI_QUESTIONS]
  gpt-pro stop
`;
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function resolvePath(value) {
  if (!value) return null;
  return path.resolve(process.cwd(), value);
}

function parseAskArgs(argv) {
  const options = {
    session: 'new',
    project: settings().projectName,
    attach: null,
    timeoutMs: settings().operationTimeoutMs,
    promptParts: [],
  };
  let afterDash = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (afterDash) {
      options.promptParts.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDash = true;
      continue;
    }
    if (arg === '--session') {
      options.session = argv[++index];
      continue;
    }
    if (arg === '--project') {
      options.project = argv[++index];
      continue;
    }
    if (arg === '--attach') {
      options.attach = resolvePath(argv[++index]);
      continue;
    }
    if (arg === '--timeout') {
      options.timeoutMs = Number.parseInt(argv[++index], 10);
      continue;
    }
    options.promptParts.push(arg);
  }
  const prompt = options.promptParts.join(' ').trim();
  if (!prompt) throw new Error('Prompt is required. Use: gpt-pro ask -- "your prompt"');
  if (!options.project) throw new Error('--project must not be empty');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive number of milliseconds');
  }
  return { ...options, prompt };
}

function parseSessionsArgs(argv) {
  const options = {
    project: settings().projectName,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = argv[++index];
      continue;
    }
    throw new Error(`Unknown sessions option: ${arg}`);
  }
  if (!options.project) throw new Error('--project must not be empty');
  return options;
}

function parseSmokeArgs(argv) {
  const options = {
    timeoutMs: settings().operationTimeoutMs,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--timeout') {
      options.timeoutMs = Number.parseInt(argv[++index], 10);
      continue;
    }
    throw new Error(`Unknown smoke option: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive number of milliseconds');
  }
  return options;
}

function parseArchiveArgs(argv) {
  const options = {
    project: settings().projectName,
    session: 'all',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = argv[++index];
      continue;
    }
    if (arg === '--session') {
      options.session = argv[++index];
      continue;
    }
    throw new Error(`Unknown archive option: ${arg}`);
  }
  if (!options.project) throw new Error('--project must not be empty');
  if (!options.session) throw new Error('--session must not be empty');
  return options;
}

async function copyIfExists(from, to) {
  if (!await pathExists(from)) return;
  await ensureDir(path.dirname(to));
  await fs.cp(from, to, { recursive: true });
}

async function findZipFiles(dir) {
  const found = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findZipFiles(absolute));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
      found.push(absolute);
    }
  }
  return found;
}

async function extractDownloadedArchives(filesDir) {
  const extracted = [];
  for (const zipFile of await findZipFiles(filesDir)) {
    const target = path.join(filesDir, `${path.basename(zipFile, '.zip')}-extracted`);
    const files = await safeExtractZip(zipFile, target);
    extracted.push(...files);
  }
  return extracted;
}

function insidePath(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function relocatePendingPath(pendingRoot, finalRoot, target) {
  if (!target) return target;
  const absolute = path.resolve(target);
  const root = path.resolve(pendingRoot);
  if (!insidePath(root, absolute)) return path.join(finalRoot, path.basename(absolute));
  return path.join(finalRoot, path.relative(root, absolute));
}

async function refreshSessions(project) {
  const runtime = await ensureKeeper({ mode: settings().browserMode });
  const result = await keeperRequest(runtime, '/sessions', {
    timeoutMs: 60_000,
    projectName: project,
  }, 65_000);
  const cache = await writeSessionCache(project, result.sessions, {
    url: result.url,
    projectUrl: result.project?.projectUrl || null,
  });
  return { runtime, result, cache };
}

async function resolveSessionOption(session, project) {
  if (!session || session === 'new' || session === 'current' || /^https?:\/\//.test(session)) {
    return { session, resolved: null };
  }

  let cache = await readSessionCache(project);
  let resolved = resolveSessionFromCache(cache, session);
  if (!resolved) {
    ({ cache } = await refreshSessions(project));
    resolved = resolveSessionFromCache(cache, session);
  }
  if (!resolved) {
    throw new Error(`Session "${session}" was not found in ${project}. Run "gpt-pro sessions" to refresh the list.`);
  }
  return { session: resolved.url, resolved };
}

async function upsertSessionCache(project, session, projectUrl = null) {
  const cache = await readSessionCache(project);
  const existing = Array.isArray(cache?.sessions) ? cache.sessions : [];
  const merged = [
    session,
    ...existing.filter((item) => item.url !== session.url),
  ];
  await writeSessionCache(project, merged, {
    url: cache?.url || null,
    projectUrl: projectUrl || cache?.projectUrl || null,
  });
}

async function doctor() {
  const rootPaths = paths();
  await ensureDir(rootPaths.root);
  await ensureDir(rootPaths.profileDir);
  await ensureDir(rootPaths.runtimeDir);
  await ensureDir(rootPaths.chatsDir);
  await ensureDir(rootPaths.sessionsDir);
  await ensureDir(rootPaths.archivesDir);
  const cleanup = await cleanupStaleRuntime();
  const status = await runtimeStatus();
  const chromeApp = '/Applications/Google Chrome.app';
  const chromeFound = await pathExists(chromeApp);

  const lines = [
    'OK',
    `home: ${rootPaths.root}`,
    `profile: ${rootPaths.profileDir}`,
    `runtime: ${rootPaths.runtimeDir}`,
    `archives: ${rootPaths.archivesDir}`,
    `chatgpt: ${settings().baseUrl}`,
    `project: ${settings().projectName}`,
    `chrome: ${chromeFound ? chromeApp : 'not found at /Applications/Google Chrome.app'}`,
    `keeper: ${status.healthy ? `${status.runtime.mode} pid=${status.runtime.pid}` : 'stopped'}`,
  ];
  if (cleanup.cleaned) lines.push(`cleanup: ${cleanup.reason}`);
  if (!chromeFound) lines[0] = 'WARN';
  console.log(lines.join('\n'));
}

async function login() {
  const runtime = await ensureKeeper({ mode: 'headed' });
  const result = await keeperRequest(runtime, '/login', { timeoutMs: settings().operationTimeoutMs }, settings().operationTimeoutMs + 5000);
  console.log([
    'OK',
    `url: ${result.url}`,
    `profile: ${paths().profileDir}`,
    `keeper: headed pid=${runtime.pid}`,
  ].join('\n'));
}

async function sessions(argv) {
  const options = parseSessionsArgs(argv);
  const { cache } = await refreshSessions(options.project);
  if (cache.sessions.length === 0) {
    console.log(`OK\nproject: ${options.project}\nsessions: none visible`);
    return;
  }
  console.log(['OK', `project: ${options.project}`, ...cache.sessions.map((session) => `${session.index}. ${session.title} [${session.shortId}]\n   ${session.url}`)].join('\n'));
}

async function runAsk(options) {
  const rootPaths = paths();
  const pendingId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const pendingDir = path.join(rootPaths.runtimeDir, 'pending', pendingId);
  const pendingAttachments = path.join(pendingDir, 'attachments');
  const pendingFiles = path.join(pendingDir, 'files');
  await ensureDir(pendingAttachments);
  await ensureDir(pendingFiles);
  await writeText(path.join(pendingDir, 'prompt.md'), options.prompt);

  let attachmentPath = null;
  if (options.attach) {
    attachmentPath = await stageAttachment(options.attach, path.join(pendingAttachments, 'input.zip'));
  }

  const startedAt = new Date();
  const resolvedSession = await resolveSessionOption(options.session, options.project);
  const runtime = await ensureKeeper({ mode: settings().browserMode });
  const result = await keeperRequest(runtime, '/ask', {
    session: resolvedSession.session,
    projectName: options.project,
    prompt: options.prompt,
    attachmentPath,
    downloadDir: pendingFiles,
    timeoutMs: options.timeoutMs,
  }, options.timeoutMs + 10_000);

  const sessionSlug = sessionSlugFromUrl(result.url, resolvedSession.session);
  const messageDir = await nextMessageDir(sessionSlug);
  await copyIfExists(pendingAttachments, path.join(messageDir, 'attachments'));
  await copyIfExists(pendingFiles, path.join(messageDir, 'files'));
  const finalFilesDir = path.join(messageDir, 'files');
  const browserDownloads = (result.downloads || []).map((download) => relocatePendingPath(pendingFiles, finalFilesDir, download));
  const linkDownloads = (result.linkDownloads || []).map((download) => ({
    ...download,
    path: download.path ? relocatePendingPath(pendingFiles, finalFilesDir, download.path) : null,
  }));
  const savedLinkDownloads = linkDownloads.filter((download) => download.status === 'saved' && download.path);
  const savedLinkPaths = new Set(savedLinkDownloads.map((download) => download.path));
  const browserOnlyDownloads = browserDownloads.filter((download) => !savedLinkPaths.has(download));
  const finalDownloads = [
    ...browserOnlyDownloads,
    ...savedLinkDownloads.map((download) => download.path),
  ];
  const extractedFiles = await extractDownloadedArchives(finalFilesDir);
  await writeMessageArtifacts(messageDir, {
    prompt: options.prompt,
    answer: result.answer || result.latestVisibleAnswer || '',
    reasoning: result.reasoning || '',
    links: result.links || [],
    downloads: [
      ...browserOnlyDownloads,
      ...linkDownloads,
      ...(result.downloadErrors || []),
    ],
    meta: {
      command: 'ask',
      requestedSession: options.session,
      resolvedSession: resolvedSession.resolved || null,
      project: options.project,
      projectUrl: result.project?.projectUrl || null,
      projectCreated: result.project?.created || false,
      sessionUrl: result.url,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      elapsedMs: result.elapsedMs,
      elapsed: formatDuration(result.elapsedMs),
      attachment: attachmentPath ? path.join(messageDir, 'attachments', 'input.zip') : null,
      downloads: finalDownloads,
      linkDownloads,
      downloadErrors: result.downloadErrors || [],
      extractedFiles,
      browserMode: runtime.mode,
    },
  });
  await fs.rm(pendingDir, { recursive: true, force: true });
  await upsertSessionCache(options.project, {
    title: options.prompt.split('\n').find(Boolean)?.trim().slice(0, 80) || 'Untitled',
    url: result.url,
  }, result.project?.projectUrl || null).catch(() => {});

  return {
    answerPath: path.join(messageDir, 'answer.md'),
    filesDir: finalFilesDir,
    messageDir,
    result,
    elapsed: formatDuration(result.elapsedMs),
  };
}

async function ask(argv) {
  const options = parseAskArgs(argv);
  const output = await runAsk(options);
  console.log([
    'OK',
    `answer: ${output.answerPath}`,
    `files: ${output.filesDir}`,
    `project: ${options.project}`,
    `elapsed: ${output.elapsed}`,
    `url: ${output.result.url}`,
  ].join('\n'));
}

async function smoke(argv) {
  const options = parseSmokeArgs(argv);
  const sentinel = process.env.GPT_PRO_SMOKE_SENTINEL || `GPT_PRO_SMOKE_${Date.now()}`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-smoke-'));
  await writeText(path.join(tempDir, 'proof.txt'), sentinel);
  try {
    const output = await runAsk({
      session: 'new',
      project: settings().projectName,
      attach: tempDir,
      timeoutMs: options.timeoutMs,
      prompt: 'Read proof.txt from the attached zip and reply exactly with its full contents.',
    });
    const answer = (await fs.readFile(output.answerPath, 'utf8')).trim();
    if (answer !== sentinel) {
      throw new Error(`Smoke answer mismatch. expected=${sentinel} actual=${answer}`);
    }
    if (!await pathExists(path.join(output.messageDir, 'attachments', 'input.zip'))) {
      throw new Error('Smoke attachment was not saved');
    }
    if (!await pathExists(path.join(output.messageDir, 'meta.json'))) {
      throw new Error('Smoke meta.json was not saved');
    }
    console.log([
      'OK',
      `answer: ${output.answerPath}`,
      `files: ${output.filesDir}`,
      `elapsed: ${output.elapsed}`,
      `url: ${output.result.url}`,
    ].join('\n'));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function archive(argv) {
  const options = parseArchiveArgs(argv);
  const warnings = [];
  let cache = null;
  try {
    ({ cache } = await refreshSessions(options.project));
  } catch (error) {
    warnings.push(`session refresh failed: ${error.message}`);
    cache = await readSessionCache(options.project);
  }
  const sessionsList = Array.isArray(cache?.sessions) ? cache.sessions : [];
  const result = await archiveLocalChats({
    projectName: options.project,
    sessionRef: options.session,
    sessions: sessionsList,
    warnings,
  });
  console.log([
    'OK',
    `archive: ${result.path}`,
    `project: ${options.project}`,
    `sessions: ${result.manifest.sessionsCount}`,
    `messages: ${result.manifest.messagesCount}`,
    `warnings: ${result.manifest.warnings.length}`,
    ...result.manifest.warnings.slice(0, 5).map((warning) => `warning: ${warning}`),
  ].join('\n'));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === 'doctor') return doctor();
  if (command === 'login') return login();
  if (command === 'sessions') return sessions(rest);
  if (command === 'ask') return ask(rest);
  if (command === 'smoke') return smoke(rest);
  if (command === 'archive') return archive(rest);
  if (command === 'stop') {
    const result = await stopKeeper();
    console.log(`OK\n${result.reason}`);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(`ERROR\n${error.message}`);
  process.exit(1);
});
