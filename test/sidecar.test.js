import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathExists } from '../src/fsx.js';

const sidecarPath = path.resolve('bin/gpt-pro-sidecar');

function runSidecar(args, { env, input = '', timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(sidecarPath, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`sidecar timed out: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function field(stdout, name) {
  return stdout.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1] || null;
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pathExists(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test('gpt-pro-sidecar start and flagship call fake gpt-pro quietly', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-sidecar-test-'));
  const fakeBin = path.join(temp, 'bin');
  const fakeDir = path.join(temp, 'fake');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.mkdir(fakeDir, { recursive: true });
  const fakeGptPro = path.join(fakeBin, 'gpt-pro');
  await fs.writeFile(fakeGptPro, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const fakeDir = process.env.GPT_PRO_FAKE_DIR;
let session = '';
let project = '';
let timeout = '';
let prompt = '';
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--session') session = args[++index];
  else if (arg === '--project') project = args[++index];
  else if (arg === '--timeout') timeout = args[++index];
  else if (arg === '--') {
    prompt = args.slice(index + 1).join(' ');
    break;
  }
}
fs.mkdirSync(fakeDir, { recursive: true });
const countFile = path.join(fakeDir, 'count');
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;
fs.writeFileSync(countFile, String(count));
const answerPath = path.join(fakeDir, 'answer-' + count + '.md');
fs.writeFileSync(answerPath, session === 'new' ? 'FIRST PASS CONTENT' : 'FLAGSHIP CONTENT');
fs.appendFileSync(path.join(fakeDir, 'calls.jsonl'), JSON.stringify({ args, session, project, timeout, prompt, answerPath }) + '\\n');
console.log('OK');
console.log('answer: ' + answerPath);
console.log('url: https://chatgpt.com/c/fake-' + count);
`, { mode: 0o755 });

  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GPT_PRO_FAKE_DIR: fakeDir,
    GPT_PRO_SIDECAR_DIR: path.join(temp, 'runs'),
  };

  const started = await runSidecar([
    'start',
    '--label',
    'Quality Probe',
    '--project',
    'WORK_PROJECT',
    '--timeout',
    '123',
  ], { env, input: 'Initial prompt' });
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /^OK/m);
  const runDir = field(started.stdout, 'run');
  assert.ok(runDir);
  await waitForFile(path.join(runDir, 'exit_code'));
  assert.equal((await fs.readFile(path.join(runDir, 'exit_code'), 'utf8')).trim(), '0');

  const flagship = await runSidecar([
    'flagship',
    runDir,
    '--project',
    'WORK_PROJECT',
    '--timeout',
    '456',
  ], { env, input: 'Extra pressure from Codex' });
  assert.equal(flagship.code, 0, flagship.stderr);
  assert.match(flagship.stdout, /^DONE/m);

  const calls = (await fs.readFile(path.join(fakeDir, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].session, 'new');
  assert.equal(calls[0].project, 'WORK_PROJECT');
  assert.equal(calls[0].timeout, '123');
  assert.equal(calls[0].prompt, 'Initial prompt');
  assert.equal(calls[1].session, 'https://chatgpt.com/c/fake-1');
  assert.equal(calls[1].project, 'WORK_PROJECT');
  assert.equal(calls[1].timeout, '456');
  assert.match(calls[1].prompt, /FIRST PASS CONTENT/);
  assert.match(calls[1].prompt, /Extra pressure from Codex/);

  const noPathFakeDir = path.join(temp, 'fake-no-path');
  await fs.mkdir(noPathFakeDir, { recursive: true });
  const noPathEnv = {
    ...process.env,
    PATH: '',
    GPT_PRO_BIN: fakeGptPro,
    GPT_PRO_FAKE_DIR: noPathFakeDir,
    GPT_PRO_SIDECAR_DIR: path.join(temp, 'runs-no-path'),
  };
  const noPathStarted = await runSidecar([
    'start',
    '--label',
    'No Path Probe',
  ], { env: noPathEnv, input: 'No path prompt' });
  assert.equal(noPathStarted.code, 0, noPathStarted.stderr);
  const noPathRunDir = field(noPathStarted.stdout, 'run');
  assert.ok(noPathRunDir);
  await waitForFile(path.join(noPathRunDir, 'exit_code'));
  assert.equal((await fs.readFile(path.join(noPathRunDir, 'exit_code'), 'utf8')).trim(), '0');
  const noPathCalls = (await fs.readFile(path.join(noPathFakeDir, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(noPathCalls[0].prompt, 'No path prompt');
});
