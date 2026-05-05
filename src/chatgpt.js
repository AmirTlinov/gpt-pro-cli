import path from 'node:path';

const COMPOSER_SELECTORS = [
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  'textarea',
];

const SEND_SELECTORS = [
  '[data-testid="send-button"]',
  '#composer-submit-button:not([data-testid="stop-button"])',
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[aria-label*="Отправ"]',
  'button[aria-label*="отправ"]',
  'button:has-text("Send")',
];

const ATTACH_SELECTORS = [
  'button[aria-label*="Attach"]',
  'button[aria-label*="attach"]',
  'button[aria-label*="Upload"]',
  'button[aria-label*="upload"]',
  '[data-testid*="attach"]',
];

const TOOL_MENU_SELECTORS = [
  'button[aria-label*="Add"]',
  'button[aria-label*="add"]',
  'button[aria-label*="Tools"]',
  'button[aria-label*="tools"]',
  'button[aria-label*="Инструмент"]',
  'button[aria-label*="инструмент"]',
  'button:has-text("+")',
  '[data-testid*="composer-plus"]',
  '[data-testid*="tools"]',
];

const GITHUB_REPO_SEARCH_SELECTORS = [
  'input[placeholder*="repo"]',
  'input[placeholder*="Repo"]',
  'input[placeholder*="репозитор"]',
  'input[placeholder*="Репозитор"]',
  'input[placeholder*="Поиск"]',
  'input[type="search"]',
];

const GITHUB_CONNECTOR_LABELS = ['GitHub'];
const MORE_TOOLS_LABELS = ['More', 'Больше'];

const STOP_SELECTORS = [
  '[data-testid="stop-button"]',
  'button[aria-label*="Stop"]',
  'button[aria-label*="stop"]',
  'button[aria-label*="Interrupt"]',
  'button[aria-label*="interrupt"]',
];

const PROJECTS_LABELS = [
  'Projects',
  'Проекты',
];

const NEW_PROJECT_LABELS = [
  'New project',
  'Новый проект',
];

const CREATE_PROJECT_LABELS = [
  'Create project',
  'Создать проект',
];

const OPEN_SIDEBAR_LABELS = [
  'Open sidebar',
  'Открыть боковую панель',
];

function projectKeyFromUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/g\/([^/]+)\//);
    const segment = match?.[1] || '';
    return segment.match(/^(g-p-[a-f0-9]+)(?:-|$)/i)?.[1] || segment;
  } catch {
    return '';
  }
}

function projectSlugFromName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function projectUrlFromCurrentUrl(value, projectName = '') {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/g\/([^/]+)(?:\/|$)/);
    const segment = match?.[1] || '';
    if (!segment) return '';
    const slug = projectSlugFromName(projectName);
    if (projectName && !slug) return '';
    if (slug && !segment.toLowerCase().includes(slug)) return '';
    return `${url.origin}/g/${segment}/project`;
  } catch {
    return '';
  }
}

function isProjectConversationUrl(currentUrl, projectUrl) {
  const key = projectKeyFromUrl(projectUrl);
  if (!key) return false;
  try {
    const current = new URL(currentUrl);
    return current.pathname.includes('/c/') && projectKeyFromUrl(currentUrl) === key;
  } catch {
    return false;
  }
}

async function currentProjectUrl(page, projectName) {
  const bySlug = projectUrlFromCurrentUrl(page.url(), projectName);
  if (bySlug) return bySlug;

  return page.evaluate((wantedName) => {
    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    const match = window.location.pathname.match(/^\/g\/([^/]+)(?:\/|$)/);
    if (!match) return '';
    const wanted = normalized(wantedName);
    const headings = Array.from(document.querySelectorAll('h1,h2,[data-testid*="project"],[aria-label*="project"],[aria-label*="Project"]'));
    const hasName = headings.some((node) => normalized(node.innerText || node.textContent || node.getAttribute('aria-label')) === wanted);
    return hasName ? `${window.location.origin}/g/${match[1]}/project` : '';
  }, projectName);
}

