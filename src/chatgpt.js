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
const MORE_TOOLS_LABELS = ['More', 'Больше', 'Ещё', 'Еще'];
const GITHUB_CONNECTOR_OPEN_ATTEMPTS = 2;

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

async function clickVisibleControlByTextWithPointer(page, labels) {
  function normalized(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  const baseSelectors = [
    'button',
    '[role="button"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    'a',
    'div',
  ];
  for (const label of labels) {
    for (const base of baseSelectors) {
      const selector = `${base}:has-text(${JSON.stringify(label)})`;
      const matches = page.locator(selector);
      const count = Math.min(await matches.count().catch(() => 0), 20);
      for (let index = count - 1; index >= 0; index -= 1) {
        const locator = matches.nth(index);
        try {
          if (!await locator.isVisible({ timeout: 250 })) continue;
          const raw = await locator.evaluate((node) => node.innerText || node.textContent || node.getAttribute('aria-label') || '');
          const text = normalized(raw);
          const lines = String(raw || '').split('\n').map(normalized).filter(Boolean);
          if (text !== label && !lines.includes(label)) continue;
          await locator.click({ force: true });
          return true;
        } catch {
          // Try the next candidate.
        }
      }
    }
  }
  return false;
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
    const matches = page.locator(selector);
    try {
      const count = Math.min(await matches.count(), 25);
      for (let index = 0; index < count; index += 1) {
        const input = matches.nth(index);
        if (await input.isVisible({ timeout: 200 })) {
          await input.fill(value);
          return true;
        }
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
    const matches = page.locator(selector);
    try {
      const count = Math.min(await matches.count(), 25);
      for (let index = 0; index < count; index += 1) {
        if (await matches.nth(index).isVisible({ timeout: Math.min(timeoutMs, 250) })) return true;
      }
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

async function removeGitHubConnectorTool(page) {
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
      const buttons = Array.from(root.querySelectorAll('button,[role="button"]'));
      const button = buttons.find((candidate) => {
        if (!visible(candidate)) return false;
        const aria = normalized(candidate.getAttribute('aria-label'));
        return aria.includes('github') && (aria.includes('remove') || aria.includes('удал'));
      });
      if (!button) continue;
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return true;
    }
    return false;
  });
}

async function openGitHubConnector(page, { timeoutMs = 5_000 } = {}) {
  if (await hasFirstVisible(page, GITHUB_REPO_SEARCH_SELECTORS, 300)) return true;

  const openPickerFromActivePill = async () => {
    const selectors = [
      '[data-testid="composer-footer-actions"] button.__composer-pill:has-text("GitHub")',
      'button.__composer-pill:has-text("GitHub")',
      '[data-testid="composer-footer-actions"] button:has-text("GitHub")',
    ];
    for (const selector of selectors) {
      const matches = page.locator(selector);
      const count = Math.min(await matches.count().catch(() => 0), 5);
      for (let index = count - 1; index >= 0; index -= 1) {
        const button = matches.nth(index);
        try {
          if (!await button.isVisible({ timeout: 250 })) continue;
          const aria = String(await button.getAttribute('aria-label').catch(() => '') || '').toLowerCase();
          if (aria.includes('remove') || aria.includes('удал')) continue;
          await button.click({ force: true });
          return true;
        } catch {
          // Try the next candidate.
        }
      }
    }
    return false;
  };

  const ensurePicker = async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await hasFirstVisible(page, GITHUB_REPO_SEARCH_SELECTORS, 700)) return true;
      if (await openPickerFromActivePill()) {
        await page.waitForTimeout(700);
        if (await hasFirstVisible(page, GITHUB_REPO_SEARCH_SELECTORS, 700)) return true;
      }
      await page.waitForTimeout(250);
    }
    return false;
  };

  const clickGitHub = async () => (
    await clickVisibleControlByTextWithPointer(page, GITHUB_CONNECTOR_LABELS)
    || await clickVisibleControlByText(page, GITHUB_CONNECTOR_LABELS)
    || await clickVisibleNodeByLineText(page, GITHUB_CONNECTOR_LABELS)
  );

  if (await clickGitHub()) {
    await page.waitForTimeout(500);
    return ensurePicker();
  }

  if (await clickFirstVisible(page, TOOL_MENU_SELECTORS)) {
    await page.waitForTimeout(500);
    if (await clickGitHub()) {
      await page.waitForTimeout(500);
      return ensurePicker();
    }
    if (await clickVisibleControlByTextWithPointer(page, MORE_TOOLS_LABELS) || await clickVisibleNodeByLineText(page, MORE_TOOLS_LABELS)) {
      await page.waitForTimeout(500);
      if (await clickGitHub()) {
        await page.waitForTimeout(500);
        return ensurePicker();
      }
    }
    if (await clickVisibleNodeByLineText(page, GITHUB_CONNECTOR_LABELS)) {
      await page.waitForTimeout(500);
      return ensurePicker();
    }
  }

  return ensurePicker();
}

