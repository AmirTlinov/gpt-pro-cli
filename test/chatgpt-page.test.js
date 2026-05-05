import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import {
  attachGitHubRepositories,
  cleanupGitHubRepositorySelections,
  detectChatGptBlocker,
  extractLinks,
  extractVisibleReasoning,
  isLoggedIn,
  openOrCreateProject,
  scrapeSessions,
  submitPrompt,
  waitForAnswerStable,
  waitForLoggedIn,
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

async function captureSubmitPromptFailure(page, options) {
  let caught = null;
  try {
    await submitPrompt(page, options);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'submitPrompt should fail before submitting an ungrounded GitHub prompt');
  assert.match(caught.message, /GitHub connector repository selection failed before prompt submission/);
  assert.ok(caught.githubConnector);
  return caught;
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

  const answer = await waitForAnswerStable(page, 5000, {
    prompt: 'repeat please',
    previousAnswer: 'OK',
    previousAssistantCount: 1,
  });
  assert.equal(answer, 'OK');
  await browser.close();
});

test('answer wait does not accept stale answer from repeated prompt prefix before assistant count advances', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const repeatedPrefix = 'Repository grounding requirement: '.padEnd(220, 'x');
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div data-message-author-role="user">${repeatedPrefix} old question</div>
      <div data-message-author-role="assistant">OLD_ANSWER_FOR_SHARED_PREFIX</div>
      <script>
        setTimeout(() => {
          const user = document.createElement('div');
          user.setAttribute('data-message-author-role', 'user');
          user.textContent = '${repeatedPrefix} new question';
          document.body.appendChild(user);
          const assistant = document.createElement('div');
          assistant.setAttribute('data-message-author-role', 'assistant');
          assistant.textContent = 'NEW_ANSWER_FOR_SHARED_PREFIX';
          document.body.appendChild(assistant);
        }, 3500);
      </script>
    </main>
  `);

  const answer = await waitForAnswerStable(page, 8000, {
    prompt: `${repeatedPrefix} new question`,
    previousAssistantCount: 1,
  });
  assert.equal(answer, 'NEW_ANSWER_FOR_SHARED_PREFIX');
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
          <button id="repo" role="menuitemcheckbox" aria-checked="false" style="display:none">AmirTlinov/gpt-pro-cli</button>
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
            document.querySelector('#repo').setAttribute('aria-checked', 'true');
            document.querySelector('#selected').textContent = 'AmirTlinov/gpt-pro-cli';
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.requested, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositorySelection, 'repo-picker');
    assert.equal(result.repositories[0].state, 'temporary-selected');
    assert.equal(await page.locator('#selected').innerText(), 'AmirTlinov/gpt-pro-cli');
  } finally {
    await browser.close();
  }
});

test('GitHub connector searches exact repo before clicking a visible unchecked row', async (t) => {
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
          <input id="hidden-repo-search" placeholder="Поиск в репозиториях..." style="display:none" />
          <input id="repo-search" placeholder="Поиск в репозиториях..." />
          <button id="repo" role="menuitemcheckbox" aria-checked="false">AmirTlinov/gpt-pro-cli</button>
        </div>
        <script>
          window.searches = 0;
          window.clicks = 0;
          window.searchValue = '';
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github').addEventListener('click', () => {
            document.querySelector('#github-menu').style.display = 'block';
          });
          document.querySelector('#repo-search').addEventListener('input', (event) => {
            window.searches += 1;
            window.searchValue = event.target.value;
          });
          document.querySelector('#repo').addEventListener('click', () => {
            window.clicks += 1;
            document.querySelector('#repo').setAttribute('aria-checked', 'true');
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositories[0].state, 'temporary-selected');
    assert.equal(result.repositories[0].searched, true);
    assert.equal(await page.evaluate(() => window.searches), 1);
    assert.equal(await page.evaluate(() => window.searchValue), 'AmirTlinov/gpt-pro-cli');
    assert.equal(await page.evaluate(() => window.clicks), 1);
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
          <div role="menuitemcheckbox" aria-checked="false" id="repo" style="display:none">AmirTlinov/gpt-pro-cli</div>
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
            document.querySelector('#repo').setAttribute('aria-checked', 'true');
            document.querySelector('#selected').textContent = 'AmirTlinov/gpt-pro-cli';
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositorySelection, 'repo-picker');
    assert.equal(result.repositories[0].state, 'temporary-selected');
    assert.equal(await page.locator('#selected').innerText(), 'AmirTlinov/gpt-pro-cli');
  } finally {
    await browser.close();
  }
});

test('GitHub connector selector leaves prechecked repository selected without search or cleanup', async (t) => {
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
          <button id="repo" role="menuitemcheckbox" aria-checked="true">AmirTlinov/gpt-pro-cli</button>
        </div>
        <script>
          window.searches = 0;
          window.clicks = 0;
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github').addEventListener('click', () => {
            document.querySelector('#github-menu').style.display = 'block';
          });
          document.querySelector('#repo-search').addEventListener('input', () => {
            window.searches += 1;
          });
          document.querySelector('#repo').addEventListener('click', () => {
            window.clicks += 1;
            document.querySelector('#repo').setAttribute('aria-checked', 'false');
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositories[0].state, 'preexisting');
    assert.equal(result.cleanup.status, 'not-needed');
    assert.equal(await page.locator('#repo').getAttribute('aria-checked'), 'true');
    assert.equal(await page.evaluate(() => window.searches), 0);
    assert.equal(await page.evaluate(() => window.clicks), 0);

    const cleaned = await cleanupGitHubRepositorySelections(page, result);
    assert.equal(cleaned.cleanup.status, 'not-needed');
    assert.equal(await page.locator('#repo').getAttribute('aria-checked'), 'true');
    assert.equal(await page.evaluate(() => window.clicks), 0);
  } finally {
    await browser.close();
  }
});

test('GitHub connector cleanup unchecks only temporary repository selections', async (t) => {
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
          <button id="repo" role="menuitemcheckbox" aria-checked="false" style="display:none">AmirTlinov/gpt-pro-cli</button>
        </div>
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
            const repo = document.querySelector('#repo');
            repo.setAttribute('aria-checked', repo.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositories[0].state, 'temporary-selected');
    assert.deepEqual(result.cleanupRequired, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(await page.locator('#repo').getAttribute('aria-checked'), 'true');

    const cleaned = await cleanupGitHubRepositorySelections(page, result);
    assert.equal(cleaned.cleanup.status, 'ok');
    assert.deepEqual(cleaned.cleanup.cleaned, [{ repository: 'AmirTlinov/gpt-pro-cli', state: 'unselected' }]);
    assert.equal(await page.locator('#repo').getAttribute('aria-checked'), 'false');
  } finally {
    await browser.close();
  }
});

test('GitHub connector selector opens repository picker from active GitHub pill', async (t) => {
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
          <div role="menuitemradio" id="github-menu-item">GitHub</div>
        </div>
        <div data-testid="composer-footer-actions"></div>
        <div id="github-menu" role="menu" style="display:none">
          <input id="repo-search" placeholder="Поиск в репозиториях…" />
          <div role="menuitem" id="repo" style="display:none">AmirTlinov/gpt-pro-cli</div>
        </div>
        <script>
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github-menu-item').addEventListener('click', () => {
            document.querySelector('[data-testid="composer-footer-actions"]').innerHTML =
              '<button aria-label="GitHub, нажмите, чтобы удалить"></button><button id="github-pill" data-state="closed">GitHub</button>';
          });
          document.addEventListener('click', (event) => {
            if (event.target.id === 'github-pill') {
              event.target.setAttribute('data-state', 'open');
              document.querySelector('#github-menu').style.display = 'block';
            }
          });
          document.querySelector('#repo-search').addEventListener('input', (event) => {
            if (event.target.value === 'AmirTlinov/gpt-pro-cli') {
              document.querySelector('#repo').style.display = 'block';
            }
          });
          document.querySelector('#repo').addEventListener('click', () => {
            document.querySelector('#repo').innerHTML = 'AmirTlinov/gpt-pro-cli<div class="trailing"><svg></svg></div>';
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositories[0].state, 'temporary-selected');
    assert.equal(await page.locator('#github-pill').getAttribute('data-state'), 'open');
  } finally {
    await browser.close();
  }
});

test('GitHub connector waits for delayed GitHub pill before opening repo picker', async (t) => {
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
          <div role="menuitemradio" id="github-menu-item">GitHub</div>
        </div>
        <div data-testid="composer-footer-actions"></div>
        <div id="github-menu" role="menu" style="display:none">
          <input id="repo-search" placeholder="Поиск в репозиториях…" />
          <div role="menuitem" id="repo" style="display:none">AmirTlinov/gpt-pro-cli</div>
        </div>
        <script>
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#more').addEventListener('click', () => {
            document.querySelector('#more-menu').style.display = 'block';
          });
          document.querySelector('#github-menu-item').addEventListener('click', () => {
            setTimeout(() => {
              document.querySelector('[data-testid="composer-footer-actions"]').innerHTML =
                '<button aria-label="GitHub, нажмите, чтобы удалить"></button><button id="github-pill" class="__composer-pill">GitHub</button>';
            }, 1200);
          });
          document.addEventListener('click', (event) => {
            if (event.target.id === 'github-pill') {
              document.querySelector('#github-menu').style.display = 'block';
            }
          });
          document.querySelector('#repo-search').addEventListener('input', (event) => {
            if (event.target.value === 'AmirTlinov/gpt-pro-cli') {
              document.querySelector('#repo').style.display = 'block';
            }
          });
          document.querySelector('#repo').addEventListener('click', () => {
            document.querySelector('#repo').innerHTML = 'AmirTlinov/gpt-pro-cli<div class="trailing"><svg></svg></div>';
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositories[0].state, 'temporary-selected');
    assert.equal(await page.locator('#github-pill').count(), 1);
  } finally {
    await browser.close();
  }
});

test('GitHub connector recovers from an owned tool-only activation and retries picker opening', async (t) => {
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
          <div role="menuitemradio" id="github-menu-item">GitHub</div>
        </div>
        <div data-testid="composer-footer-actions"></div>
        <div id="github-menu" role="menu" style="display:none">
          <input id="repo-search" placeholder="Поиск в репозиториях…" />
          <div role="menuitemcheckbox" aria-checked="false" id="repo" style="display:none">AmirTlinov/gpt-pro-cli</div>
        </div>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <script>
          window.githubActivations = 0;
          window.removals = 0;
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github-menu-item').addEventListener('click', () => {
            window.githubActivations += 1;
            document.querySelector('[data-testid="composer-footer-actions"]').innerHTML =
              '<button id="remove-github" aria-label="GitHub, нажмите, чтобы удалить"></button><button id="github-pill" class="__composer-pill">GitHub</button>';
            if (window.githubActivations > 1) {
              document.querySelector('#github-menu').style.display = 'block';
            }
          });
          document.addEventListener('click', (event) => {
            if (event.target.id === 'remove-github') {
              window.removals += 1;
              document.querySelector('[data-testid="composer-footer-actions"]').innerHTML = '';
              document.querySelector('#github-menu').style.display = 'none';
            }
          });
          document.querySelector('#repo-search').addEventListener('input', (event) => {
            document.querySelector('#repo').style.display = event.target.value === 'AmirTlinov/gpt-pro-cli' ? 'block' : 'none';
          });
          document.querySelector('#repo').addEventListener('click', () => {
            document.querySelector('#repo').setAttribute('aria-checked', 'true');
          });
        </script>
      </main>
    `);

    const result = await attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']);
    assert.deepEqual(result.selected, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(result.repositories[0].state, 'temporary-selected');
    assert.equal(await page.evaluate(() => window.githubActivations), 2);
    assert.equal(await page.evaluate(() => window.removals), 1);
  } finally {
    await browser.close();
  }
});

