#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { chromeLaunchArgs } from './browser-launch.js';
import { PACKAGE_VERSION, paths, settings } from './config.js';
import { ensureDir, pathExists, writeJson } from './fsx.js';
import { cleanupProfileProcesses } from './runtime.js';
import { downloadAnswerArtifacts } from './downloads.js';
import {
  downloadTarget,
  assistantMessageCount,
  cleanupGitHubRepositorySelections,
  extractLatestAnswer,
  extractVisibleReasoning,
  openOrCreateProject,
  scrapeSessions,
  submitPrompt,
  waitForAnswerStable,
  waitForLoggedIn,
} from './chatgpt.js';

const mode = ['headed', 'headless', 'background'].includes(process.env.GPT_PRO_KEEPER_MODE)
  ? process.env.GPT_PRO_KEEPER_MODE
  : 'background';
const token = process.env.GPT_PRO_KEEPER_TOKEN;

if (!token) {
  console.error('GPT_PRO_KEEPER_TOKEN is required');
  process.exit(2);
}

const rootPaths = paths();
const appSettings = settings();
let context;
let browser;
let chromeProcess;
let activePage;
let idleTimer;
let server;
let browserQueue = Promise.resolve();
let browserQueueDepth = 0;
const reservedDownloadTargets = new Set();

async function runBrowserTask(task) {
  browserQueueDepth += 1;
  const previous = browserQueue;
  let release;
  browserQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    browserQueueDepth = Math.max(0, browserQueueDepth - 1);
    touchIdle();
    release();
  }
}

function processAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function browserBackingAlive() {
  if (!context) return false;
  try {
    context.pages();
  } catch {
    return false;
  }
  return Boolean(chromeProcess?.pid && processAlive(chromeProcess.pid));
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForCdp(port, { launchFailure = () => null } = {}) {
  const deadline = Date.now() + 45_000;
  let lastError = null;
  while (Date.now() < deadline) {
    const failure = launchFailure();
    if (failure) throw failure;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Chrome DevTools port ${port}${lastError ? `: ${lastError.message}` : ''}`);
}

async function launchChromeWithCdp() {
  await ensureDir(rootPaths.profileDir);
  await ensureDir(rootPaths.runtimeDir);
  const chromePath = process.env.GPT_PRO_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await cleanupProfileProcesses(rootPaths.profileDir);
    const port = await freePort();
    let launchError = null;
    chromeProcess = spawn(chromePath, chromeLaunchArgs({
      port,
      profileDir: rootPaths.profileDir,
      mode,
      baseUrl: appSettings.baseUrl,
    }), { stdio: 'ignore' });
    chromeProcess.once('error', (error) => {
      launchError = new Error(`Chrome failed to launch at ${chromePath}: ${error.message}`);
    });
    chromeProcess.once('exit', (code, signal) => {
      launchError ||= new Error(`Chrome exited before DevTools port ${port} became reachable (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
      chromeProcess = null;
    });

    try {
      await waitForCdp(port, { launchFailure: () => launchError });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      context = browser.contexts()[0];
      if (!context) throw new Error('Chrome DevTools connection did not expose a browser context');
      return;
    } catch (error) {
      lastError = error;
      if (chromeProcess?.pid) {
        chromeProcess.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (chromeProcess?.pid) chromeProcess.kill('SIGKILL');
      }
      chromeProcess = null;
      context = null;
      browser = null;
      await cleanupProfileProcesses(rootPaths.profileDir);
    }
  }

  throw lastError || new Error('Chrome did not start');
}

async function browserPage() {
  if (context && !browserBackingAlive()) {
    activePage = null;
    await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    context = null;
    browser = null;
    chromeProcess = null;
    await cleanupProfileProcesses(rootPaths.profileDir);
  }
  if (!context) {
    await launchChromeWithCdp();
  }
  if (activePage && !activePage.isClosed()) {
    await activePage.setViewportSize({ width: 1440, height: 1000 }).catch(() => {});
    return activePage;
  }
  activePage = context.pages()[0] || await context.newPage();
  await activePage.setViewportSize({ width: 1440, height: 1000 }).catch(() => {});
  return activePage;
}

async function uniqueBrowserDownloadTarget(downloadDir, suggestedFilename) {
  const initial = downloadTarget(downloadDir, suggestedFilename);
  const parsed = path.parse(initial);
  let target = initial;
  let suffix = 2;
  while (reservedDownloadTargets.has(target) || await pathExists(target)) {
    target = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }
  reservedDownloadTargets.add(target);
  return target;
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function authorize(req) {
  return req.headers.authorization === `Bearer ${token}`;
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    shutdown(0).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }, appSettings.idleMs);
}

async function shutdown(exitCode = 0) {
  if (idleTimer) clearTimeout(idleTimer);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (context) {
    await context.close().catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
  }
  if (chromeProcess) {
    chromeProcess.kill('SIGTERM');
  }
  await fs.rm(rootPaths.runtimeFile, { force: true }).catch(() => {});
  process.exit(exitCode);
}