async function resetComposerForGitHubRetry(page) {
  if (!await hasFirstVisible(page, GITHUB_REPO_SEARCH_SELECTORS, 150)) {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(250);
  const composer = await waitForComposer(page, 1000).catch(() => null);
  if (composer) {
    await composer.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      element.focus();
    }).catch(() => {});
  }
}

async function openGitHubConnectorWithRecovery(page, {
  toolPreexisting = false,
  toolSelected = false,
  attempts = GITHUB_CONNECTOR_OPEN_ATTEMPTS,
} = {}) {
  let active = toolSelected;
  let resetOwnedTool = false;
  let lastError = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await resetComposerForGitHubRetry(page);
    const opened = await openGitHubConnector(page, {
      timeoutMs: attempt === 1 ? 5_000 : 7_000,
    }).catch((error) => {
      lastError = error.message;
      return false;
    });
    active = await isGitHubConnectorActive(page).catch(() => active);
    if (opened && await hasFirstVisible(page, GITHUB_REPO_SEARCH_SELECTORS, 1500)) {
      return {
        opened: true,
        toolSelected: active,
        resetOwnedTool,
        attempts: attempt,
      };
    }

    // If this run only managed to create a tool-only GitHub pill, do not accept
    // that as progress. Remove our own dirty state and retry the real picker.
    // Never remove a preexisting GitHub pill: it may carry the user's selected
    // repos, and the picker must be opened without disturbing that state.
    if (!toolPreexisting && active) {
      if (await removeGitHubConnectorTool(page).catch(() => false)) {
        resetOwnedTool = true;
        await page.waitForTimeout(500);
        active = await isGitHubConnectorActive(page).catch(() => false);
      }
    }
    await closeGitHubConnectorPicker(page);
    await page.waitForTimeout(500);
  }

  return {
    opened: false,
    toolSelected: active,
    resetOwnedTool,
    attempts,
    error: lastError,
  };
}