async function clickVisibleControlByText(page, labels) {
  return page.evaluate((wantedLabels) => {
    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function visible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    const wanted = wantedLabels.map(normalized);
    const nodes = Array.from(document.querySelectorAll('button,a,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]'));
    const node = nodes.find((candidate) => {
      if (!visible(candidate)) return false;
      const text = normalized(candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label'));
      return wanted.includes(text);
    });
    if (!node) return false;
    node.click();
    return true;
  }, labels);
}

async function clickVisibleNodeByLineText(page, labels) {
  return page.evaluate((wantedLabels) => {
    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function visible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    const wanted = wantedLabels.map(normalized);
    const actionableSelector = 'button,a,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"]';
    const selectors = [actionableSelector, 'li', 'div'];
    for (const selector of selectors) {
      const node = Array.from(document.querySelectorAll(selector)).find((candidate) => {
        if (!visible(candidate)) return false;
        if (selector === 'div' && candidate.querySelector(`${actionableSelector},li`)) return false;
        const raw = candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label');
        const text = normalized(raw);
        const lines = String(raw || '').split('\n').map(normalized).filter(Boolean);
        return wanted.some((label) => text === label || lines.includes(label));
      });
      if (!node) continue;
      node.scrollIntoView({ block: 'center', inline: 'center' });
      node.click();
      return true;
    }
    return false;
  }, labels);
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const control = page.locator(selector).first();
    try {
      if (await control.count() > 0 && await control.isVisible({ timeout: 500 })) {
        try {
          await control.click({ force: true });
        } catch {
          await control.evaluate((element) => {
            element.scrollIntoView({ block: 'center', inline: 'center' });
            element.click();
          });
        }
        return true;
      }
    } catch {
      // Try the next selector.
    }
  }
  return false;
}

async function fillFirstVisibleInput(page, selectors, value) {
  for (const selector of selectors) {
    const input = page.locator(selector).first();
    try {
      if (await input.count() > 0 && await input.isVisible({ timeout: 500 })) {
        await input.fill(value);
        return true;
      }
    } catch {
      // Try the next selector.
    }
  }
  return false;
}

async function ensureUsableViewport(page) {
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null);
  if (!viewport || viewport.width < 800 || viewport.height < 600) {
    await page.setViewportSize({ width: 1440, height: 1000 }).catch(() => {});
  }
}

async function hasFirstVisible(page, selectors, timeoutMs = 500) {
  for (const selector of selectors) {
    const control = page.locator(selector).first();
    try {
      if (await control.count() > 0 && await control.isVisible({ timeout: timeoutMs })) return true;
    } catch {
      // Try the next selector.
    }
  }
  return false;
}

async function isGitHubConnectorActive(page) {
  return page.evaluate(() => {
    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function visible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    const roots = Array.from(document.querySelectorAll('[data-testid="composer-footer-actions"], form'));
    for (const root of roots) {
      const nodes = Array.from(root.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],div'));
      for (const node of nodes) {
        if (!visible(node)) continue;
        const text = normalized(node.innerText || node.textContent);
        const aria = normalized(node.getAttribute('aria-label'));
        if (text === 'github' || aria === 'github' || aria.startsWith('github,')) return true;
      }
    }
    return false;
  });
}

async function openGitHubConnector(page) {
  const clickGitHub = async () => (
    await clickVisibleControlByText(page, GITHUB_CONNECTOR_LABELS)
    || await clickVisibleNodeByLineText(page, GITHUB_CONNECTOR_LABELS)
  );

  if (await clickGitHub()) {
    await page.waitForTimeout(500);
    return true;
  }

  if (await clickFirstVisible(page, TOOL_MENU_SELECTORS)) {
    await page.waitForTimeout(500);
    if (await clickGitHub()) {
      await page.waitForTimeout(500);
      return true;
    }
    if (await clickVisibleNodeByLineText(page, MORE_TOOLS_LABELS)) {
      await page.waitForTimeout(500);
      if (await clickGitHub()) {
        await page.waitForTimeout(500);
        return true;
      }
    }
    if (await clickVisibleNodeByLineText(page, GITHUB_CONNECTOR_LABELS)) {
      await page.waitForTimeout(500);
      return true;
    }
  }

  return false;
}

