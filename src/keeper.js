#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { paths, settings } from './config.js';
import { ensureDir, writeJson } from './fsx.js';
import { downloadAnswerArtifacts } from './downloads.js';
import {
  downloadTarget,
  assistantMessageCount,
  extractLatestAnswer,
  extractVisibleReasoning,
  openOrCreateProject,
  scrapeSessions,
  submitPrompt,
  waitForAnswerStable,
  waitForLoggedIn,
} from './chatgpt.js';

const mode = process.env.GPT_PRO_KEEPER_MODE === 'headed' ? 'headed' : 'headless';
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

function browserLaunchOptions() {
  const options = {
    headless: mode !== 'headed',
    acceptDownloads: true,
    downloadsPath: path.join(rootPaths.runtimeDir, 'downloads'),
    args: ['--no-first-run', '--disable-dev-shm-usage'],
  };
  if (appSettings.browserChannel && appSettings.browserChannel !== 'chromium') {
    options.channel = appSettings.browserChannel;
  }
  return options;
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForCdp(port) {
  const deadline = Date.now() + 45_000;
  let lastError = null;
  while (Date.now() < deadline) {
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

async function launchHumanChrome() {
  await ensureDir(rootPaths.profileDir);
  await ensureDir(rootPaths.runtimeDir);
  const port = await freePort();
  const chromePath = process.env.GPT_PRO_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  chromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${rootPaths.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    appSettings.baseUrl,
  ], {
    stdio: 'ignore',
  });
  chromeProcess.once('exit', () => {
    chromeProcess = null;
  });
  await waitForCdp(port);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  context = browser.contexts()[0];
  if (!context) throw new Error('Chrome DevTools connection did not expose a browser context');
}

async function browserPage() {
  if (!context) {
    if (mode === 'headed') {
      await launchHumanChrome();
    } else {
      await ensureDir(rootPaths.profileDir);
      await ensureDir(rootPaths.runtimeDir);
      context = await chromium.launchPersistentContext(rootPaths.profileDir, browserLaunchOptions());
    }
  }
  if (activePage && !activePage.isClosed()) return activePage;
  activePage = context.pages()[0] || await context.newPage();
  await activePage.setViewportSize({ width: 1440, height: 1000 }).catch(() => {});
  return activePage;
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
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        mode,
        profileDir: rootPaths.profileDir,
      });
    }

    if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not found' });
    const body = await readBody(req);

    if (req.url === '/stop') {
      json(res, 200, { ok: true });
      setImmediate(() => shutdown(0));
      return;
    }

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
        })
        : null;
      return json(res, 200, {
        ok: true,
        sessions: await scrapeSessions(page, project?.projectUrl),
        url: page.url(),
        project,
      });
    }

    if (req.url === '/ask') {
      const startedAt = Date.now();
      const downloads = [];
      const downloadSaves = [];
      if (body.downloadDir) await ensureDir(body.downloadDir);
      const onDownload = async (download) => {
        const target = downloadTarget(body.downloadDir || rootPaths.runtimeDir, download.suggestedFilename());
        const save = download.saveAs(target).then(() => downloads.push(target));
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
          });
        } else if (body.session !== 'current') {
          await page.goto(appSettings.baseUrl, { waitUntil: 'domcontentloaded' });
        }
        await waitForLoggedIn(page, body.timeoutMs || 60_000, { failFastUnauth: true });
        const previousAnswer = await extractLatestAnswer(page).catch(() => '');
        const previousAssistantCount = await assistantMessageCount(page).catch(() => 0);
        await submitPrompt(page, { prompt: body.prompt, attachmentPath: body.attachmentPath });
        const answer = await waitForAnswerStable(page, body.timeoutMs || appSettings.operationTimeoutMs, {
          prompt: body.prompt,
          previousAnswer,
          previousAssistantCount,
        });
        await Promise.allSettled(downloadSaves);
        const reasoning = await extractVisibleReasoning(page);
        const answerDownloads = body.downloadDir
          ? await downloadAnswerArtifacts(page, {
            prompt: body.prompt,
            downloadDir: body.downloadDir,
            timeoutMs: appSettings.downloadTimeoutMs,
            maxBytes: appSettings.maxDownloadBytes,
          })
          : { links: [], downloads: [], errors: [] };
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
          elapsedMs: Date.now() - startedAt,
          title: await page.title().catch(() => ''),
          latestVisibleAnswer: await extractLatestAnswer(page).catch(() => answer),
        });
      } finally {
        page.off('download', onDownload);
      }
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