async function handle(req, res) {
  try {
    if (!authorize(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    touchIdle();

    if (req.method === 'GET' && req.url === '/health') {
      const browserAlive = browserBackingAlive();
      return json(res, browserAlive ? 200 : 503, {
        ok: browserAlive,
        error: browserAlive ? undefined : 'browser backing process is not reachable',
        pid: process.pid,
        mode,
        profileDir: rootPaths.profileDir,
        browserPid: chromeProcess?.pid || null,
        browserAlive,
        queueDepth: browserQueueDepth,
      });
    }

    if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' });
    const body = await readBody(req);

    if (req.url === '/stop') {
      json(res, 200, { ok: true });
      setImmediate(() => shutdown(0));
      return;
    }

    if (req.url === '/login' || req.url === '/sessions' || req.url === '/ask') {
      return await runBrowserTask(async () => {
        const page = await browserPage();

        if (req.url === '/login') {
          await page.goto(appSettings.baseUrl, { waitUntil: 'domcontentloaded' });
          await waitForLoggedIn(page, body.timeoutMs || appSettings.operationTimeoutMs);
          return json(res, 200, { ok: true, url: page.url() });
        }

        if (req.url === '/sessions') {
          await page.goto(appSettings.baseUrl, { waitUntil: 'domcontentloaded' });
          await waitForLoggedIn(page, body.timeoutMs || 60_000, { failFastUnauth: true });
          const project = body.projectName
            ? await openOrCreateProject(page, {
              projectName: body.projectName,
              baseUrl: appSettings.baseUrl,
              timeoutMs: body.timeoutMs || 60_000,
              projectUrlHint: body.projectUrlHint || '',
            })
            : null;
          return json(res, 200, {
            ok: true,
            sessions: await scrapeSessions(page, project?.projectUrl),
            url: page.url(),
            project,
          });
        }

        const startedAt = Date.now();
        const downloads = [];
        const downloadSaves = [];
        if (body.downloadDir) await ensureDir(body.downloadDir);
        const onDownload = async (download) => {
          const target = await uniqueBrowserDownloadTarget(body.downloadDir || rootPaths.runtimeDir, download.suggestedFilename());
          const save = download.saveAs(target)
            .then(() => downloads.push(target))
            .finally(() => reservedDownloadTargets.delete(target));
          downloadSaves.push(save);
          await save;
        };
        page.on('download', onDownload);

        try {
          let project = null;
          if (body.session && /^https?:\/\//.test(body.session)) {
            await page.goto(body.session, { waitUntil: 'domcontentloaded' });
          } else if (body.projectName) {
            project = await openOrCreateProject(page, {
              projectName: body.projectName,
              baseUrl: appSettings.baseUrl,
              timeoutMs: body.timeoutMs || 60_000,
              keepCurrent: body.session === 'current',
              projectUrlHint: body.projectUrlHint || '',
            });
          } else if (body.session !== 'current') {
            await page.goto(appSettings.baseUrl, { waitUntil: 'domcontentloaded' });
          }
          await waitForLoggedIn(page, body.timeoutMs || 60_000, { failFastUnauth: true });
          const previousAnswer = await extractLatestAnswer(page).catch(() => '');
          const previousAssistantCount = await assistantMessageCount(page).catch(() => 0);
          const promptSubmission = await submitPrompt(page, {
            prompt: body.prompt,
            attachmentPath: body.attachmentPath,
            githubRepositories: body.githubRepositories || [],
          });
          let githubConnector = promptSubmission.githubConnector;
          let answer;
          let reasoning;
          let answerDownloads;
          try {
            answer = await waitForAnswerStable(page, body.timeoutMs || appSettings.operationTimeoutMs, {
              prompt: body.prompt,
              previousAnswer,
              previousAssistantCount,
            });
            await Promise.allSettled(downloadSaves);
            reasoning = await extractVisibleReasoning(page);
            answerDownloads = body.downloadDir
              ? await downloadAnswerArtifacts(page, {
                prompt: body.prompt,
                downloadDir: body.downloadDir,
                timeoutMs: appSettings.downloadTimeoutMs,
                maxBytes: appSettings.maxDownloadBytes,
              })
              : { links: [], downloads: [], errors: [] };
          } finally {
            githubConnector = await cleanupGitHubRepositorySelections(page, githubConnector).catch((error) => ({
              ...githubConnector,
              cleanup: {
                attempted: true,
                status: 'warn',
                cleaned: [],
                skipped: githubConnector?.cleanup?.skipped || [],
                errors: [{ error: error.message }],
              },
            }));
          }
          return json(res, 200, {
            ok: true,
            answer,
            reasoning,
            links: answerDownloads.links.map((link) => link.url),
            downloads,
            linkDownloads: answerDownloads.downloads,
            downloadErrors: answerDownloads.errors,
            url: page.url(),
            project,
            githubConnector,
            elapsedMs: Date.now() - startedAt,
            title: await page.title().catch(() => ''),
            latestVisibleAnswer: await extractLatestAnswer(page).catch(() => answer),
          });
        } finally {
          page.off('download', onDownload);
        }
      });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: error.message });
  }
}

async function main() {
  await ensureDir(rootPaths.runtimeDir);
  await browserPage();
  server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await writeJson(rootPaths.runtimeFile, {
    pid: process.pid,
    port,
    token,
    mode,
    version: PACKAGE_VERSION,
    startedAt: new Date().toISOString(),
    profileDir: rootPaths.profileDir,
    logFile: rootPaths.logFile,
  });
  touchIdle();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