async function selectGitHubRepository(page, repository, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let searched = false;
  while (Date.now() < deadline) {
    if (await clickVisibleNodeByLineText(page, [repository])) return true;
    if (!searched && await fillFirstVisibleInput(page, GITHUB_REPO_SEARCH_SELECTORS, repository)) {
      searched = true;
      await page.waitForTimeout(700);
      continue;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

export async function attachGitHubRepositories(page, repositories = []) {
  const requested = [...new Set((repositories || []).map((repo) => String(repo || '').trim()).filter(Boolean))];
  if (requested.length === 0) return { requested: [], selected: [] };

  const selected = [];
  let toolSelected = false;
  let promptScoped = false;
  for (const repository of requested) {
    if (!await openGitHubConnector(page)) {
      throw new Error('ChatGPT GitHub connector control was not found. Configure/connect GitHub in ChatGPT, then retry.');
    }
    toolSelected = await isGitHubConnectorActive(page) || toolSelected;
    if (await clickVisibleNodeByLineText(page, [repository])) {
      selected.push(repository);
      toolSelected = true;
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
      continue;
    }
    if (toolSelected && !await hasFirstVisible(page, GITHUB_REPO_SEARCH_SELECTORS, 1500)) {
      promptScoped = true;
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
      continue;
    }
    if (!await selectGitHubRepository(page, repository)) {
      toolSelected = await isGitHubConnectorActive(page) || toolSelected;
      if (toolSelected) {
        promptScoped = true;
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(250);
        continue;
      }
      throw new Error(`GitHub repository "${repository}" was not found in the ChatGPT connector. Check that it is indexed and visible in ChatGPT.`);
    }
    selected.push(repository);
    toolSelected = true;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }

  return {
    requested,
    selected,
    toolSelected,
    repositorySelection: promptScoped
      ? selected.length > 0 ? 'mixed' : 'prompt-scoped'
      : 'repo-picker',
  };
}

export async function findProjectUrl(page, projectName) {
  return page.evaluate((wantedName) => {
    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function visible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    const wanted = normalized(wantedName);
    for (const anchor of document.querySelectorAll('a[href*="/project"]')) {
      if (!visible(anchor)) continue;
      const text = normalized(anchor.innerText || anchor.textContent);
      if (text === wanted) return anchor.href;
    }
    return '';
  }, projectName);
}

async function hasVisibleNewProjectControl(page) {
  return page.evaluate((labels) => {
    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function visible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    const wanted = labels.map(normalized);
    return Array.from(document.querySelectorAll('button,a,[role="button"]')).some((node) => {
      if (!visible(node)) return false;
      const text = normalized(node.innerText || node.textContent || node.getAttribute('aria-label'));
      return wanted.includes(text);
    });
  }, NEW_PROJECT_LABELS);
}

async function ensureProjectControlsVisible(page, projectName) {
  if (await findProjectUrl(page, projectName)) return;
  if (await hasVisibleNewProjectControl(page)) return;

  if (await clickVisibleControlByText(page, OPEN_SIDEBAR_LABELS)) {
    await page.waitForTimeout(500);
    if (await findProjectUrl(page, projectName) || await hasVisibleNewProjectControl(page)) return;
  }

  if (await clickVisibleControlByText(page, PROJECTS_LABELS)) {
    await page.waitForTimeout(500);
  }
}

async function clickCreateProject(page) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((labels) => {
      function normalized(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      }

      function visible(node) {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }

      const wanted = labels.map(normalized);
      const buttons = Array.from(document.querySelectorAll('button'));
      const button = buttons.find((candidate) => {
        if (!visible(candidate) || candidate.disabled) return false;
        if (candidate.getAttribute('type') === 'submit') return true;
        const text = normalized(candidate.innerText || candidate.textContent);
        return wanted.includes(text);
      });
      if (!button) return false;
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return true;
    }, CREATE_PROJECT_LABELS);
    if (clicked) return;
    await page.waitForTimeout(250);
  }
  throw new Error('Create project button did not become enabled');
}

async function createProject(page, projectName) {
  if (!await clickVisibleControlByText(page, NEW_PROJECT_LABELS)) {
    throw new Error('ChatGPT "New project" control was not found');
  }

  const nameInput = page.locator('input[name="projectName"], #project-name').first();
  await nameInput.waitFor({ state: 'visible', timeout: 10_000 });
  await nameInput.fill(projectName);
  await clickCreateProject(page);

  await page.waitForURL((url) => /\/g\/[^/]+\/project/.test(url.pathname), { timeout: 30_000 }).catch(() => {});
  const projectUrl = /\/g\/[^/]+\/project/.test(new URL(page.url()).pathname)
    ? page.url()
    : await findProjectUrl(page, projectName);
  if (!projectUrl) throw new Error(`Project "${projectName}" was not created or found after submit`);
  if (page.url() !== projectUrl) {
    await page.goto(projectUrl, { waitUntil: 'domcontentloaded' });
  }
  await waitForComposer(page, 60_000);
  return {
    created: true,
    projectName,
    projectUrl: page.url(),
  };
}

export async function openOrCreateProject(page, { projectName, baseUrl, timeoutMs = 60_000, keepCurrent = false, projectUrlHint = '' }) {
  if (!projectName) return null;

  if (!/^https?:\/\//.test(page.url())) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  }
  await waitForLoggedIn(page, timeoutMs, { failFastUnauth: true });

  if (projectUrlHint && /^https?:\/\//.test(projectUrlHint) && !keepCurrent) {
    await page.goto(projectUrlHint, { waitUntil: 'domcontentloaded' });
    await waitForLoggedIn(page, timeoutMs, { failFastUnauth: true });
    const hintedCurrentUrl = await currentProjectUrl(page, projectName);
    if (hintedCurrentUrl) {
      await waitForComposer(page, 60_000);
      return {
        created: false,
        keptCurrent: false,
        projectName,
        projectUrl: hintedCurrentUrl,
        source: 'cache',
      };
    }
  }

  const currentUrl = await currentProjectUrl(page, projectName);
  if (currentUrl) {
    if (keepCurrent && isProjectConversationUrl(page.url(), currentUrl)) {
      await waitForComposer(page, 60_000);
      return {
        created: false,
        keptCurrent: true,
        projectName,
        projectUrl: currentUrl,
      };
    }
    if (page.url() !== currentUrl) {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded' });
      await waitForLoggedIn(page, timeoutMs, { failFastUnauth: true });
    }
    await waitForComposer(page, 60_000);
    return {
      created: false,
      keptCurrent: false,
      projectName,
      projectUrl: page.url(),
    };
  }

  await ensureProjectControlsVisible(page, projectName);

  let projectUrl = await findProjectUrl(page, projectName);
  if (!projectUrl) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForLoggedIn(page, timeoutMs, { failFastUnauth: true });
    await ensureProjectControlsVisible(page, projectName);
    projectUrl = await findProjectUrl(page, projectName);
  }

  if (!projectUrl) return createProject(page, projectName);

  if (keepCurrent && isProjectConversationUrl(page.url(), projectUrl)) {
    await waitForComposer(page, 60_000);
    return {
      created: false,
      keptCurrent: true,
      projectName,
      projectUrl,
    };
  }

  await page.goto(projectUrl, { waitUntil: 'domcontentloaded' });
  await waitForLoggedIn(page, timeoutMs, { failFastUnauth: true });
  await waitForComposer(page, 60_000);
  return {
    created: false,
    keptCurrent: false,
    projectName,
    projectUrl: page.url(),
  };
}

export async function waitForComposer(page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    for (const selector of COMPOSER_SELECTORS) {
      try {
        const matches = page.locator(selector);
        const count = Math.min(await matches.count(), 10);
        for (let index = 0; index < count; index += 1) {
          const locator = matches.nth(index);
          const box = await locator.boundingBox({ timeout: 500 }).catch(() => null);
          if (box && box.width > 0 && box.height > 0 && await locator.isVisible({ timeout: 500 })) {
            return locator;
          }
        }
      } catch (error) {
        lastError = error;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`ChatGPT composer was not found${lastError ? `: ${lastError.message}` : ''}`);
}

export async function isLoggedIn(page) {
  const snapshot = await authSnapshot(page);
  return snapshot.loggedIn;
}

export async function authSnapshot(page) {
  if (/\/auth\/login/.test(page.url())) {
    return {
      loggedIn: false,
      hasComposer: false,
      hasUnauthAction: true,
      url: page.url(),
      unauthActions: ['login-url'],
    };
  }
  const hasComposer = await hasVisibleComposer(page);
  const unauthActions = await visibleUnauthActions(page);
  return {
    loggedIn: hasComposer && unauthActions.length === 0,
    hasComposer,
    hasUnauthAction: unauthActions.length > 0,
    url: page.url(),
    unauthActions,
  };
}

async function hasVisibleComposer(page) {
  for (const selector of COMPOSER_SELECTORS) {
    try {
      const matches = page.locator(selector);
      const count = Math.min(await matches.count(), 10);
      for (let index = 0; index < count; index += 1) {
        const locator = matches.nth(index);
        const box = await locator.boundingBox({ timeout: 250 }).catch(() => null);
        if (box && box.width > 0 && box.height > 0 && await locator.isVisible({ timeout: 250 })) {
          return true;
        }
      }
    } catch {
      // Keep probing other selectors.
    }
  }
  return false;
}

async function visibleUnauthActions(page) {
  return page.evaluate(() => {
    const labels = [
      'log in',
      'login',
      'sign in',
      'sign up',
      'get started',
      'войти',
      'регистрация',
      'зарегистрироваться',
    ];
    function visible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }
    return Array.from(document.querySelectorAll('a,button,[role="button"]'))
      .filter(visible)
      .map((node) => (node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim())
      .filter(Boolean)
      .filter((text, index, all) => all.indexOf(text) === index)
      .filter((text) => {
        const lower = text.toLowerCase();
        return labels.some((label) => lower === label || lower.includes(label));
      });
  });
}

export async function waitForLoggedIn(page, timeoutMs = 10 * 60_000, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    lastSnapshot = await authSnapshot(page);
    if (lastSnapshot.loggedIn) return true;
    if (options.failFastUnauth && lastSnapshot.hasUnauthAction) {
      throw new Error(`ChatGPT profile is not logged in. Run "gpt-pro login" first. url=${lastSnapshot.url}; visible auth actions=${lastSnapshot.unauthActions.join(', ')}`);
    }
    await page.waitForTimeout(1000);
  }
  const detail = lastSnapshot
    ? ` url=${lastSnapshot.url}; composer=${lastSnapshot.hasComposer}; auth actions=${lastSnapshot.unauthActions.join(', ') || 'none'}`
    : '';
  throw new Error(`Timed out waiting for ChatGPT login.${detail}`);
}

async function setComposerText(page, locator, text) {
  try {
    await locator.evaluate((element, value) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      element.focus();
    }, text);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(text);
    const inserted = await locator.evaluate((element) => (element.innerText || element.textContent || element.value || '').trim());
    if (inserted.includes(text.slice(0, 50))) return;
    throw new Error('keyboard insert did not update composer');
  } catch {
    await locator.evaluate((element, value) => {
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }, text);
  }
}