test('GitHub connector selector rejects tool-only UI as unconfirmed repo grounding', async (t) => {
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

    await assert.rejects(
      () => attachGitHubRepositories(page, ['AmirTlinov/gpt-pro-cli']),
      /was not found|control was not found|checked state could not be determined|repository picker was not opened/,
    );
  } finally {
    await browser.close();
  }
});

test('submitPrompt fails before prompt submission when GitHub UI selection is unavailable', async (t) => {
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

    const error = await captureSubmitPromptFailure(page, {
      prompt: 'Use GitHub connector.\nQuestion: hello',
      githubRepositories: ['AmirTlinov/gpt-pro-cli'],
    });
    assert.equal(error.githubConnector.uiSelection, 'unavailable');
    assert.deepEqual(error.githubConnector.requested, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(await waitForUserPromptVisible(page, 'Use GitHub connector. Question: hello', 1000), false);
  } finally {
    await browser.close();
  }
});

test('submitPrompt removes GitHub tool activated by a failed repo selection', async (t) => {
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
        <div data-testid="composer-footer-actions"></div>
        <div id="github-menu" role="menu" style="display:none">
          <input id="repo-search" placeholder="Поиск в репозиториях…" />
          <div id="repo" style="display:none">AmirTlinov/gpt-pro-cli</div>
        </div>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <button data-testid="send-button">Send</button>
        <script>
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github').addEventListener('click', () => {
            document.querySelector('[data-testid="composer-footer-actions"]').innerHTML =
              '<button id="remove-github" aria-label="Remove GitHub"></button><button id="github-pill">GitHub</button>';
            document.querySelector('#github-menu').style.display = 'block';
          });
          document.addEventListener('click', (event) => {
            if (event.target.id === 'remove-github') {
              document.querySelector('[data-testid="composer-footer-actions"]').innerHTML = '';
            }
          });
          document.querySelector('#repo-search').addEventListener('input', (event) => {
            document.querySelector('#repo').style.display = event.target.value === 'AmirTlinov/gpt-pro-cli' ? 'block' : 'none';
          });
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

    const error = await captureSubmitPromptFailure(page, {
      prompt: 'failed repo cleanup',
      githubRepositories: ['AmirTlinov/gpt-pro-cli'],
    });

    assert.equal(error.githubConnector.uiSelection, 'unavailable');
    assert.deepEqual(error.githubConnector.selected, []);
    assert.equal(error.githubConnector.cleanup.attempted, true);
    assert.equal(error.githubConnector.cleanup.status, 'ok');
    assert.equal(error.githubConnector.cleanup.removedTool, true);
    assert.equal(await page.locator('#github-pill').count(), 0);
    assert.equal(await waitForUserPromptVisible(page, 'failed repo cleanup', 1000), false);
  } finally {
    await browser.close();
  }
});

