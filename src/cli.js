#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { PACKAGE_VERSION, paths, settings } from './config.js';
import { githubRepoValues, resolveGitHubRepositories } from './github.js';
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
  readRuntime,
  runtimeStatus,
  stopKeeper,
} from './runtime.js';

function usage() {
  return `gpt-pro

Commands:
  gpt-pro --version
  gpt-pro doctor
  gpt-pro status
  gpt-pro login
  gpt-pro sessions [--project CLI_QUESTIONS]
  gpt-pro ask [--session new|current|<url>] [--project CLI_QUESTIONS] [--github-repo owner/repo|auto] [--attach <zip-or-dir>] [--timeout <ms>] -- <prompt>
  gpt-pro smoke [--timeout <ms>]
  gpt-pro archive [--session all|latest|<index|id>] [--project CLI_QUESTIONS] [--delete-local]
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactLine(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function formatBackgroundWindowLine(backgroundWindow) {
  if (!backgroundWindow) return '';
  const bounds = backgroundWindow.bounds || {};
  const state = backgroundWindow.parked
    ? 'parked'
    : backgroundWindow.attempted
      ? 'not-parked'
      : 'not-attempted';
  const parts = [
    state,
    `attempted=${Boolean(backgroundWindow.attempted)}`,
    `no-startup-window=${Boolean(backgroundWindow.noStartupWindow)}`,
    `strict=${Boolean(backgroundWindow.strict)}`,
  ];
  if (backgroundWindow.windowId !== null && backgroundWindow.windowId !== undefined) parts.push(`window-id=${backgroundWindow.windowId}`);
  if (bounds.windowState) parts.push(`state=${bounds.windowState}`);
  if (bounds.left !== null && bounds.left !== undefined) parts.push(`left=${bounds.left}`);
  if (bounds.top !== null && bounds.top !== undefined) parts.push(`top=${bounds.top}`);
  if (backgroundWindow.error) parts.push(`error=${compactLine(backgroundWindow.error, 140)}`);
  return `background-window: ${parts.join(' ')}`;
}

function resolvePath(value) {
  if (!value) return null;
  return path.resolve(process.cwd(), value);
}

function defaultGitHubRepositories() {
  return [
    process.env.GPT_PRO_GITHUB_REPO || '',
    process.env.GPT_PRO_GITHUB_REPOS || '',
  ];
}

function githubGroundedPrompt(prompt, repositories = []) {
  if (!repositories.length) return prompt;
  const repoLines = repositories.map((repository) => `- ${repository}`).join('\n');
  return [
    'Repository grounding requirement:',
    'Use the ChatGPT GitHub connector for these repositories before making repo-specific claims:',
    repoLines,
    '',
    'If the GitHub connector is unavailable, not selected, not indexed, or cannot access one of these repositories, say that explicitly first instead of guessing from memory. Cite concrete files, paths, symbols, commits, or PRs from the GitHub connector when you make repository-specific claims.',
    '',
    'Question:',
    prompt,
  ].join('\n');
}

function parseAskArgs(argv) {
  const options = {
    session: 'new',
    project: settings().projectName,
    attach: null,
    timeoutMs: settings().operationTimeoutMs,
    githubRepositories: defaultGitHubRepositories(),
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
    if (arg === '--github-repo') {
      options.githubRepositories.push(...githubRepoValues(argv[++index]));
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
  return { ...options, prompt, githubRepositories: resolveGitHubRepositories(options.githubRepositories) };
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
    deleteLocal: false,
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
    if (arg === '--delete-local') {
      options.deleteLocal = true;
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

async function writeFailureArtifacts({
  pendingAttachments,
  pendingFiles,
  pendingId,
  sentPrompt,
  options,
  githubRepositories,
  error,
}) {
  const messageDir = await nextMessageDir(`failed-${pendingId}`);
  await copyIfExists(pendingAttachments, path.join(messageDir, 'attachments'));
  await copyIfExists(pendingFiles, path.join(messageDir, 'files'));
  const artifactReceipt = await writeMessageArtifacts(messageDir, {
    prompt: sentPrompt,
    answer: '',
    downloads: [],
    meta: {
      command: 'ask',
      failed: true,
      error: error.message,
      requestedSession: options.session,
      requestedProject: options.project,
      originalPrompt: options.prompt,
      githubRepositories,
      sessionUrl: null,
      completedAt: new Date().toISOString(),
    },
  });
  return {
    messageDir,
    receiptPath: artifactReceipt.path,
  };
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
  const existingCache = await readSessionCache(project);
  const runtime = await ensureKeeper({ mode: settings().browserMode });
  const result = await keeperRequest(runtime, '/sessions', {
    timeoutMs: 60_000,
    projectName: project,
    projectUrlHint: existingCache?.projectUrl || '',
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

function projectProofSource(resolvedSession, result) {
  if (result.project?.projectUrl) return 'project-ui';
  if (resolvedSession.resolved?.url) return 'project-session-cache';
  return '';
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

  const keeperLine = status.healthy
    ? status.compatible
      ? `${status.runtime.mode} pid=${status.runtime.pid} version=${status.runtime.version || 'unknown'}`
      : `stale pid=${status.runtime.pid} version=${status.runtime.version || 'unknown'}`
    : status.alive
      ? `unhealthy pid=${status.runtime.pid} version=${status.runtime?.version || 'unknown'}`
      : 'stopped';

  const lines = [
    'OK',
    `home: ${rootPaths.root}`,
    `profile: ${rootPaths.profileDir}`,
    `runtime: ${rootPaths.runtimeDir}`,
    `archives: ${rootPaths.archivesDir}`,
    `chatgpt: ${settings().baseUrl}`,
    `project: ${settings().projectName}`,
    `browser-mode: ${settings().browserMode}`,
    `background-window: no-startup-window=${settings().macosNoStartupWindow ? 'on' : 'off'} strict=${settings().strictBackground ? 'on' : 'off'}`,
    `version: ${PACKAGE_VERSION}`,
    `chrome: ${chromeFound ? chromeApp : 'not found at /Applications/Google Chrome.app'}`,
    `keeper: ${keeperLine}`,
  ];
  if (cleanup.cleaned) lines.push(`cleanup: ${cleanup.reason}`);
  if (!chromeFound) lines[0] = 'WARN';
  console.log(lines.join('\n'));
}

function formatKeeperStatus(status) {
  const task = status.task || null;
  const page = status.page || null;
  const lines = [
    'OK',
    `keeper: ${status.browserAlive ? `${status.mode} pid=${status.pid} browser=${status.browserPid || ''}` : 'unhealthy'}`,
    `queue-depth: ${status.queueDepth ?? 0}`,
  ];
  const backgroundLine = formatBackgroundWindowLine(status.backgroundWindow);
  if (backgroundLine) lines.push(backgroundLine);
  if (task) {
    const elapsedMs = task.startedAt ? Date.now() - Date.parse(task.startedAt) : null;
    lines.push(`task: ${task.command || 'unknown'} ${task.phase || task.state || 'running'}${elapsedMs ? ` elapsed=${formatDuration(elapsedMs)}` : ''}`);
    if (Array.isArray(task.githubRepositories) && task.githubRepositories.length > 0) {
      lines.push(`github: ${task.githubRepositories.join(', ')}`);
    }
  } else {
    lines.push('task: none');
  }
  if (page?.blocker) lines.push(`blocker: ${page.blocker.code} ${compactLine(page.blocker.message, 220)}`);
  if (page?.auth) {
    const authState = page.auth.loggedIn
      ? 'logged-in'
      : page.auth.hasUnauthAction
        ? 'needs-login'
        : 'unknown';
    lines.push(`auth: ${authState} composer=${Boolean(page.auth.hasComposer)} actions=${(page.auth.unauthActions || []).join(', ') || 'none'}${page.auth.title && authState !== 'logged-in' ? ` title=${compactLine(page.auth.title, 80)}` : ''}`);
  }
  if (typeof page?.generating === 'boolean') lines.push(`generating: ${page.generating}`);
  if (page?.reasoningPreview) lines.push(`thinking: ${compactLine(page.reasoningPreview, 300)}`);
  if (page?.answerPreview) lines.push(`answer-preview: ${compactLine(page.answerPreview, 300)}`);
  if (page?.url) lines.push(`url: ${page.url}`);
  if (page?.error) lines.push(`status-error: ${page.error}`);
  return lines.join('\n');
}

function formatProgressLine(status) {
  const task = status.task || {};
  const page = status.page || {};
  if (!task.phase && !page.reasoningPreview && !page.blocker) return '';
  const elapsedMs = task.startedAt ? Date.now() - Date.parse(task.startedAt) : 0;
  const parts = [
    `phase=${task.phase || task.state || 'running'}`,
    `elapsed=${formatDuration(elapsedMs)}`,
  ];
  if (typeof page.generating === 'boolean') parts.push(`generating=${page.generating}`);
  if (page.blocker?.code) parts.push(`blocker=${page.blocker.code}`);
  if (page.auth && !page.auth.loggedIn) {
    const authState = page.auth.hasUnauthAction ? 'needs-login' : 'unknown';
    parts.push(`auth=${authState}`);
  }
  const thought = page.reasoningPreview || page.answerPreview || '';
  if (thought) parts.push(`thinking="${compactLine(thought, 180).replace(/"/g, "'")}"`);
  if (page.url) parts.push(`url=${page.url}`);
  return `status: ${parts.join(' ')}`;
}

