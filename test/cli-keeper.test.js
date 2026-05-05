import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathExists } from '../src/fsx.js';

const execFile = promisify(execFileCallback);
const cliPath = path.resolve('src/cli.js');

test('CLI exposes quiet version flags', async () => {
  const expected = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')).version;
  for (const flag of ['--version', '-v', 'version']) {
    const { stdout, stderr } = await execFile(process.execPath, [cliPath, flag], { timeout: 10_000 });
    assert.equal(stderr, '');
    assert.equal(stdout.trim(), expected);
  }
});

async function profileProcessLines(profileDir) {
  const { stdout } = await execFile('ps', ['-axo', 'pid=,command=']);
  return stdout
    .split('\n')
    .filter((line) => line.includes(`--user-data-dir=${profileDir}`));
}

function fakeChatGptServer() {
  let hasProject = false;
  const stableProjectId = 'g-p-69f7c0903ae88191b78a7ca2f00838e0';
  const projectId = `${stableProjectId}-cli-questions`;
  const smokeSentinel = process.env.GPT_PRO_SMOKE_SENTINEL || 'GPT_PRO_SMOKE_FAKE';
  const html = (inProject = false) => `<!doctype html>
    <html>
      <body>
        <nav>
          <button>Проекты</button>
          <button id="new-project">Новый проект</button>
          ${hasProject ? `<a href="/g/${projectId}/project">CLI_QUESTIONS</a>` : ''}
          <a href="/c/global-session">Global Session</a>
        </nav>
        ${inProject ? `<a href="/g/${projectId}/c/fake-session">Fake Session</a>` : ''}
        <main>
          <button id="tools" aria-label="Add tools">+</button>
          <div id="tool-menu" style="display:none">
            <button id="github">GitHub</button>
          </div>
          <div id="github-menu" style="display:none">
            <input id="repo-search" placeholder="Поиск в репозиториях..." />
            <button id="repo" role="menuitemcheckbox" aria-checked="false" style="display:none">AmirTlinov/gpt-pro-cli</button>
          </div>
          <div id="selected-repo"></div>
          <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
          <input type="file" />
          <button data-testid="send-button">Send</button>
        </main>
        <div id="modal"></div>
        <script>
          document.querySelector('#new-project').addEventListener('click', () => {
            document.querySelector('#modal').innerHTML = \`
              <form id="project-modal-form" action="/create-project" method="get">
                <input id="project-name" name="projectName" type="text" />
                <button type="submit" form="project-modal-form">Создать проект</button>
              </form>
            \`;
          });
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github').addEventListener('click', () => {
            document.querySelector('#github-menu').style.display = 'block';
          });
          document.querySelector('#repo-search').addEventListener('input', (event) => {
            if (event.target.value === 'AmirTlinov/gpt-pro-cli') {
              document.querySelector('#repo').style.display = 'block';
            }
          });
          document.querySelector('#repo').addEventListener('click', () => {
            const repo = document.querySelector('#repo');
            const next = repo.getAttribute('aria-checked') === 'true' ? 'false' : 'true';
            repo.setAttribute('aria-checked', next);
            document.querySelector('#selected-repo').textContent = next === 'true' ? 'AmirTlinov/gpt-pro-cli' : '';
          });
          window.__gptProActiveGenerations = window.__gptProActiveGenerations || 0;
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            const prompt = document.querySelector('#prompt-textarea').textContent;
            const overlapped = window.__gptProActiveGenerations > 0;
            window.__gptProActiveGenerations += 1;
            const user = document.createElement('div');
            user.setAttribute('data-message-author-role', 'user');
            user.textContent = prompt;
            document.body.appendChild(user);
            setTimeout(() => {
              history.pushState({}, '', '${inProject ? `/g/${projectId}/c/fake-session` : '/c/fake-session'}');
              const assistant = document.createElement('div');
              assistant.setAttribute('data-message-author-role', 'assistant');
              assistant.textContent = prompt.includes('proof.txt') ? '${smokeSentinel}' : (overlapped ? 'OVERLAP ' : 'CLI-E2E ') + prompt;
              document.body.appendChild(assistant);
              window.__gptProActiveGenerations -= 1;
            }, prompt.includes('concurrent-') ? 800 : 50);
          });
        </script>
      </body>
    </html>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/create-project') {
      hasProject = true;
      res.writeHead(302, { location: `/g/${stableProjectId}/project` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html(url.pathname.startsWith(`/g/${projectId}/`) || url.pathname.startsWith(`/g/${stableProjectId}/`)));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('CLI ask cleans pending runtime artifacts when attachment staging fails', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-pending-cleanup-'));
  const env = {
    ...process.env,
    GPT_PRO_HOME: home,
  };

  let stderr = '';
  await assert.rejects(
    execFile(process.execPath, [
      cliPath,
      'ask',
      '--attach',
      path.join(home, 'missing-input.zip'),
      '--',
      'this must fail before browser work',
    ], { env, timeout: 10_000 }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /^ERROR\n/);
      stderr = error.stderr;
      return true;
    },
  );

  const pendingRoot = path.join(home, 'runtime', 'pending');
  const entries = await fs.readdir(pendingRoot).catch(() => []);
  assert.deepEqual(entries, []);
  const failureReceipt = stderr.match(/^failure: (.+receipt\.json)$/m)?.[1];
  assert.ok(failureReceipt);
  assert.equal(await pathExists(failureReceipt), true);
  const receipt = JSON.parse(await fs.readFile(failureReceipt, 'utf8'));
  assert.equal(receipt.status, 'warn');
  assert.ok(receipt.warnings.includes('answer is empty'));
  assert.ok(receipt.warnings.some((warning) => warning.startsWith('ask failed:')));
});

test('concurrent CLI asks use one serialized keeper without mixed prompts', async (t) => {
  if (!await pathExists('/Applications/Google Chrome.app')) {
    t.skip('Google Chrome is not installed');
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-concurrent-e2e-'));
  const { server, url } = await fakeChatGptServer();
  const env = {
    ...process.env,
    GPT_PRO_HOME: home,
    GPT_PRO_CHATGPT_URL: url,
    GPT_PRO_BROWSER_MODE: 'headless',
    GPT_PRO_OPERATION_TIMEOUT_MS: '12000',
    GPT_PRO_IDLE_MS: '60000',
  };

  const ask = (prompt) => execFile(process.execPath, [
    cliPath,
    'ask',
    '--session',
    'new',
    '--timeout',
    '12000',
    '--',
    prompt,
  ], { env, timeout: 45_000 });

  try {
    const [alpha, beta] = await Promise.all([
      ask('concurrent-alpha'),
      ask('concurrent-beta'),
    ]);

    for (const result of [alpha, beta]) {
      assert.match(result.stdout, /^OK/m);
      assert.doesNotMatch(result.stdout, /OVERLAP/);
      const answerPath = result.stdout.match(/^answer: (.+)$/m)?.[1];
      const receiptPath = result.stdout.match(/^receipt: (.+)$/m)?.[1];
      assert.ok(answerPath);
      assert.ok(receiptPath);
      assert.match(await fs.readFile(answerPath, 'utf8'), /CLI-E2E concurrent-(alpha|beta)/);
      assert.doesNotMatch(await fs.readFile(answerPath, 'utf8'), /OVERLAP/);
      assert.equal(JSON.parse(await fs.readFile(receiptPath, 'utf8')).status, 'ok');
    }

    const answerDirs = [alpha, beta]
      .map((result) => result.stdout.match(/^answer: (.+)$/m)?.[1])
      .map((answerPath) => path.dirname(answerPath));
    assert.equal(new Set(answerDirs).size, 2);
  } finally {
    await execFile(process.execPath, [cliPath, 'stop'], { env, timeout: 10_000 }).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('CLI ask talks through keeper and stop cleans runtime file', async (t) => {
  if (!await pathExists('/Applications/Google Chrome.app')) {
    t.skip('Google Chrome is not installed');
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-e2e-'));
  const smokeSentinel = 'GPT_PRO_SMOKE_FAKE';
  const { server, url } = await fakeChatGptServer();
  const env = {
    ...process.env,
    GPT_PRO_HOME: home,
    GPT_PRO_CHATGPT_URL: url,
    GPT_PRO_BROWSER_MODE: 'headless',
    GPT_PRO_OPERATION_TIMEOUT_MS: '8000',
    GPT_PRO_IDLE_MS: '60000',
  };

  try {
    const { stdout } = await execFile(process.execPath, [
      cliPath,
      'ask',
      '--session',
      'new',
      '--timeout',
      '8000',
      '--',
      'nonce-keeper',
    ], { env, timeout: 30_000 });

    assert.match(stdout, /^OK/m);
    assert.match(stdout, /^project: CLI_QUESTIONS$/m);
    assert.match(stdout, /\/g\/g-p-69f7c0903ae88191b78a7ca2f00838e0-cli-questions\/c\/fake-session/);
    const answerPath = stdout.match(/^answer: (.+)$/m)?.[1];
    const receiptPath = stdout.match(/^receipt: (.+)$/m)?.[1];
    assert.ok(answerPath);
    assert.ok(receiptPath);
    assert.match(await fs.readFile(answerPath, 'utf8'), /CLI-E2E nonce-keeper/);
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    assert.equal(receipt.status, 'ok');
    assert.ok(receipt.files.some((file) => file.path === 'answer.md'));

    const grounded = await execFile(process.execPath, [
      cliPath,
      'ask',
      '--session',
      'new',
      '--github-repo',
      'AmirTlinov/gpt-pro-cli',
      '--timeout',
      '8000',
      '--',
      'repo-grounded nonce',
    ], { env, timeout: 30_000 });
    assert.match(grounded.stdout, /^OK/m);
    assert.match(grounded.stdout, /^github: AmirTlinov\/gpt-pro-cli$/m);
    const groundedReceiptPath = grounded.stdout.match(/^receipt: (.+)$/m)?.[1];
    assert.ok(groundedReceiptPath);
    const groundedReceipt = JSON.parse(await fs.readFile(groundedReceiptPath, 'utf8'));
    assert.deepEqual(groundedReceipt.githubRepositories, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(groundedReceipt.githubConnector.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(groundedReceipt.githubConnector.repositories[0].state, 'temporary-selected');
    assert.equal(groundedReceipt.githubConnector.cleanup.status, 'ok');
    assert.deepEqual(groundedReceipt.githubConnector.cleanup.cleaned, [{ repository: 'AmirTlinov/gpt-pro-cli', state: 'unselected' }]);
    const groundedPrompt = await fs.readFile(path.join(groundedReceipt.messageDir, 'prompt.md'), 'utf8');
    assert.match(groundedPrompt, /Repository grounding requirement:/);
    assert.match(groundedPrompt, /Use the ChatGPT GitHub connector/);

    const gitWorktree = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-auto-github-worktree-'));
    await execFile('git', ['init'], { cwd: gitWorktree });
    await execFile('git', ['remote', 'add', 'origin', 'https://github.com/AmirTlinov/gpt-pro-cli.git'], { cwd: gitWorktree });
    const autoGrounded = await execFile(process.execPath, [
      cliPath,
      'ask',
      '--session',
      'new',
      '--github-repo',
      'auto',
      '--timeout',
      '8000',
      '--',
      'repo-auto-grounded nonce',
    ], { env, cwd: gitWorktree, timeout: 30_000 });
    assert.match(autoGrounded.stdout, /^OK/m);
    assert.match(autoGrounded.stdout, /^github: AmirTlinov\/gpt-pro-cli$/m);
    const autoReceiptPath = autoGrounded.stdout.match(/^receipt: (.+)$/m)?.[1];
    assert.ok(autoReceiptPath);
    const autoReceipt = JSON.parse(await fs.readFile(autoReceiptPath, 'utf8'));
    assert.deepEqual(autoReceipt.githubRepositories, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(autoReceipt.githubConnector.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(autoReceipt.githubConnector.cleanup.status, 'ok');

    const latest = await execFile(process.execPath, [
      cliPath,
      'ask',
      '--session',
      'latest',
      '--timeout',
      '8000',
      '--',
      'nonce-latest',
    ], { env, timeout: 30_000 });
    assert.match(latest.stdout, /\/g\/g-p-69f7c0903ae88191b78a7ca2f00838e0-cli-questions\/c\/fake-session/);

    const smoke = await execFile(process.execPath, [
      cliPath,
      'smoke',
      '--timeout',
      '8000',
    ], {
      env: {
        ...env,
        GPT_PRO_SMOKE_SENTINEL: smokeSentinel,
      },
      timeout: 30_000,
    });
    assert.match(smoke.stdout, /^OK/m);
    assert.match(smoke.stdout, /^receipt: .+receipt\.json$/m);

    const archive = await execFile(process.execPath, [
      cliPath,
      'archive',
      '--delete-local',
    ], { env, timeout: 30_000 });
    assert.match(archive.stdout, /^OK/m);
    assert.match(archive.stdout, /^deleted-local: 1$/m);
    const archivePath = archive.stdout.match(/^archive: (.+)$/m)?.[1];
    assert.ok(archivePath);
    assert.equal(await pathExists(archivePath), true);
    assert.equal(await pathExists(path.join(home, 'chats', 'fake-session')), false);

    const stop = await execFile(process.execPath, [cliPath, 'stop'], { env, timeout: 10_000 });
    assert.match(stop.stdout, /^OK/m);
    assert.equal(await pathExists(path.join(home, 'runtime', 'keeper.json')), false);
    assert.deepEqual(await profileProcessLines(path.join(home, 'browser-profile')), []);
  } finally {
    await execFile(process.execPath, [cliPath, 'stop'], { env, timeout: 10_000 }).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('stop does not kill unrelated processes that merely mention the profile arg', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-stop-safe-'));
  const profileDir = path.join(home, 'browser-profile');
  await fs.mkdir(profileDir, { recursive: true });
  const env = {
    ...process.env,
    GPT_PRO_HOME: home,
  };
  const decoy = spawn('/usr/bin/python3', [
    '-c',
    'import time; time.sleep(30)',
    `--user-data-dir=${profileDir}`,
  ], {
    stdio: 'ignore',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stop = await execFile(process.execPath, [cliPath, 'stop'], { env, timeout: 10_000 });
    assert.match(stop.stdout, /^OK/m);
    assert.equal(decoy.kill(0), true);
  } finally {
    decoy.kill('SIGKILL');
  }
});
