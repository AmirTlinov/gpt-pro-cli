import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  discoverGitHubRepositoryFromGit,
  parseGitHubRepository,
  resolveGitHubRepositories,
} from '../src/github.js';

const execFile = promisify(execFileCallback);
const cliPath = path.resolve('src/cli.js');

async function initRepo(remotes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-github-auto-'));
  await execFile('git', ['init'], { cwd: dir });
  for (const [name, url] of remotes) {
    await execFile('git', ['remote', 'add', name, url], { cwd: dir });
  }
  return dir;
}

test('parseGitHubRepository accepts common GitHub remote forms', () => {
  assert.equal(parseGitHubRepository('https://github.com/AmirTlinov/gpt-pro-cli.git'), 'AmirTlinov/gpt-pro-cli');
  assert.equal(parseGitHubRepository('git@github.com:AmirTlinov/gpt-pro-cli.git'), 'AmirTlinov/gpt-pro-cli');
  assert.equal(parseGitHubRepository('ssh://git@github.com/AmirTlinov/gpt-pro-cli.git'), 'AmirTlinov/gpt-pro-cli');
  assert.equal(parseGitHubRepository('git+https://github.com/AmirTlinov/gpt-pro-cli.git'), 'AmirTlinov/gpt-pro-cli');
  assert.equal(parseGitHubRepository('https://gitlab.com/AmirTlinov/gpt-pro-cli.git'), null);
  assert.equal(parseGitHubRepository('https://github.com/AmirTlinov/gpt-pro-cli/blob/main/README.md'), null);
});

test('resolveGitHubRepositories auto prefers origin and deduplicates explicit repos', async () => {
  const dir = await initRepo([
    ['origin', 'git@github.com:AmirTlinov/gpt-pro-cli.git'],
    ['upstream', 'https://github.com/OtherOwner/other-repo.git'],
  ]);

  assert.deepEqual(resolveGitHubRepositories(['auto', 'AmirTlinov/gpt-pro-cli'], { cwd: dir }), ['AmirTlinov/gpt-pro-cli']);
  assert.deepEqual(resolveGitHubRepositories('AmirTlinov/gpt-pro-cli'), ['AmirTlinov/gpt-pro-cli']);
  assert.deepEqual(discoverGitHubRepositoryFromGit({ cwd: dir }), {
    remote: 'origin',
    url: 'git@github.com:AmirTlinov/gpt-pro-cli.git',
    repository: 'AmirTlinov/gpt-pro-cli',
  });
});

test('resolveGitHubRepositories auto uses a single non-origin GitHub remote', async () => {
  const dir = await initRepo([
    ['upstream', 'https://github.com/AmirTlinov/gpt-pro-cli.git'],
  ]);

  assert.deepEqual(resolveGitHubRepositories(['auto'], { cwd: dir }), ['AmirTlinov/gpt-pro-cli']);
});

test('resolveGitHubRepositories auto fails closed when git repo is missing or ambiguous', async () => {
  const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-not-git-'));
  assert.throws(
    () => resolveGitHubRepositories(['auto'], { cwd: notRepo }),
    /Could not resolve GitHub repository from git remotes/,
  );

  const ambiguous = await initRepo([
    ['one', 'https://github.com/AmirTlinov/gpt-pro-cli.git'],
    ['two', 'git@github.com:OtherOwner/other-repo.git'],
  ]);
  assert.throws(
    () => resolveGitHubRepositories(['auto'], { cwd: ambiguous }),
    /multiple git remotes/,
  );

  const nonGitHub = await initRepo([
    ['origin', 'git@gitlab.com:AmirTlinov/gpt-pro-cli.git'],
  ]);
  assert.throws(
    () => resolveGitHubRepositories(['auto'], { cwd: nonGitHub }),
    /Could not resolve GitHub repository from git remotes/,
  );
});

test('CLI --github-repo auto fails before browser work when cwd is not a GitHub checkout', async () => {
  const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-cli-not-git-'));

  await assert.rejects(
    execFile(process.execPath, [
      cliPath,
      'ask',
      '--github-repo',
      'auto',
      '--',
      'should not reach browser',
    ], { cwd: notRepo, timeout: 10_000 }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Could not resolve GitHub repository from git remotes/);
      return true;
    },
  );
});