export async function attachFile(page, attachmentPath) {
  if (!attachmentPath) return;
  const directInput = page.locator('input[type="file"]').first();
  if (await directInput.count() > 0) {
    await directInput.setInputFiles(attachmentPath);
    return;
  }

  for (const selector of ATTACH_SELECTORS) {
    const button = page.locator(selector).first();
    if (await button.count() === 0) continue;
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      button.click(),
    ]);
    await chooser.setFiles(attachmentPath);
    return;
  }
  throw new Error('No ChatGPT file attachment control was found');
}

export async function clickSend(page) {
  for (const selector of SEND_SELECTORS) {
    const button = page.locator(selector).first();
    try {
      if (await button.count() > 0 && await button.isEnabled({ timeout: 1000 })) {
        await button.click({ force: true });
        return;
      }
    } catch {
      // Try the next selector, then fall back to keyboard.
    }
  }
  await page.keyboard.press('Enter');
}

export async function waitForUserPromptVisible(page, prompt, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const expected = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  while (Date.now() < deadline) {
    if (await isUserPromptVisible(page, expected)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function isUserPromptVisible(page, expected) {
  return page.evaluate((value) => {
    const normalized = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const compact = (text) => normalized(text).replace(/\s+/g, '');
    const wanted = normalized(value);
    const wantedCompact = compact(value);
    return Array.from(document.querySelectorAll('[data-message-author-role="user"],[data-testid="user-message"],[data-gpt-pro-user]'))
      .some((node) => {
        const text = node.innerText || node.textContent;
        return normalized(text).includes(wanted) || compact(text).includes(wantedCompact);
      });
  }, expected);
}

async function composerText(locator) {
  return locator.evaluate((element) => (element.innerText || element.textContent || element.value || '').replace(/\s+/g, ' ').trim());
}

async function waitForPromptAccepted(page, composer, prompt, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const expected = String(prompt || '').replace(/\s+/g, ' ').trim();
  const probe = expected.slice(0, 200);
  const shortProbe = expected.slice(0, 50);
  const shortProbeCompact = shortProbe.replace(/\s+/g, '');
  while (Date.now() < deadline) {
    if (await isUserPromptVisible(page, probe)) return true;
    if (await isGenerating(page)) return true;
    const current = await composerText(composer).catch(() => '');
    if (shortProbe && !current.includes(shortProbe) && !current.replace(/\s+/g, '').includes(shortProbeCompact)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

export async function submitPrompt(page, { prompt, attachmentPath, githubRepositories = [] }) {
  await ensureUsableViewport(page);
  let composer = await waitForComposer(page);
  await composer.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.focus();
  });
  let githubConnector = { requested: githubRepositories, selected: [] };
  try {
    githubConnector = await attachGitHubRepositories(page, githubRepositories);
  } catch (error) {
    githubConnector = {
      requested: githubRepositories,
      selected: [],
      uiSelection: 'unavailable',
      error: error.message,
      promptRequirement: 'sent',
    };
  }
  composer = await waitForComposer(page);
  await setComposerText(page, composer, prompt);
  await page.waitForTimeout(500);
  if (attachmentPath) {
    await attachFile(page, attachmentPath);
    await page.waitForTimeout(1000);
  }
  await clickSend(page);
  if (!await waitForPromptAccepted(page, composer, prompt, 5000)) {
    await composer.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      element.focus();
    }).catch(() => {});
    await page.keyboard.press('Enter');
    if (!await waitForPromptAccepted(page, composer, prompt, 5000)) {
      await clickSend(page);
      if (!await waitForPromptAccepted(page, composer, prompt, 5000)) {
        throw new Error('Prompt was not submitted to ChatGPT');
      }
    }
  }
  return { githubConnector };
}

export async function extractLatestAnswer(page) {
  return page.evaluate(() => {
    function visibleText(node) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      return (node.innerText || node.textContent || '').trim();
    }

    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid="assistant-message"]',
      '[data-gpt-pro-answer]',
      'article',
    ];
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const texts = nodes.map(visibleText).filter(Boolean);
      if (texts.length > 0) return texts[texts.length - 1];
    }
    return '';
  });
}