async function githubRepositoryRowOperation(page, repository, operation = 'state') {
  return page.evaluate(({ repository: wantedRepository, operation: wantedOperation }) => {
    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function visible(node) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    }

    function depth(node) {
      let current = node;
      let value = 0;
      while (current?.parentElement) {
        value += 1;
        current = current.parentElement;
      }
      return value;
    }

    function textFor(node) {
      return normalized(node.innerText || node.textContent || node.getAttribute('aria-label') || '');
    }

    function matchesRepository(node, repository) {
      const wanted = normalized(repository);
      const raw = node.innerText || node.textContent || node.getAttribute('aria-label') || '';
      const text = normalized(raw);
      const lines = String(raw || '').split('\n').map(normalized).filter(Boolean);
      const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const bounded = new RegExp(`(^|\\s)${escaped}(\\s|$)`);
      return text === wanted || lines.includes(wanted) || bounded.test(text);
    }

    function candidateScore(node, repository) {
      const tag = node.tagName.toLowerCase();
      const role = String(node.getAttribute('role') || '').toLowerCase();
      const actionable = tag === 'button'
        || tag === 'label'
        || ['button', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'checkbox'].includes(role);
      const raw = node.innerText || node.textContent || node.getAttribute('aria-label') || '';
      const text = normalized(raw);
      const lines = String(raw || '').split('\n').map(normalized).filter(Boolean);
      const exact = text === repository || lines.includes(repository);
      const rect = node.getBoundingClientRect();
      return {
        exact: exact ? 0 : 1,
        actionable: actionable ? 0 : 1,
        length: text.length,
        area: Math.max(1, Math.round(rect.width * rect.height)),
        depth: -depth(node),
      };
    }

    function checkedSignalFromAttributes(node) {
      const ariaChecked = node.getAttribute('aria-checked');
      if (ariaChecked === 'true') return { checked: true, source: 'aria-checked' };
      if (ariaChecked === 'false') return { checked: false, source: 'aria-checked' };

      const ariaSelected = node.getAttribute('aria-selected');
      if (ariaSelected === 'true') return { checked: true, source: 'aria-selected' };
      if (ariaSelected === 'false') return { checked: false, source: 'aria-selected' };

      const selected = node.getAttribute('data-selected') || node.getAttribute('data-checked');
      if (selected === 'true') return { checked: true, source: 'data-selected' };
      if (selected === 'false') return { checked: false, source: 'data-selected' };

      const state = String(node.getAttribute('data-state') || '').toLowerCase();
      if (['checked', 'on', 'selected', 'active'].includes(state)) return { checked: true, source: 'data-state' };
      if (['unchecked', 'off', 'unselected', 'inactive'].includes(state)) return { checked: false, source: 'data-state' };

      if (node instanceof HTMLOptionElement) return { checked: node.selected, source: 'option-selected' };

      return null;
    }

    function checkedSignal(row) {
      const input = row.matches('input[type="checkbox"],input[type="radio"]')
        ? row
        : row.querySelector('input[type="checkbox"],input[type="radio"]');
      if (input) return { checked: Boolean(input.checked), source: 'input-checked' };

      const chain = [];
      let current = row;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        chain.push(current);
        const role = String(current.getAttribute('role') || '').toLowerCase();
        if (['dialog', 'menu', 'listbox'].includes(role)) break;
        current = current.parentElement;
      }
      for (const node of chain) {
        const signal = checkedSignalFromAttributes(node);
        if (signal) return signal;
      }

      const descendants = Array.from(row.querySelectorAll('*')).filter(visible);
      for (const node of descendants) {
        const signal = checkedSignalFromAttributes(node);
        if (signal?.checked === true) return signal;
      }

      const trailingIcon = Array.from(row.querySelectorAll('.trailing svg, .trailing use, [class*="trailing"] svg, [class*="trailing"] use'))
        .some((node) => visible(node));
      if (trailingIcon) return { checked: true, source: 'trailing-selected-icon' };

      const visibleText = textFor(row);
      if (/^[✓✔☑]\s*/.test(visibleText) || /\b(selected|checked|выбран|выбрано|отмечен|добавлен)\b/i.test(visibleText)) {
        return { checked: true, source: 'visible-selected-text' };
      }

      const role = String(row.getAttribute('role') || '').toLowerCase();
      if (['menuitem', 'menuitemradio', 'menuitemcheckbox', 'option'].includes(role)) {
        return { checked: false, source: 'no-selected-marker' };
      }

      return { checked: null, source: 'unknown' };
    }

    function findRow(repository) {
      function searchInputLike(node) {
        const placeholder = normalized(node.getAttribute('placeholder')).toLowerCase();
        const type = normalized(node.getAttribute('type')).toLowerCase();
        return type === 'search'
          || placeholder.includes('repo')
          || placeholder.includes('репозитор')
          || placeholder.includes('поиск');
      }

      function pickerRoots() {
        const inputs = Array.from(document.querySelectorAll('input'))
          .filter((node) => visible(node) && searchInputLike(node));
        const roots = inputs
          .map((input) => input.closest('[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]') || input.parentElement)
          .filter(Boolean);
        return roots.filter((root, index, all) => all.indexOf(root) === index);
      }

      const selectors = [
        'button',
        'label',
        '[role="button"]',
        '[role="menuitem"]',
        '[role="menuitemradio"]',
        '[role="menuitemcheckbox"]',
        '[role="option"]',
        '[role="checkbox"]',
        'li',
        'div',
      ].join(',');
      const roots = pickerRoots();
      if (roots.length === 0) return null;
      const nodes = roots.flatMap((root) => Array.from(root.querySelectorAll(selectors)))
        .filter((node) => visible(node) && matchesRepository(node, repository));
      nodes.sort((a, b) => {
        const left = candidateScore(a, repository);
        const right = candidateScore(b, repository);
        return left.exact - right.exact
          || left.actionable - right.actionable
          || left.length - right.length
          || left.area - right.area
          || left.depth - right.depth;
      });
      return nodes[0] || null;
    }

    const row = findRow(wantedRepository);
    if (!row) {
      return {
        found: false,
        repository: wantedRepository,
        checked: null,
        checkedSource: 'not-found',
      };
    }

    const before = checkedSignal(row);
    if (wantedOperation === 'click') {
      row.scrollIntoView({ block: 'center', inline: 'center' });
      row.click();
    }

    return {
      found: true,
      repository: wantedRepository,
      checked: before.checked,
      checkedSource: before.source,
      text: textFor(row).slice(0, 300),
      role: row.getAttribute('role') || '',
      tag: row.tagName.toLowerCase(),
    };
  }, { repository, operation });
}

