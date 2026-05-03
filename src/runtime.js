import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from './config.js';
import { ensureDir, pathExists, readJson } from './fsx.js';

const START_TIMEOUT_MS = 45_000;

export function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readRuntime() {
  try {
    return await readJson(paths().runtimeFile);
  } catch {
    return null;
  }
}

export async function cleanupStaleRuntime() {
  const runtime = await readRuntime();
  if (!runtime) return { cleaned: false, reason: 'no runtime file' };
  if (pidAlive(runtime.pid)) return { cleaned: false, reason: 'keeper is alive' };
  await fsp.rm(paths().runtimeFile, { force: true });
  return { cleaned: true, reason: 'removed dead keeper runtime file' };
}

export async function keeperRequest(runtime, endpoint, body = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${endpoint}`, {
      method: endpoint === '/health' ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${runtime.token}`,
        'content-type': 'application/json',
      },
      body: endpoint === '/health' ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok || value.ok === false) {
      throw new Error(value.error || `keeper ${endpoint} failed with HTTP ${response.status}`);
    }
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function health(runtime) {
  if (!runtime || !pidAlive(runtime.pid)) return null;
  try {
    return await keeperRequest(runtime, '/health', {}, 3000);
  } catch {
    return null;
  }
}

async function waitForKeeper(expectedToken) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runtime = await readRuntime();
    if (runtime?.token === expectedToken && pidAlive(runtime.pid)) {
      const healthy = await health(runtime);
      if (healthy) return runtime;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out starting keeper. Check ${paths().logFile}`);
}

export async function stopKeeper() {
  const runtime = await readRuntime();
  if (!runtime) return { stopped: false, reason: 'no runtime file' };
  if (pidAlive(runtime.pid)) {
    try {
      await keeperRequest(runtime, '/stop', {}, 5000);
    } catch {
      process.kill(runtime.pid, 'SIGTERM');
    }
  }
  const deadline = Date.now() + 5000;
  while (pidAlive(runtime.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await fsp.rm(paths().runtimeFile, { force: true });
  return { stopped: true, reason: 'keeper stopped' };
}

export async function ensureKeeper({ mode } = {}) {
  await ensureDir(paths().runtimeDir);
  await cleanupStaleRuntime();
  const desiredMode = mode || 'headed';
  const current = await readRuntime();
  const currentHealth = await health(current);
  if (currentHealth && current.mode === desiredMode) return current;
  if (currentHealth && current.mode !== desiredMode) {
    await stopKeeper();
  }

  const token = crypto.randomBytes(24).toString('hex');
  const logFd = fs.openSync(paths().logFile, 'a');
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'keeper.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      GPT_PRO_KEEPER_TOKEN: token,
      GPT_PRO_KEEPER_MODE: desiredMode,
    },
  });
  fs.closeSync(logFd);
  child.unref();
  return waitForKeeper(token);
}

export async function runtimeStatus() {
  const runtime = await readRuntime();
  const alive = runtime ? pidAlive(runtime.pid) : false;
  const healthy = alive ? await health(runtime) : null;
  return {
    runtime,
    alive,
    healthy,
    runtimeFileExists: await pathExists(paths().runtimeFile),
  };
}