function progressSignature(status) {
  const task = status.task || {};
  const page = status.page || {};
  if (!task.phase && !page.reasoningPreview && !page.blocker) return '';
  const thought = page.reasoningPreview || page.answerPreview || '';
  return JSON.stringify({
    phase: task.phase || task.state || 'running',
    generating: typeof page.generating === 'boolean' ? page.generating : null,
    blocker: page.blocker?.code || null,
    auth: page.auth?.loggedIn
      ? 'logged-in'
      : page.auth?.hasUnauthAction
        ? 'needs-login'
        : page.auth
          ? 'unknown'
          : null,
    thought: compactLine(thought, 180),
    url: page.url || null,
  });
}

function askHttpTimeoutMs(options, preflightStatus = null) {
  const queuedOrRunning = Math.max(0, Number(preflightStatus?.queueDepth || 0));
  const perTaskBudgetMs = Math.max(settings().operationTimeoutMs, options.timeoutMs);
  return options.timeoutMs
    + settings().downloadTimeoutMs
    + 60_000
    + queuedOrRunning * (perTaskBudgetMs + settings().downloadTimeoutMs + 60_000);
}

function enrichKeeperTimeoutError(error, requestTimeoutMs, liveStatus = null) {
  if (error?.name !== 'AbortError') return error;
  const task = liveStatus?.task || null;
  const queueDepth = liveStatus?.queueDepth ?? 0;
  const state = task
    ? ` keeper still reports ${task.command || 'task'}:${task.phase || task.state || 'running'} queue-depth=${queueDepth}`
    : ` keeper status queue-depth=${queueDepth}`;
  const enriched = new Error(`Timed out waiting for the keeper HTTP response after ${formatDuration(requestTimeoutMs)};${state}. The browser task is bounded by its own ChatGPT timeout, so no answer was accepted without capture. Run "gpt-pro status" before retrying.`);
  enriched.name = 'KeeperTimeoutError';
  enriched.cause = error;
  return enriched;
}