export async function extractLatestAnswerAfterPrompt(page, prompt) {
  return page.evaluate((expectedPrompt) => {
    function visibleText(node) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      return (node.innerText || node.textContent || '').trim();
    }

    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function compact(value) {
      return normalized(value).replace(/\s+/g, '');
    }

    const expected = normalized(expectedPrompt).slice(0, 200);
    const expectedCompact = compact(expectedPrompt).slice(0, 200);
    const userSelectors = [
      '[data-message-author-role="user"]',
      '[data-testid="user-message"]',
      '[data-gpt-pro-user]',
    ];
    const assistantSelectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid="assistant-message"]',
      '[data-gpt-pro-answer]',
      'article',
    ];

    const userNodes = userSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const matchingUsers = userNodes.filter((node) => {
      const text = visibleText(node);
      return normalized(text).includes(expected) || compact(text).includes(expectedCompact);
    });
    const anchor = matchingUsers[matchingUsers.length - 1];
    if (!anchor) return '';

    const assistantNodes = assistantSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const seen = new Set();
    const texts = [];
    for (const node of assistantNodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (!(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const text = visibleText(node);
      if (text) texts.push(text);
    }
    return texts[texts.length - 1] || '';
  }, prompt);
}

export async function assistantMessageCount(page) {
  return page.evaluate(() => {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid="assistant-message"]',
      '[data-gpt-pro-answer]',
      'article',
    ];
    const seen = new Set();
    let count = 0;
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        seen.add(node);
        const text = (node.innerText || node.textContent || '').trim();
        if (text) count += 1;
      }
    }
    return count;
  });
}

