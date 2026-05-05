import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import {
  attachGitHubRepositories,
  extractLinks,
  extractVisibleReasoning,
  isLoggedIn,
  openOrCreateProject,
  scrapeSessions,
  submitPrompt,
  waitForAnswerStable,
  waitForUserPromptVisible,
} from '../src/chatgpt.js';

function fakeProjectServer({ hasProject = false } = {}) {
  const stableProjectId = 'g-p-69f7c0903ae88191b78a7ca2f00838e0';
  const projectId = `${stableProjectId}-cli-questions`;
  const projectName = 'CLI_QUESTIONS';
  const home = () => `<!doctype html>
    <html>
      <body>
        <aside>
          <button>Проекты</button>
          <button id="new-project">Новый проект</button>
          ${hasProject ? `<a href="/g/${projectId}/project">${projectName}</a>` : ''}
        </aside>
        <main>
          <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
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
        </script>
      </body>
    </html>`;
  const project = () => `<!doctype html>
    <html>
      <body>
        <aside>
          <a href="/c/global-session">Global Session</a>
        </aside>
        <main>
          <h1>${projectName}</h1>
          <a href="/g/${projectId}/c/project-session">Project Session</a>
          <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        </main>
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
    if (url.pathname.startsWith(`/g/${projectId}/`) || url.pathname.startsWith(`/g/${stableProjectId}/`)) {
      res.end(project());
    } else {
      res.end(home());
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('fake ChatGPT page accepts prompt and exposes answer artifacts', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
      <input type="file" />
      <button data-testid="send-button">Send</button>
      <script>
        document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
          const prompt = document.querySelector('#prompt-textarea').textContent;
          const user = document.createElement('div');
          user.setAttribute('data-message-author-role', 'user');
          user.textContent = prompt;
          document.body.appendChild(user);
          setTimeout(() => {
            const reasoning = document.createElement('div');
            reasoning.setAttribute('data-gpt-pro-reasoning', '');
            reasoning.textContent = 'visible reasoning summary';
            document.body.appendChild(reasoning);
            const assistant = document.createElement('div');
            assistant.setAttribute('data-message-author-role', 'assistant');
            assistant.innerHTML = 'PONG ' + prompt + ' <a href="https://example.com/out.zip">file</a>';
            document.body.appendChild(assistant);
          }, 50);
        });
      </script>
    </main>
  `);

  await submitPrompt(page, { prompt: 'nonce-123' });
  const answer = await waitForAnswerStable(page, 5000);
  assert.match(answer, /PONG nonce-123/);
  assert.match(await extractVisibleReasoning(page), /visible reasoning summary/);
  assert.deepEqual(await extractLinks(page), ['https://example.com/out.zip']);
  await browser.close();
});

test('submitPrompt verifies prompt submission and can force-click send', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
      <button data-testid="send-button">Send</button>
      <script>
        document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
          const prompt = document.querySelector('#prompt-textarea').textContent;
          const user = document.createElement('div');
          user.setAttribute('data-message-author-role', 'user');
          user.textContent = prompt;
          document.body.appendChild(user);
        });
      </script>
    </main>
  `);

  await submitPrompt(page, { prompt: 'submitted prompt' });
  assert.equal(await waitForUserPromptVisible(page, 'submitted prompt', 1000), true);
  await browser.close();
});

test('submitPrompt accepts new ChatGPT UI when generation starts before user prompt is visible', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
      <button id="composer-submit-button" aria-label="Send message">Send</button>
      <script>
        document.querySelector('#composer-submit-button').addEventListener('click', () => {
          document.querySelector('#prompt-textarea').textContent = '';
          const button = document.querySelector('#composer-submit-button');
          button.textContent = '';
          button.setAttribute('data-testid', 'stop-button');
          button.setAttribute('aria-label', 'Stop answering');
        });
      </script>
    </main>
  `);

  await submitPrompt(page, { prompt: 'hidden submitted prompt' });
  assert.equal(await page.locator('[data-testid="stop-button"]').count(), 1);
  await browser.close();
});


test('answer wait accepts a fresh repeated answer after the submitted prompt', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div data-message-author-role="assistant">OK</div>
      <div data-message-author-role="user">repeat please</div>
      <div data-message-author-role="assistant">OK</div>
    </main>
  `);

  const answer = await waitForAnswerStable(page, 1200, {
    prompt: 'repeat please',
    previousAnswer: 'OK',
    previousAssistantCount: 1,
  });
  assert.equal(answer, 'OK');
  await browser.close();
});

test('answer wait fails closed instead of returning partial text while generation is active', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div data-message-author-role="user">slow prompt</div>
      <div data-message-author-role="assistant">PARTIAL_ANSWER_STILL_GENERATING</div>
      <button data-testid="stop-button">Stop</button>
    </main>
  `);

  await assert.rejects(
    () => waitForAnswerStable(page, 300, { prompt: 'slow prompt' }),
    /complete ChatGPT answer|partial answer was discarded/,
  );
  await browser.close();
});