test('submitPrompt removes GitHub tool activated without a repository picker', async (t) => {
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
        <div data-testid="composer-footer-actions"></div>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <button data-testid="send-button">Send</button>
        <script>
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github').addEventListener('click', () => {
            document.querySelector('[data-testid="composer-footer-actions"]').innerHTML =
              '<button id="remove-github" aria-label="GitHub, нажмите, чтобы удалить"></button><button id="github-pill" class="__composer-pill">GitHub</button>';
          });
          document.addEventListener('click', (event) => {
            if (event.target.id === 'remove-github') {
              document.querySelector('[data-testid="composer-footer-actions"]').innerHTML = '';
            }
          });
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

    const error = await captureSubmitPromptFailure(page, {
      prompt: 'tool-only cleanup',
      githubRepositories: ['AmirTlinov/gpt-pro-cli'],
    });

    assert.equal(error.githubConnector.uiSelection, 'unavailable');
    assert.equal(error.githubConnector.toolActivatedByRun, false);
    assert.equal(error.githubConnector.recovery.resetOwnedTool, true);
    assert.equal(error.githubConnector.cleanup.attempted, true);
    assert.equal(error.githubConnector.cleanup.status, 'ok');
    assert.equal(error.githubConnector.cleanup.removedTool, true);
    assert.equal(await page.locator('#github-pill').count(), 0);
    assert.equal(await waitForUserPromptVisible(page, 'tool-only cleanup', 1000), false);
  } finally {
    await browser.close();
  }
});