export async function extractVisibleReasoning(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll([
      '[data-gpt-pro-reasoning]',
      '[data-testid*="reasoning"]',
      '[class*="reasoning"]',
      'details',
    ].join(',')));
    return nodes
      .map((node) => (node.innerText || node.textContent || '').trim())
      .filter(Boolean)
      .join('\n\n');
  });
}

export async function extractLinks(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
    .map((link) => link.href)
    .filter(Boolean));
}

export async function isGenerating(page) {
  for (const selector of STOP_SELECTORS) {
    const button = page.locator(selector).first();
    try {
      if (await button.count() > 0 && await button.isVisible({ timeout: 250 })) {
        return true;
      }
    } catch {
      // Keep probing.
    }
  }
  return false;
}

export async function waitForAnswerStable(page, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let stableTicks = 0;
  let lastGenerating = false;
  const baselineAssistantCount = Number.isInteger(options.previousAssistantCount)
    ? options.previousAssistantCount
    : null;
  while (Date.now() < deadline) {
    const answer = options.prompt
      ? await extractLatestAnswerAfterPrompt(page, options.prompt)
      : await extractLatestAnswer(page);
    const generating = await isGenerating(page);
    const assistantCount = options.prompt ? null : await assistantMessageCount(page).catch(() => null);
    const isFresh = options.prompt
      ? Boolean(answer)
      : Boolean(answer) && (
        !options.previousAnswer
        || answer !== options.previousAnswer
        || (Number.isInteger(assistantCount) && Number.isInteger(baselineAssistantCount) && assistantCount > baselineAssistantCount)
      );
    lastGenerating = generating;
    if (answer && isFresh && answer === last && !generating) {
      stableTicks += 1;
      if (stableTicks >= 3) return answer;
    } else {
      stableTicks = 0;
      last = answer;
    }
    await page.waitForTimeout(1000);
  }
  if (last && !lastGenerating) return last;
  if (last && lastGenerating) {
    throw new Error('Timed out waiting for a complete ChatGPT answer; generation was still running, so the partial answer was discarded');
  }
  throw new Error('Timed out waiting for a ChatGPT answer');
}