test('answer wait ignores an already-stable previous assistant message', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div data-message-author-role="assistant">OLD_ANSWER</div>
      <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
      <button data-testid="send-button">Send</button>
      <script>
        document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
          const prompt = document.querySelector('#prompt-textarea').textContent;
          const user = document.createElement('div');
          user.setAttribute('data-message-author-role', 'user');
          user.textContent = prompt;
          document.body.appendChild(user);
          setTimeout(() => {
            const assistant = document.createElement('div');
            assistant.setAttribute('data-message-author-role', 'assistant');
            assistant.textContent = 'NEW_ANSWER';
            document.body.appendChild(assistant);
          }, 50);
        });
      </script>
    </main>
  `);

  await submitPrompt(page, { prompt: 'fresh' });
  const answer = await waitForAnswerStable(page, 5000, {
    previousAnswer: 'OLD_ANSWER',
    previousAssistantCount: 1,
  });
  assert.equal(answer, 'NEW_ANSWER');
  await browser.close();
});

test('answer wait associates response with the submitted user prompt', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div data-message-author-role="user">old prompt</div>
      <div data-message-author-role="assistant">OLD_LATE_ANSWER</div>
      <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
      <button data-testid="send-button">Send</button>
      <script>
        document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
          const prompt = document.querySelector('#prompt-textarea').textContent;
          const user = document.createElement('div');
          user.setAttribute('data-message-author-role', 'user');
          user.textContent = prompt;
          document.body.appendChild(user);
          setTimeout(() => {
            const assistant = document.createElement('div');
            assistant.setAttribute('data-message-author-role', 'assistant');
            assistant.textContent = 'ANSWER_FOR_' + prompt;
            document.body.appendChild(assistant);
          }, 50);
        });
      </script>
    </main>
  `);

  await submitPrompt(page, { prompt: 'fresh prompt' });
  const answer = await waitForAnswerStable(page, 5000, {
    prompt: 'fresh prompt',
    previousAnswer: 'OLD_LATE_ANSWER',
  });
  assert.equal(answer, 'ANSWER_FOR_fresh prompt');
  await browser.close();
});