test('submitPrompt cleans partial GitHub repo selection when a later repo fails', async (t) => {
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
        <div id="github-menu" role="menu" style="display:none">
          <input id="repo-search" placeholder="Поиск в репозиториях…" />
          <button id="repo-good" role="menuitemcheckbox" aria-checked="false" style="display:none">AmirTlinov/gpt-pro-cli</button>
          <div id="repo-bad" style="display:none">AmirTlinov/missing-repo</div>
        </div>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <button data-testid="send-button">Send</button>
        <script>
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github').addEventListener('click', () => {
            document.querySelector('#github-menu').style.display = 'block';
          });
          document.querySelector('#repo-search').addEventListener('input', (event) => {
            document.querySelector('#repo-good').style.display = event.target.value === 'AmirTlinov/gpt-pro-cli' ? 'block' : 'none';
            document.querySelector('#repo-bad').style.display = event.target.value === 'AmirTlinov/missing-repo' ? 'block' : 'none';
          });
          document.querySelector('#repo-good').addEventListener('click', () => {
            const repo = document.querySelector('#repo-good');
            repo.setAttribute('aria-checked', repo.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
          });
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

    const error = await captureSubmitPromptFailure(page, {
      prompt: 'partial repo cleanup',
      githubRepositories: ['AmirTlinov/gpt-pro-cli', 'AmirTlinov/missing-repo'],
    });
    assert.equal(error.githubConnector.uiSelection, 'partial');
    assert.deepEqual(error.githubConnector.selected, []);
    assert.deepEqual(error.githubConnector.selectedBeforeCleanup, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(error.githubConnector.repositories[0].state, 'cleaned-before-submit');
    assert.match(error.githubConnector.error, /checked state could not be determined/);
    assert.deepEqual(error.githubConnector.cleanup.cleaned, [{ repository: 'AmirTlinov/gpt-pro-cli', state: 'unselected' }]);
    assert.equal(await page.locator('#repo-good').getAttribute('aria-checked'), 'false');
    assert.equal(await waitForUserPromptVisible(page, 'partial repo cleanup', 1000), false);
  } finally {
    await browser.close();
  }
});