export async function scrapeSessions(page, projectUrl = '') {
  const projectKey = projectKeyFromUrl(projectUrl || page.url());
  return page.evaluate((targetProjectKey) => {
    function projectKeyFromUrl(value) {
      try {
        const url = new URL(value);
        const match = url.pathname.match(/^\/g\/([^/]+)\//);
        const segment = match?.[1] || '';
        return segment.match(/^(g-p-[a-f0-9]+)(?:-|$)/i)?.[1] || segment;
      } catch {
        return '';
      }
    }

    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/c/"]'))
      .map((anchor) => {
        const title = (anchor.innerText || anchor.textContent || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)[0] || anchor.getAttribute('aria-label') || 'Untitled';
        const id = String(anchor.href || '').match(/\/c\/([a-zA-Z0-9-]+)/)?.[1] || '';
        return {
          title: title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled',
          id,
          shortId: id.slice(0, 8),
          url: anchor.href,
        };
      })
      .filter((item) => {
        if (!item.url || seen.has(item.url)) return false;
        if (targetProjectKey) {
          if (projectKeyFromUrl(item.url) !== targetProjectKey) return false;
        }
        seen.add(item.url);
        return true;
      });
  }, projectKey);
}

export function downloadTarget(downloadDir, suggestedFilename) {
  const clean = path.basename(suggestedFilename || `download-${Date.now()}`);
  return path.join(downloadDir, clean);
}