test('opens an existing CLI_QUESTIONS project before asking', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const { server, url } = await fakeProjectServer({ hasProject: true });
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const project = await openOrCreateProject(page, {
      projectName: 'CLI_QUESTIONS',
      baseUrl: url,
      timeoutMs: 5000,
    });
    assert.equal(project.created, false);
    assert.match(page.url(), /\/g\/g-p-69f7c0903ae88191b78a7ca2f00838e0-cli-questions\/project$/);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('opens cached CLI_QUESTIONS project URL when sidebar discovery is unavailable', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const { server, url } = await fakeProjectServer({ hasProject: false });
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const project = await openOrCreateProject(page, {
      projectName: 'CLI_QUESTIONS',
      baseUrl: url,
      timeoutMs: 5000,
      projectUrlHint: `${url}/g/g-p-69f7c0903ae88191b78a7ca2f00838e0-cli-questions/project`,
    });
    assert.equal(project.created, false);
    assert.equal(project.source, 'cache');
    assert.match(project.projectUrl, /\/g\/g-p-69f7c0903ae88191b78a7ca2f00838e0-cli-questions\/project$/);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keeps current CLI_QUESTIONS project page even without a sidebar self-link', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const { server, url } = await fakeProjectServer({ hasProject: true });
  const page = await browser.newPage();
  try {
    await page.goto(`${url}/g/g-p-69f7c0903ae88191b78a7ca2f00838e0-cli-questions/project`);
    const project = await openOrCreateProject(page, {
      projectName: 'CLI_QUESTIONS',
      baseUrl: url,
      timeoutMs: 5000,
    });
    assert.equal(project.created, false);
    assert.equal(project.keptCurrent, false);
    assert.match(project.projectUrl, /\/g\/g-p-69f7c0903ae88191b78a7ca2f00838e0-cli-questions\/project$/);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('creates CLI_QUESTIONS when the project does not exist', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const { server, url } = await fakeProjectServer({ hasProject: false });
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const project = await openOrCreateProject(page, {
      projectName: 'CLI_QUESTIONS',
      baseUrl: url,
      timeoutMs: 5000,
    });
    assert.equal(project.created, true);
    assert.match(project.projectUrl, /\/g\/g-p-69f7c0903ae88191b78a7ca2f00838e0\/project$/);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('project session scraping ignores general chat history', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const { server, url } = await fakeProjectServer({ hasProject: true });
  const page = await browser.newPage();
  try {
    await page.goto(`${url}/g/g-p-69f7c0903ae88191b78a7ca2f00838e0/project`);
    const sessions = await scrapeSessions(page, `${url}/g/g-p-69f7c0903ae88191b78a7ca2f00838e0/project`);
    assert.deepEqual(sessions.map((session) => session.title), ['Project Session']);
    assert.match(sessions[0].url, /\/g\/g-p-69f7c0903ae88191b78a7ca2f00838e0-cli-questions\/c\/project-session$/);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GitHub connector selector opens tool menu, searches, and selects exact repository', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <button id="tools" aria-label="Add tools">+</button>
        <div id="tool-menu" style="display:none">
          <button id="github">GitHub</button>
        </div>
        <div id="github-menu" style="display:none">
          <input id="repo-search" placeholder="Поиск в репозиториях..." />
          <button id="repo" style="display:none">AmirTlinov/gpt-pro-cli</button>
        </div>
        <div id="selected"></div>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <script>
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
            document.querySelector('#selected').textContent = 'AmirTlinov/gpt-pro-cli';
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.requested, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositorySelection, 'repo-picker');
    assert.equal(await page.locator('#selected').innerText(), 'AmirTlinov/gpt-pro-cli');
  } finally {
    await browser.close();
  }
});

test('GitHub connector selector opens nested More tools menu when GitHub is not top-level', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <button id="tools" data-testid="composer-plus-btn" aria-label="Добавляйте файлы и многое другое">+</button>
        <div id="tool-menu" role="menu" style="display:none">
          <div role="menuitem" id="more">Больше</div>
        </div>
        <div id="more-menu" role="menu" style="display:none">
          <div role="menuitemradio" id="github">GitHub</div>
        </div>
        <div id="github-menu" style="display:none">
          <input id="repo-search" placeholder="Поиск в репозиториях..." />
          <div role="menuitem" id="repo" style="display:none">AmirTlinov/gpt-pro-cli</div>
        </div>
        <div id="selected"></div>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <script>
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#more').addEventListener('click', () => {
            document.querySelector('#more-menu').style.display = 'block';
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
            document.querySelector('#selected').textContent = 'AmirTlinov/gpt-pro-cli';
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositorySelection, 'repo-picker');
    assert.equal(await page.locator('#selected').innerText(), 'AmirTlinov/gpt-pro-cli');
  } finally {
    await browser.close();
  }
});

test('GitHub connector selector treats current tool-only UI as prompt-scoped grounding', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <button data-testid="composer-plus-btn" aria-label="Добавляйте файлы и многое другое">+</button>
        <div id="tool-menu" role="menu" style="display:none">
          <div role="menuitem" id="more">Больше</div>
        </div>
        <div id="more-menu" role="menu" style="display:none">
          <div role="menuitemradio" id="github">GitHub</div>
        </div>
        <div data-testid="composer-footer-actions"></div>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <script>
          document.querySelector('[data-testid="composer-plus-btn"]').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#more').addEventListener('click', () => {
            document.querySelector('#more-menu').style.display = 'block';
          });
          document.querySelector('#github').addEventListener('click', () => {
            document.querySelector('[data-testid="composer-footer-actions"]').innerHTML = '<button>GitHub</button>';
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.requested, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.selected, []);
    assert.equal(result.toolSelected, true);
    assert.equal(result.repositorySelection, 'prompt-scoped');
  } finally {
    await browser.close();
  }
});

test('submitPrompt keeps going with prompt-required warning when GitHub UI selection is unavailable', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <button data-testid="send-button">Send</button>
        <script>
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            const prompt = document.querySelector('#prompt-textarea').textContent;
            const user = document.createElement('div');
            user.setAttribute('data-message-author-role', 'user');
            user.textContent = prompt;
            document.body.appendChild(user);
          });
        </script>
      </main>
    `);

    const result = await submitPrompt(page, {
      prompt: 'Use GitHub connector.\nQuestion: hello',
      githubRepositories: ['AmirTlinov/gpt-pro-cli'],
    });
    assert.equal(result.githubConnector.uiSelection, 'unavailable');
    assert.deepEqual(result.githubConnector.requested, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(await waitForUserPromptVisible(page, 'Use GitHub connector. Question: hello', 1000), true);
  } finally {
    await browser.close();
  }
});

test('auth detection rejects anonymous composer with login actions', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <a href="/auth/login">Log in</a>
      <button>Sign up</button>
      <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
    </main>
  `);

  assert.equal(await isLoggedIn(page), false);
  await browser.close();
});
