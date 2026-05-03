import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathExists } from '../src/fsx.js';

const execFile = promisify(execFileCallback);
const cliPath = path.resolve('src/cli.js');

function fakeChatGptServer() {
  let hasProject = false;
  const stableProjectId = 'g-p-69f7c0903ae88191b78a7ca2f00838e0';
  const projectId = `${stableProjectId}-cli-questions`;
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
          <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
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
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            const prompt = document.querySelector('#prompt-textarea').textContent;
            const user = document.createElement('div');
            user.setAttribute('data-message-author-role', 'user');
            user.textContent = prompt;
            document.body.appendChild(user);
            setTimeout(() => {
              history.pushState({}, '', '${inProject ? `/g/${projectId}/c/fake-session` : '/c/fake-session'}');
              const assistant = document.createElement('div');
              assistant.setAttribute('data-message-author-role', 'assistant');
              assistant.textContent = 'CLI-E2E ' + prompt;
              document.body.appendChild(assistant);
            }, 50);
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

test('CLI ask talks through keeper and stop cleans runtime file', async (t) => {
  if (!await pathExists('/Applications/Google Chrome.app')) {
    t.skip('Google Chrome is not installed');
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-e2e-'));
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
    assert.ok(answerPath);
    assert.match(await fs.readFile(answerPath, 'utf8'), /CLI-E2E nonce-keeper/);

    const stop = await execFile(process.execPath, [cliPath, 'stop'], { env, timeout: 10_000 });
    assert.match(stop.stdout, /^OK/m);
    assert.equal(await pathExists(path.join(home, 'runtime', 'keeper.json')), false);
  } finally {
    await execFile(process.execPath, [cliPath, 'stop'], { env, timeout: 10_000 }).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