test('submitPrompt does not claim cleaned-before-submit when partial cleanup fails', async (t) => {
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
        <div id="github-menu" role="menu" style="display:none">
          <input id="repo-search" placeholder="Поиск в репозиториях…" />
          <button id="repo-good" role="menuitemcheckbox" aria-checked="false" style="display:none">AmirTlinov/gpt-pro-cli</button>
          <div id="repo-bad" style="display:none">AmirTlinov/missing-repo</div>
        </div>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <button data-testid="send-button">Send</button>
        <script>
          window.goodSearches = 0;
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github').addEventListener('click', () => {
            document.querySelector('#github-menu').style.display = 'block';
          });
          document.querySelector('#repo-search').addEventListener('input', (event) => {
            if (event.target.value === 'AmirTlinov/gpt-pro-cli') {
              window.goodSearches += 1;
              document.querySelector('#repo-good').style.display = window.goodSearches === 1 ? 'block' : 'none';
              document.querySelector('#repo-bad').style.display = 'none';
            } else if (event.target.value === 'AmirTlinov/missing-repo') {
              document.querySelector('#repo-good').style.display = 'none';
              document.querySelector('#repo-bad').style.display = 'block';
            }
          });
          document.querySelector('#repo-good').addEventListener('click', () => {
            const repo = document.querySelector('#repo-good');
            repo.setAttribute('aria-checked', repo.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
          });
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

    const error = await captureSubmitPromptFailure(page, {
      prompt: 'partial cleanup failure',
      githubRepositories: ['AmirTlinov/gpt-pro-cli', 'AmirTlinov/missing-repo'],
    });

    assert.equal(error.githubConnector.uiSelection, 'partial');
    assert.deepEqual(error.githubConnector.selected, []);
    assert.deepEqual(error.githubConnector.selectedBeforeCleanup, ['AmirTlinov/gpt-pro-cli']);
    assert.equal(error.githubConnector.repositories[0].state, 'cleanup-failed-before-submit');
    assert.equal(error.githubConnector.cleanup.status, 'warn');
    assert.match(error.githubConnector.cleanup.errors[0].error, /not found during cleanup/);
    assert.equal(await page.locator('#repo-good').getAttribute('aria-checked'), 'true');
    assert.equal(await waitForUserPromptVisible(page, 'partial cleanup failure', 1000), false);
  } finally {
    await browser.close();
  }
});