async function reportProgressUntil(runtime, promise) {
  if (process.env.GPT_PRO_PROGRESS === '0') return;
  let settled = false;
  promise.finally(() => {
    settled = true;
  }).catch(() => {});
  let lastSignature = '';
  let lastPrintAt = 0;
  await sleep(1500);
  while (!settled) {
    const status = await keeperRequest(runtime, '/status', {}, 3000).catch(() => null);
    const line = status ? formatProgressLine(status) : '';
    const signature = status ? progressSignature(status) : '';
    const now = Date.now();
    if (line && (signature !== lastSignature || now - lastPrintAt > 30_000)) {
      process.stderr.write(`${line}\n`);
      lastSignature = signature;
      lastPrintAt = now;
    }
    await sleep(5000);
  }
}

async function status() {
  const runtime = await readRuntime();
  const runtimeState = await runtimeStatus();
  if (!runtime || !runtimeState.alive) {
    console.log('OK\nkeeper: stopped\ntask: none');
    return;
  }
  try {
    const live = await keeperRequest(runtime, '/status', {}, 5000);
    console.log(formatKeeperStatus(live));
  } catch (error) {
    console.log(`WARN\nkeeper: unhealthy pid=${runtime.pid} version=${runtime.version || 'unknown'}\nerror: ${error.message}`);
    process.exitCode = 10;
  }
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
  const githubRepositories = resolveGitHubRepositories(options.githubRepositories || []);
  const sentPrompt = githubGroundedPrompt(options.prompt, githubRepositories);
  const pendingId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const pendingDir = path.join(rootPaths.runtimeDir, 'pending', pendingId);
  const pendingAttachments = path.join(pendingDir, 'attachments');
  const pendingFiles = path.join(pendingDir, 'files');
  await ensureDir(pendingAttachments);
  await ensureDir(pendingFiles);
  try {
    await writeText(path.join(pendingDir, 'prompt.md'), sentPrompt);

    let attachmentPath = null;
    if (options.attach) {
      attachmentPath = await stageAttachment(options.attach, path.join(pendingAttachments, 'input.zip'));
    }

    const startedAt = new Date();
    const resolvedSession = await resolveSessionOption(options.session, options.project);
    const projectCache = await readSessionCache(options.project);
    const runtime = await ensureKeeper({ mode: settings().browserMode });
    const preflightStatus = await keeperRequest(runtime, '/status', {}, 5000).catch(() => null);
    const requestTimeoutMs = askHttpTimeoutMs(options, preflightStatus);
    const askPromise = keeperRequest(runtime, '/ask', {
      session: resolvedSession.session,
      projectName: options.project,
      projectUrlHint: projectCache?.projectUrl || '',
      prompt: sentPrompt,
      attachmentPath,
      githubRepositories,
      downloadDir: pendingFiles,
      timeoutMs: options.timeoutMs,
    }, requestTimeoutMs);
    let result;
    try {
      result = await Promise.race([
        askPromise,
        reportProgressUntil(runtime, askPromise).then(() => askPromise),
      ]);
    } catch (error) {
      const live = await keeperRequest(runtime, '/status', {}, 5000).catch(() => null);
      throw enrichKeeperTimeoutError(error, requestTimeoutMs, live);
    }

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
    const extractionErrors = [];
    let extractedFiles = [];
    try {
      extractedFiles = await extractDownloadedArchives(finalFilesDir);
    } catch (error) {
      extractionErrors.push({
        label: 'downloaded zip extraction',
        status: 'failed',
        error: error.message,
      });
    }
    const proofSource = projectProofSource(resolvedSession, result);
    const provenProject = proofSource ? options.project : null;
    const artifactReceipt = await writeMessageArtifacts(messageDir, {
      prompt: sentPrompt,
      answer: result.answer || result.latestVisibleAnswer || '',
      reasoning: result.reasoning || '',
      links: result.links || [],
      downloads: [
        ...browserOnlyDownloads,
        ...linkDownloads,
        ...(result.downloadErrors || []),
        ...extractionErrors,
      ],
      meta: {
        command: 'ask',
        requestedSession: options.session,
        resolvedSession: resolvedSession.resolved || null,
        project: provenProject,
        requestedProject: options.project,
        projectProofSource: proofSource || null,
        projectUrl: result.project?.projectUrl || null,
        projectCreated: result.project?.created || false,
        originalPrompt: options.prompt,
        githubRepositories,
        githubConnector: result.githubConnector || null,
        sessionUrl: result.url,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        elapsedMs: result.elapsedMs,
        elapsed: formatDuration(result.elapsedMs),
        attachment: attachmentPath ? path.join(messageDir, 'attachments', 'input.zip') : null,
        downloads: finalDownloads,
        linkDownloads,
        downloadErrors: result.downloadErrors || [],
        extractionErrors,
        extractedFiles,
        browserMode: runtime.mode,
      },
    });
    if (provenProject) {
      await upsertSessionCache(options.project, {
        title: options.prompt.split('\n').find(Boolean)?.trim().slice(0, 80) || 'Untitled',
        url: result.url,
      }, result.project?.projectUrl || null).catch(() => {});
    }

    return {
      answerPath: path.join(messageDir, 'answer.md'),
      filesDir: finalFilesDir,
      messageDir,
      receiptPath: artifactReceipt.path,
      receipt: artifactReceipt.receipt,
      githubRepositories,
      result,
      elapsed: formatDuration(result.elapsedMs),
    };
  } catch (error) {
    try {
      const failure = await writeFailureArtifacts({
        pendingAttachments,
        pendingFiles,
        pendingId,
        sentPrompt,
        options,
        githubRepositories,
        error,
      });
      error.message = `${error.message}\nfailure: ${failure.receiptPath}`;
    } catch {
      // Preserve the original failure if failure-artifact writing itself breaks.
    }
    throw error;
  } finally {
    await fs.rm(pendingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ask(argv) {
  const options = parseAskArgs(argv);
  const output = await runAsk(options);
  const status = output.receipt?.status === 'ok' ? 'OK' : 'WARN';
  console.log([
    status,
    `answer: ${output.answerPath}`,
    `files: ${output.filesDir}`,
    `receipt: ${output.receiptPath}`,
    `project: ${options.project}`,
    ...(output.githubRepositories.length ? [`github: ${output.githubRepositories.join(', ')}`] : []),
    `elapsed: ${output.elapsed}`,
    `warnings: ${output.receipt?.warnings?.length || 0}`,
    `url: ${output.result.url}`,
  ].join('\n'));
  if (status === 'WARN') process.exitCode = 10;
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
    if (!await pathExists(output.receiptPath)) {
      throw new Error('Smoke receipt.json was not saved');
    }
    if (output.receipt?.status !== 'ok') {
      throw new Error(`Smoke receipt was not clean: ${(output.receipt?.warnings || []).join('; ')}`);
    }
    console.log([
      'OK',
      `answer: ${output.answerPath}`,
      `files: ${output.filesDir}`,
      `receipt: ${output.receiptPath}`,
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
  let sessionRefreshFailed = false;
  try {
    ({ cache } = await refreshSessions(options.project));
  } catch (error) {
    sessionRefreshFailed = true;
    warnings.push(`session refresh failed: ${error.message}`);
    cache = await readSessionCache(options.project);
  }
  const sessionsList = Array.isArray(cache?.sessions) ? cache.sessions : [];
  const result = await archiveLocalChats({
    projectName: options.project,
    sessionRef: options.session,
    sessions: sessionsList,
    warnings,
    deleteLocal: options.deleteLocal,
    deleteLocalRequiresLocalProof: sessionRefreshFailed,
  });
  const status = result.manifest.warnings.length > 0 ? 'WARN' : 'OK';
  console.log([
    status,
    `archive: ${result.path}`,
    `project: ${options.project}`,
    `sessions: ${result.manifest.sessionsCount}`,
    `messages: ${result.manifest.messagesCount}`,
    `deleted-local: ${result.manifest.localDeletion.deletedSessions.length}`,
    `warnings: ${result.manifest.warnings.length}`,
    ...result.manifest.warnings.slice(0, 5).map((warning) => `warning: ${warning}`),
  ].join('\n'));
  if (status === 'WARN') process.exitCode = 10;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(PACKAGE_VERSION);
    return;
  }
  if (command === 'doctor') return doctor();
  if (command === 'status') return status();
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