async function searchGitHubRepository(page, repository) {
  return fillFirstVisibleInput(page, GITHUB_REPO_SEARCH_SELECTORS, repository);
}

async function closeGitHubConnectorPicker(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250);
}

async function selectGitHubRepository(page, repository, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let searched = false;
  while (Date.now() < deadline) {
    const row = await githubRepositoryRowOperation(page, repository, 'state');
    if (row.found) {
      if (row.checked === true) {
        return {
          repository,
          selected: true,
          state: 'preexisting',
          searched,
          checkedSource: row.checkedSource,
        };
      }
      if (!searched && await searchGitHubRepository(page, repository)) {
        searched = true;
        await page.waitForTimeout(700);
        continue;
      }
      if (row.checked === false) {
        await githubRepositoryRowOperation(page, repository, 'click');
        await page.waitForTimeout(500);
        const after = await githubRepositoryRowOperation(page, repository, 'state');
        if (after.found && after.checked === true) {
          return {
            repository,
            selected: true,
            state: 'temporary-selected',
            searched,
            checkedSource: after.checkedSource,
          };
        }
        throw new Error(`GitHub repository "${repository}" was clicked but did not become checked in the ChatGPT connector.`);
      }
      throw new Error(`GitHub repository "${repository}" is visible, but its checked state could not be determined safely.`);
    }

    if (!searched && await searchGitHubRepository(page, repository)) {
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

  const composer = await waitForComposer(page, 1000).catch(() => null);
  if (composer) {
    await composer.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      element.focus();
    }).catch(() => {});
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(100);
  const selected = [];
  const repositoryStates = [];
  const toolPreexisting = await isGitHubConnectorActive(page).catch(() => false);
  let toolSelected = toolPreexisting;
  let recoveryResetOwnedTool = false;
  let pickerOpenAttempts = 0;

  const connectorState = () => ({
    requested,
    selected,
    toolSelected,
    toolPreexisting,
    toolActivatedByRun: !toolPreexisting && toolSelected,
    recovery: {
      resetOwnedTool: recoveryResetOwnedTool,
      pickerOpenAttempts,
    },
    repositorySelection: selected.length === requested.length ? 'repo-picker' : 'partial',
    repositories: repositoryStates,
    cleanupRequired: repositoryStates
      .filter((item) => item.state === 'temporary-selected')
      .map((item) => item.repository),
    cleanup: {
      attempted: recoveryResetOwnedTool,
      status: repositoryStates.some((item) => item.state === 'temporary-selected') ? 'pending' : (recoveryResetOwnedTool ? 'ok' : 'not-needed'),
      cleaned: [],
      removedTool: recoveryResetOwnedTool,
      skipped: repositoryStates
        .filter((item) => item.state === 'preexisting')
        .map((item) => ({ repository: item.repository, reason: 'preexisting' })),
      errors: [],
    },
  });

  try {
    for (const repository of requested) {
      const opened = await openGitHubConnectorWithRecovery(page, { toolPreexisting, toolSelected });
      pickerOpenAttempts += opened.attempts || 0;
      recoveryResetOwnedTool = recoveryResetOwnedTool || Boolean(opened.resetOwnedTool);
      toolSelected = Boolean(opened.toolSelected);
      if (!opened.opened) {
        const detail = opened.error ? ` Last error: ${opened.error}` : '';
        throw new Error(`ChatGPT GitHub connector repository picker was not opened after ${opened.attempts} automated attempts.${detail} Configure/connect GitHub in ChatGPT, then retry.`);
      }
      if (!await hasFirstVisible(page, GITHUB_REPO_SEARCH_SELECTORS, 1500)) {
        await closeGitHubConnectorPicker(page);
        toolSelected = await isGitHubConnectorActive(page).catch(() => false) || toolSelected;
        throw new Error('ChatGPT GitHub connector repository picker was not found after recovery. Tool-only GitHub selection is not enough for deterministic repo grounding.');
      }
      const result = await selectGitHubRepository(page, repository);
      if (!result?.selected) {
        await closeGitHubConnectorPicker(page);
        throw new Error(`GitHub repository "${repository}" was not found in the ChatGPT connector. Check that it is indexed and visible in ChatGPT.`);
      }
      selected.push(repository);
      repositoryStates.push(result);
      toolSelected = true;
      await closeGitHubConnectorPicker(page);
    }
  } catch (error) {
    let partial = connectorState();
    if (partial.cleanupRequired.length > 0 || partial.toolActivatedByRun) {
      partial = await cleanupGitHubRepositorySelections(page, partial).catch((cleanupError) => ({
        ...partial,
        cleanup: {
          ...partial.cleanup,
          attempted: true,
          status: 'warn',
          errors: [
            ...(partial.cleanup?.errors || []),
            { error: cleanupError.message },
          ],
        },
      }));
    }
    const selectedBeforeCleanup = partial.selected.slice();
    const selectedForSubmittedPrompt = partial.repositories
      .filter((item) => item.state === 'preexisting')
      .map((item) => item.repository);
    const cleanedBeforeSubmit = new Set((partial.cleanup?.cleaned || [])
      .filter((item) => ['unselected', 'already-unselected'].includes(item.state))
      .map((item) => item.repository));
    const repositoriesForSubmittedPrompt = partial.repositories.map((item) => (
      item.state === 'temporary-selected'
        ? { ...item, selected: false, state: cleanedBeforeSubmit.has(item.repository) ? 'cleaned-before-submit' : 'cleanup-failed-before-submit' }
        : item
    ));
    error.githubConnector = {
      ...partial,
      selected: selectedForSubmittedPrompt,
      selectedBeforeCleanup,
      repositories: repositoriesForSubmittedPrompt,
      uiSelection: partial.selected.length > 0 ? 'partial' : 'unavailable',
      error: error.message,
      promptRequirement: 'sent',
    };
    throw error;
  }

  return connectorState();
}

export async function cleanupGitHubRepositorySelections(page, githubConnector = {}) {
  const cleanupRequired = [...new Set([
    ...(githubConnector.cleanupRequired || []),
    ...((githubConnector.repositories || [])
      .filter((item) => item.state === 'temporary-selected')
      .map((item) => item.repository)),
  ].filter(Boolean))];
  const hasPreexistingRepository = (githubConnector.repositories || [])
    .some((item) => item.state === 'preexisting');
  const toolRemovalRequired = githubConnector.toolActivatedByRun && !hasPreexistingRepository;
  const cleanupNeeded = cleanupRequired.length > 0 || toolRemovalRequired;
  const previousCleanup = githubConnector.cleanup || {};

  const next = {
    ...githubConnector,
    cleanup: {
      attempted: cleanupNeeded || Boolean(previousCleanup.attempted),
      status: cleanupNeeded ? 'ok' : (previousCleanup.status || 'not-needed'),
      cleaned: [],
      removedTool: Boolean(previousCleanup.removedTool),
      skipped: (githubConnector.cleanup?.skipped || []).slice(),
      errors: (previousCleanup.errors || []).slice(),
    },
  };

  for (const repository of cleanupRequired) {
    try {
      if (!await openGitHubConnector(page)) {
        throw new Error('ChatGPT GitHub connector control was not found during cleanup');
      }

      let row = await githubRepositoryRowOperation(page, repository, 'state');
      if (!row.found) {
        if (await searchGitHubRepository(page, repository)) {
          await page.waitForTimeout(700);
          row = await githubRepositoryRowOperation(page, repository, 'state');
        }
      }

      if (!row.found) {
        throw new Error(`GitHub repository "${repository}" was not found during cleanup`);
      }
      if (row.checked === false) {
        next.cleanup.cleaned.push({ repository, state: 'already-unselected' });
        await closeGitHubConnectorPicker(page);
        continue;
      }
      if (row.checked !== true) {
        throw new Error(`GitHub repository "${repository}" cleanup state could not be determined safely`);
      }

      await githubRepositoryRowOperation(page, repository, 'click');
      await page.waitForTimeout(500);
      const after = await githubRepositoryRowOperation(page, repository, 'state');
      if (after.found && after.checked === false) {
        next.cleanup.cleaned.push({ repository, state: 'unselected' });
      } else {
        throw new Error(`GitHub repository "${repository}" stayed checked after cleanup click`);
      }
      await closeGitHubConnectorPicker(page);
    } catch (error) {
      next.cleanup.status = 'warn';
      next.cleanup.errors.push({ repository, error: error.message });
      await closeGitHubConnectorPicker(page);
    }
  }

  if (toolRemovalRequired) {
    try {
      if (await removeGitHubConnectorTool(page)) {
        await page.waitForTimeout(500);
        if (await isGitHubConnectorActive(page)) {
          throw new Error('GitHub tool pill stayed active after cleanup removal');
        }
        next.cleanup.removedTool = true;
      } else if (await isGitHubConnectorActive(page)) {
        throw new Error('GitHub tool remove control was not found');
      }
    } catch (error) {
      next.cleanup.status = 'warn';
      next.cleanup.errors.push({ repository: null, error: error.message });
    }
  }

  return next;
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
    githubConnector = error.githubConnector || {
      requested: githubRepositories,
      selected: [],
      uiSelection: 'unavailable',
      error: error.message,
      promptRequirement: 'sent',
      cleanup: {
        attempted: false,
        status: 'not-needed',
        cleaned: [],
        removedTool: false,
        skipped: [],
        errors: [],
      },
    };
    if ((githubRepositories || []).length > 0) {
      const fail = new Error(`GitHub connector repository selection failed before prompt submission: ${error.message}`);
      fail.githubConnector = githubConnector;
      fail.cause = error;
      throw fail;
    }
  }

  try {
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
  } catch (error) {
    if ((githubConnector.cleanupRequired || []).length > 0 || githubConnector.toolActivatedByRun) {
      error.githubConnector = await cleanupGitHubRepositorySelections(page, githubConnector).catch((cleanupError) => ({
        ...githubConnector,
        cleanup: {
          attempted: true,
          status: 'warn',
          cleaned: [],
          removedTool: githubConnector.cleanup?.removedTool || false,
          skipped: githubConnector.cleanup?.skipped || [],
          errors: [
            ...(githubConnector.cleanup?.errors || []),
            { error: cleanupError.message },
          ],
        },
      }));
    }
    throw error;
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
    const assistantCount = Number.isInteger(baselineAssistantCount)
      ? await assistantMessageCount(page).catch(() => null)
      : (options.prompt ? null : await assistantMessageCount(page).catch(() => null));
    const isFresh = options.prompt
      ? Boolean(answer) && (
        !Number.isInteger(baselineAssistantCount)
        || (Number.isInteger(assistantCount) && assistantCount > baselineAssistantCount)
      )
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
  if (last && !lastGenerating) {
    throw new Error('Timed out waiting for a stable ChatGPT answer; the unstabilized answer was discarded');
  }
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
