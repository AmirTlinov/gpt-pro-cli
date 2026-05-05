import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { PACKAGE_VERSION, paths } from './config.js';
import { ensureDir, pathExists, readJson } from './fsx.js';

const START_TIMEOUT_MS = 45_000;
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_STALE_MS = 90_000;
const LOCK_WRITE_GRACE_MS = 5_000;
const execFile = promisify(execFileCallback);

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


function lockFilePath() {
  return path.join(paths().runtimeDir, 'keeper.lock');
}

async function readLock(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function lockIsStale(file) {
  const lock = await readLock(file);
  if (!lock) {
    const stat = await fsp.stat(file).catch(() => null);
    return stat ? Date.now() - stat.mtimeMs > LOCK_WRITE_GRACE_MS : true;
  }
  if (!pidAlive(lock.pid)) return true;
  const createdAt = Date.parse(lock.createdAt || '');
  return Number.isFinite(createdAt) && Date.now() - createdAt > LOCK_STALE_MS;
}

async function acquireRuntimeLock() {
  await ensureDir(paths().runtimeDir);
  const file = lockFilePath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let handle;
    try {
      handle = await fsp.open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }));
      return async () => {
        await handle?.close().catch(() => {});
        await fsp.rm(file, { force: true }).catch(() => {});
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
      if (await lockIsStale(file)) {
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const lock = await readLock(file);
  throw new Error(`Timed out waiting for keeper startup lock${lock?.pid ? ` held by pid=${lock.pid}` : ''}`);
}

async function withRuntimeLock(task) {
  const release = await acquireRuntimeLock();
  try {
    return await task();
  } finally {
    await release();
  }
}
export async function cleanupStaleRuntime() {
  const runtime = await readRuntime();
  if (!runtime) return { cleaned: false, reason: 'no runtime file' };
  if (pidAlive(runtime.pid)) return { cleaned: false, reason: 'keeper is alive' };
  const killedProfileProcesses = await cleanupProfileProcesses(runtime.profileDir || paths().profileDir);
  await fsp.rm(paths().runtimeFile, { force: true });
  const suffix = killedProfileProcesses > 0 ? ` and ${killedProfileProcesses} stale browser profile process(es)` : '';
  return { cleaned: true, reason: `removed dead keeper runtime file${suffix}` };
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

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !pidAlive(pid);
}

async function terminatePid(pid) {
  if (!pidAlive(pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  if (await waitForPidExit(pid, 3000)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return false;
  }
  await waitForPidExit(pid, 2000);
  return true;
}

async function profileProcessPids(profileDir) {
  const profileArg = `--user-data-dir=${path.resolve(profileDir)}`;
  const browserProcessPattern = /(Google Chrome|Chromium|chrome|chromium)( Helper| Framework|\\.app|$)/i;
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 1024 * 1024 });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        return match ? { pid: Number.parseInt(match[1], 10), command: match[2] } : null;
      })
      .filter((entry) => entry && entry.command.includes(profileArg) && browserProcessPattern.test(entry.command))
      .map((entry) => entry.pid)
      .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

async function cleanupProfileProcesses(profileDir) {
  const killed = new Set();
  for (let round = 0; round < 5; round += 1) {
    const pids = await profileProcessPids(profileDir);
    if (pids.length === 0) break;
    for (const pid of pids) {
      killed.add(pid);
      await terminatePid(pid);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return killed.size;
}

async function stopKeeperUnlocked() {
  const runtime = await readRuntime();
  if (!runtime) {
    const killedProfileProcesses = await cleanupProfileProcesses(paths().profileDir);
    if (killedProfileProcesses > 0) {
      return { stopped: true, reason: `removed stale browser profile process(es): ${killedProfileProcesses}` };
    }
    return { stopped: false, reason: 'no runtime file' };
  }
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
  if (pidAlive(runtime.pid)) {
    await terminatePid(runtime.pid);
  }
  const killedProfileProcesses = await cleanupProfileProcesses(runtime.profileDir || paths().profileDir);
  await fsp.rm(paths().runtimeFile, { force: true });
  const suffix = killedProfileProcesses > 0 ? `; removed stale browser profile process(es): ${killedProfileProcesses}` : '';
  return { stopped: true, reason: `keeper stopped${suffix}` };
}

export async function stopKeeper(options = {}) {
  if (options.lock === false) return stopKeeperUnlocked();
  return withRuntimeLock(() => stopKeeperUnlocked());
}

async function ensureKeeperUnlocked({ mode } = {}) {
  await ensureDir(paths().runtimeDir);
  await cleanupStaleRuntime();
  const desiredMode = mode || 'background';
  const current = await readRuntime();
  const currentHealth = await health(current);
  const currentCompatible = current?.mode === desiredMode && current?.version === PACKAGE_VERSION;
  if (currentHealth && currentCompatible) return current;
  if (currentHealth && !currentCompatible) {
    await stopKeeper({ lock: false });
  }
  if (!currentHealth && current && pidAlive(current.pid)) {
    await stopKeeper({ lock: false });
  } else if (!currentHealth) {
    await cleanupProfileProcesses(paths().profileDir);
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

export async function ensureKeeper({ mode } = {}) {
  return withRuntimeLock(() => ensureKeeperUnlocked({ mode }));
}

export async function runtimeStatus() {
  const runtime = await readRuntime();
  const alive = runtime ? pidAlive(runtime.pid) : false;
  const healthy = alive ? await health(runtime) : null;
  return {
    runtime,
    alive,
    healthy,
    compatible: Boolean(runtime?.version === PACKAGE_VERSION),
    runtimeFileExists: await pathExists(paths().runtimeFile),
  };
}
