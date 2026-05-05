#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const self = fileURLToPath(import.meta.url);

function usage() {
  return `sidecar-worker

Internal helper for gpt-pro-sidecar.
`;
}

function exitCodeFromClose(code, signal) {
  if (Number.isInteger(code)) return code;
  if (!signal) return 1;
  return 128 + (osConstants.signals?.[signal] || 1);
}

async function append(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text);
}

async function runWorker(argv) {
  const [runDir, gptProBin, project, timeout, ...githubRepos] = argv;
  if (!runDir || !gptProBin || !project || !timeout) {
    throw new Error('missing worker arguments');
  }

  const stdoutPath = path.join(runDir, 'stdout.txt');
  const stderrPath = path.join(runDir, 'stderr.txt');
  const exitCodePath = path.join(runDir, 'exit_code');
  const finishedAtPath = path.join(runDir, 'finished_at');

  let code = 1;
  try {
    const prompt = await fs.readFile(path.join(runDir, 'prompt.md'), 'utf8');
    const args = ['ask', '--session', 'new', '--project', project, '--timeout', timeout];
    for (const repository of githubRepos.filter(Boolean)) {
      args.push('--github-repo', repository);
    }
    args.push('--', prompt);

    const stdout = await fs.open(stdoutPath, 'a');
    const stderr = await fs.open(stderrPath, 'a');
    try {
      const child = spawn(gptProBin, args, {
        env: process.env,
        stdio: ['ignore', stdout.fd, stderr.fd],
      });
      code = await new Promise((resolve) => {
        child.once('error', async (error) => {
          await append(stderrPath, `${error.stack || error.message}\n`).catch(() => {});
          resolve(127);
        });
        child.once('close', (closeCode, signal) => {
          resolve(exitCodeFromClose(closeCode, signal));
        });
      });
    } finally {
      await stdout.close().catch(() => {});
      await stderr.close().catch(() => {});
    }
  } catch (error) {
    code = code || 1;
    await append(stderrPath, `${error.stack || error.message}\n`).catch(() => {});
  } finally {
    await fs.writeFile(exitCodePath, `${code}\n`).catch(() => {});
    await fs.writeFile(finishedAtPath, `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\n`).catch(() => {});
  }
  process.exit(code);
}

function detach(argv) {
  const child = spawn(process.execPath, [self, '--run', ...argv], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  process.stdout.write(`${child.pid}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '--detach') {
    detach(rest);
    return;
  }
  if (command === '--run') {
    await runWorker(rest);
    return;
  }
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return;
  }
  throw new Error(`unknown sidecar-worker command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
