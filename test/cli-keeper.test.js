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

test('CLI status is quiet when keeper is stopped', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-status-stopped-'));
  const { stdout, stderr } = await execFile(process.execPath, [cliPath, 'status'], {
    env: {
      ...process.env,
      GPT_PRO_HOME: home,
    },
    timeout: 10_000,
  });
  assert.equal(stderr, '');
  assert.match(stdout, /^OK/m);
  assert.match(stdout, /^keeper: stopped$/m);
  assert.match(stdout, /^task: none$/m);
});

test('doctor defaults agent traffic to headless browser mode', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-doctor-headless-'));
  const { stdout } = await execFile(process.execPath, [cliPath, 'doctor'], {
    env: {
      ...process.env,
      GPT_PRO_HOME: home,
      GPT_PRO_BROWSER_MODE: '',
    },
    timeout: 10_000,
  });
  assert.match(stdout, /^browser-mode: headless$/m);
  assert.match(stdout, /^headless-flavor: new$/m);
});

test('macOS focus guard hides the automated Chrome instead of activating a stale desktop', async () => {
  const source = await fs.readFile(path.resolve('src/keeper.js'), 'utf8');
  assert.match(source, /application processes whose name is "Google Chrome" or name is "Chromium"/);
  assert.match(source, /set visible of chromeProc to false/);
  assert.match(source, /\['background', 'headless'\]\.includes\(mode\)/);
  assert.doesNotMatch(source, /set frontmost of first application process/);
  assert.doesNotMatch(source, /tell application previousApp to activate/);
  assert.doesNotMatch(source, /restorePreviousAppIfChromeIsFrontmost/);
});

test('macOS background launch avoids LaunchServices by default to prevent Space switching', async () => {
  const source = await fs.readFile(path.resolve('src/keeper.js'), 'utf8');
  assert.match(source, /GPT_PRO_MACOS_OPEN_LAUNCH === '1'/);
  assert.match(source, /spawn\(chromePath, args/);
  assert.doesNotMatch(source, /mode !== 'background'[\s\S]+\/usr\/bin\/open/);
});

async function profileProcessLines(profileDir) {
  const { stdout } = await execFile('ps', ['-axo', 'pid=,command=']);
  return stdout
    .split('\n')
    .filter((line) => line.includes(`--user-data-dir=${profileDir}`));
}

async function frontmostApplication() {
  const { stdout } = await execFile('osascript', [
    '-e',
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ], { timeout: 1000 });
  return stdout.trim();
}

function isChromeApplicationName(value) {
  return /^(Google Chrome|Chromium)$/i.test(String(value || '').trim());
}

async function runCliWithFrontmostSamples(args, { env, timeoutMs = 30_000 } = {}) {
  const samples = [];
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      samples.push(await frontmostApplication().catch((error) => `ERROR:${error.message}`));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  const child = spawn(process.execPath, [cliPath, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
  }, timeoutMs);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  stop = true;
  await sampler;
  return { code, stdout, stderr, samples };
}

function fakeChatGptServer(options = {}) {
  let hasProject = Boolean(options.hasProjectInitially);
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
            const delay = prompt.includes('slow-progress') ? 7000 : (prompt.includes('concurrent-') ? 800 : 50);
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
            }, delay);
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
  const { server, url } = await fakeChatGptServer({ hasProjectInitially: true });
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

test('CLI ask progress reports semantic changes without elapsed-only noise on stderr', async (t) => {
  if (!await pathExists('/Applications/Google Chrome.app')) {
    t.skip('Google Chrome is not installed');
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-progress-e2e-'));
  const { server, url } = await fakeChatGptServer({ hasProjectInitially: true });
  const env = {
    ...process.env,
    GPT_PRO_HOME: home,
    GPT_PRO_CHATGPT_URL: url,
    GPT_PRO_BROWSER_MODE: 'headless',
    GPT_PRO_OPERATION_TIMEOUT_MS: '20000',
    GPT_PRO_IDLE_MS: '60000',
  };

  try {
    const { stdout, stderr } = await execFile(process.execPath, [
      cliPath,
      'ask',
      '--session',
      'new',
      '--timeout',
      '20000',
      '--',
      'slow-progress stable status',
    ], { env, timeout: 45_000 });

    assert.match(stdout, /^OK/m);
    const statusLines = stderr.split('\n').filter((line) => line.startsWith('status: '));
    assert.ok(statusLines.length >= 1, stderr);
    assert.ok(statusLines.length <= 4, stderr);
    assert.ok(statusLines.some((line) => /phase=waiting_answer/.test(line)), stderr);
    assert.ok(statusLines.every((line) => !/ elapsed=\d+s$/.test(line)), stderr);
    assert.equal(new Set(statusLines).size, statusLines.length, stderr);
  } finally {
    await execFile(process.execPath, [cliPath, 'stop'], { env, timeout: 10_000 }).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('headless ask does not make Chrome frontmost on macOS', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS focus ownership is only testable on darwin');
    return;
  }
  if (!await pathExists('/Applications/Google Chrome.app')) {
    t.skip('Google Chrome is not installed');
    return;
  }

  let before;
  try {
    before = await frontmostApplication();
  } catch (error) {
    t.skip(`frontmost app probe unavailable: ${error.message}`);
    return;
  }
  if (isChromeApplicationName(before)) {
    t.skip('frontmost app is already Chrome, so Chrome focus stealing cannot be distinguished');
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-headless-focus-e2e-'));
  const { server, url } = await fakeChatGptServer();
  const env = {
    ...process.env,
    GPT_PRO_HOME: home,
    GPT_PRO_CHATGPT_URL: url,
    GPT_PRO_BROWSER_MODE: 'headless',
    GPT_PRO_OPERATION_TIMEOUT_MS: '15000',
    GPT_PRO_IDLE_MS: '60000',
    GPT_PRO_PROGRESS: '0',
  };

  try {
    const result = await runCliWithFrontmostSamples([
      'ask',
      '--session',
      'new',
      '--timeout',
      '15000',
      '--',
      'focus-safe headless launch',
    ], { env, timeoutMs: 35_000 });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^OK/m);
    const chromeSamples = result.samples.filter(isChromeApplicationName);
    assert.deepEqual(chromeSamples, [], `Chrome became frontmost during headless ask. samples=${result.samples.join(' -> ')}`);
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
    'chrome profile status probe',
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
