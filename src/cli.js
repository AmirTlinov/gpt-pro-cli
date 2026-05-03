#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { paths, settings } from './config.js';
import { nextMessageDir, sessionSlugFromUrl, writeMessageArtifacts } from './artifacts.js';
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

async function doctor() {
  const rootPaths = paths();
  await ensureDir(rootPaths.root);
  await ensureDir(rootPaths.profileDir);
  await ensureDir(rootPaths.runtimeDir);
  await ensureDir(rootPaths.chatsDir);
  const cleanup = await cleanupStaleRuntime();
  const status = await runtimeStatus();
  const chromeApp = '/Applications/Google Chrome.app';
  const chromeFound = await pathExists(chromeApp);

  const lines = [
    'OK',
    `home: ${rootPaths.root}`,
    `profile: ${rootPaths.profileDir}`,
    `runtime: ${rootPaths.runtimeDir}`,
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
  const runtime = await ensureKeeper({ mode: settings().browserMode });
  const result = await keeperRequest(runtime, '/sessions', {
    timeoutMs: 60_000,
    projectName: options.project,
  }, 65_000);
  if (result.sessions.length === 0) {
    console.log(`OK\nproject: ${options.project}\nsessions: none visible`);
    return;
  }
  console.log(['OK', `project: ${options.project}`, ...result.sessions.map((session, index) => `${index + 1}. ${session.title}\n   ${session.url}`)].join('\n'));
}

async function ask(argv) {
  const options = parseAskArgs(argv);
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
  const runtime = await ensureKeeper({ mode: settings().browserMode });
  const result = await keeperRequest(runtime, '/ask', {
    session: options.session,
    projectName: options.project,
    prompt: options.prompt,
    attachmentPath,
    downloadDir: pendingFiles,
    timeoutMs: options.timeoutMs,
  }, options.timeoutMs + 10_000);

  const sessionSlug = sessionSlugFromUrl(result.url, options.session);
  const messageDir = await nextMessageDir(sessionSlug);
  await copyIfExists(pendingAttachments, path.join(messageDir, 'attachments'));
  await copyIfExists(pendingFiles, path.join(messageDir, 'files'));
  const finalFilesDir = path.join(messageDir, 'files');
  const finalDownloads = (result.downloads || []).map((download) => path.join(finalFilesDir, path.basename(download)));
  const extractedFiles = await extractDownloadedArchives(finalFilesDir);
  await writeMessageArtifacts(messageDir, {
    prompt: options.prompt,
    answer: result.answer || result.latestVisibleAnswer || '',
    reasoning: result.reasoning || '',
    links: result.links || [],
    meta: {
      command: 'ask',
      requestedSession: options.session,
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
      extractedFiles,
      browserMode: runtime.mode,
    },
  });
  await fs.rm(pendingDir, { recursive: true, force: true });

  console.log([
    'OK',
    `answer: ${path.join(messageDir, 'answer.md')}`,
    `files: ${finalFilesDir}`,
    `project: ${options.project}`,
    `elapsed: ${formatDuration(result.elapsedMs)}`,
    `url: ${result.url}`,
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