test('submitPrompt cleans temporary GitHub selection if prompt submission fails after selection', async (t) => {
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
        <div data-testid="composer-footer-actions"></div>
        <div id="github-menu" role="menu" style="display:none">
          <input id="repo-search" placeholder="Поиск в репозиториях…" />
          <button id="repo" role="menuitemcheckbox" aria-checked="false" style="display:none">AmirTlinov/gpt-pro-cli</button>
        </div>
        <div id="prompt-textarea" contenteditable="true" role="textbox"></div>
        <script>
          document.querySelector('#tools').addEventListener('click', () => {
            document.querySelector('#tool-menu').style.display = 'block';
          });
          document.querySelector('#github').addEventListener('click', () => {
            document.querySelector('[data-testid="composer-footer-actions"]').innerHTML =
              '<button id="remove-github" aria-label="GitHub, нажмите, чтобы удалить"></button><button id="github-pill" class="__composer-pill">GitHub</button>';
            document.querySelector('#github-menu').style.display = 'block';
          });
          document.addEventListener('click', (event) => {
            if (event.target.id === 'remove-github') {
              document.querySelector('[data-testid="composer-footer-actions"]').innerHTML = '';
            }
          });
          document.querySelector('#repo-search').addEventListener('input', (event) => {
            document.querySelector('#repo').style.display = event.target.value === 'AmirTlinov/gpt-pro-cli' ? 'block' : 'none';
          });
          document.querySelector('#repo').addEventListener('click', () => {
            const repo = document.querySelector('#repo');
            repo.setAttribute('aria-checked', repo.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
          });
        </script>
      </main>
    `);

    let error = null;
    try {
      await submitPrompt(page, {
        prompt: 'send should fail after repo selection',
        githubRepositories: ['AmirTlinov/gpt-pro-cli'],
      });
    } catch (caught) {
      error = caught;
    }

    assert.ok(error);
    assert.match(error.message, /Send button not found|Prompt was not submitted/);
    assert.equal(error.githubConnector.cleanup.status, 'ok');
    assert.deepEqual(error.githubConnector.cleanup.cleaned, [{ repository: 'AmirTlinov/gpt-pro-cli', state: 'unselected' }]);
    assert.equal(error.githubConnector.cleanup.removedTool, true);
    assert.equal(await page.locator('#repo').getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('#github-pill').count(), 0);
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

test('ChatGPT temporary request limit fails fast before prompt work', async (t) => {
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
      <div role="dialog" aria-modal="true">
        <h2>Слишком много запросов</h2>
        <p>Вы отправляете запросы слишком часто. Доступ к вашим диалогам временно ограничен в целях защиты данных.</p>
        <p>Подождите несколько минут и повторите попытку.</p>
        <button>Понятно</button>
      </div>
    </main>
  `);

  const blocker = await detectChatGptBlocker(page);
  assert.equal(blocker.code, 'rate_limited');
  await assert.rejects(
    waitForLoggedIn(page, 30_000, { failFastUnauth: true }),
    /temporarily rate-limited|blocker=rate_limited/,
  );
  await assert.rejects(
    submitPrompt(page, { prompt: 'must not be sent' }),
    /temporarily rate-limited|blocker=rate_limited/,
  );
  await browser.close();
});

