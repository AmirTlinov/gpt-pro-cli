import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanupProfileProcesses } from '../src/runtime.js';

const execFile = promisify(execFileCallback);

async function profileProcessLines(profileDir) {
  const { stdout } = await execFile('ps', ['-axo', 'pid=,command=']);
  return stdout
    .split('\n')
    .filter((line) => line.includes(`--user-data-dir=${profileDir}`));
}

async function waitForProfileProcess(profileDir) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const lines = await profileProcessLines(profileDir);
    if (lines.length > 0) return lines;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('fake profile process did not appear in ps output');
}

test('cleanupProfileProcesses waits until Chrome-profile processes have really drained', async () => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-profile-drain-'));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-fake-chrome-'));
  const fakeChrome = path.join(binDir, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
  await fs.mkdir(path.dirname(fakeChrome), { recursive: true });
  await fs.writeFile(fakeChrome, [
    '#!/bin/bash',
    'trap "sleep 1; exit 0" TERM',
    'while :; do sleep 1; done',
    '',
  ].join('\n'), { mode: 0o755 });
  const child = spawn(fakeChrome, [`--user-data-dir=${profileDir}`], { stdio: 'ignore' });

  try {
    await waitForProfileProcess(profileDir);
    const killed = await cleanupProfileProcesses(profileDir);
    assert.ok(killed >= 1);
    assert.deepEqual(await profileProcessLines(profileDir), []);
  } finally {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // The cleanup path is expected to stop it first.
    }
  }
});