test('ChatGPT blocker detection ignores ordinary chat text', async (t) => {
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
      <article data-message-author-role="assistant">
        The error text "too many requests" or "captcha" can appear inside a normal review answer.
      </article>
    </main>
  `);

  assert.equal(await detectChatGptBlocker(page), null);
  await browser.close();
});

test('ChatGPT loading interstitial is visible in live blocker status only', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const page = await browser.newPage();
  await page.setContent(`
    <!doctype html>
    <title>Один момент...</title>
    <main>
      <p>Checking your browser before accessing ChatGPT.</p>
    </main>
  `);

  assert.equal(await detectChatGptBlocker(page), null);
  const blocker = await detectChatGptBlocker(page, { includeLoadingInterstitial: true });
  assert.equal(blocker.code, 'loading_interstitial');
  assert.match(blocker.message, /One moment|loading\/protection/);
  await browser.close();
});

test('visible reasoning extraction opens and captures grey thinking summaries', async (t) => {
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
      <button id="thought-button" aria-expanded="false" aria-controls="thought-body" style="color: rgb(140, 140, 140)">Pro думает</button>
      <div id="thought-body" data-testid="reasoning-panel" style="display:none;color: rgb(140, 140, 140)">
        When cleanup fails, it should become a warning and remain visible in receipts.
      </div>
      <script>
        document.querySelector('#thought-button').addEventListener('click', () => {
          const button = document.querySelector('#thought-button');
          const body = document.querySelector('#thought-body');
          const next = button.getAttribute('aria-expanded') !== 'true';
          body.style.display = next ? 'block' : 'none';
          button.setAttribute('aria-expanded', next ? 'true' : 'false');
        });
      </script>
    </main>
  `);

  const reasoning = await extractVisibleReasoning(page);
  assert.match(reasoning, /Pro думает/);
  assert.match(reasoning, /When cleanup fails/);
  assert.equal(await page.locator('#thought-button').getAttribute('aria-expanded'), 'true');

  const second = await extractVisibleReasoning(page);
  assert.match(second, /When cleanup fails/);
  assert.equal(await page.locator('#thought-button').getAttribute('aria-expanded'), 'true');
  await browser.close();
});

test('visible reasoning extraction ignores ordinary grey assistant controls', async (t) => {
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
      <article data-message-author-role="assistant">
        <button style="color: rgb(140, 140, 140)">Скопировать сообщение</button>
        <button style="color: rgb(140, 140, 140)">Поделиться промптом</button>
        <p style="color: rgb(140, 140, 140)">Ordinary grey answer text, not a reasoning panel.</p>
      </article>
    </main>
  `);

  const reasoning = await extractVisibleReasoning(page);
  assert.equal(reasoning, '');
  await browser.close();
});

test('submitPrompt stops if a ChatGPT blocker appears after text entry', async (t) => {
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
      <button data-testid="send-button" onclick="window.sent = (window.sent || 0) + 1">Send</button>
      <div id="modal"></div>
      <script>
        window.sent = 0;
        const prompt = document.querySelector('#prompt-textarea');
        const modal = document.querySelector('#modal');
        new MutationObserver(() => {
          modal.innerHTML = '<div role="dialog" aria-modal="true"><h2>Too many requests</h2><p>Access to your chats is temporarily restricted.</p></div>';
        }).observe(prompt, { childList: true, characterData: true, subtree: true });
      </script>
    </main>
  `);

  await assert.rejects(
    submitPrompt(page, { prompt: 'do not send after blocker appears' }),
    /temporarily rate-limited|blocker=rate_limited/,
  );
  assert.equal(await page.evaluate(() => window.sent), 0);
  await browser.close();
});
