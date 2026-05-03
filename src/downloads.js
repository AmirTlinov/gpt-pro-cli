import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists, sanitizeSlug } from './fsx.js';

function extensionFromContentType(contentType) {
  const value = String(contentType || '').split(';')[0].trim().toLowerCase();
  const map = new Map([
    ['application/zip', '.zip'],
    ['application/x-zip-compressed', '.zip'],
    ['application/pdf', '.pdf'],
    ['application/json', '.json'],
    ['text/plain', '.txt'],
    ['text/markdown', '.md'],
    ['text/html', '.html'],
    ['text/csv', '.csv'],
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif'],
  ]);
  return map.get(value) || '';
}

function filenameFromContentDisposition(header) {
  const value = String(header || '');
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1] || '';
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(path.basename(parsed.pathname)) || '';
  } catch {
    return '';
  }
}

function cleanFilename(value, fallback) {
  const parsed = path.parse(path.basename(String(value || '')));
  const name = sanitizeSlug(parsed.name, fallback);
  const ext = parsed.ext && /^[.][a-zA-Z0-9]{1,12}$/.test(parsed.ext) ? parsed.ext.toLowerCase() : '';
  return `${name}${ext}`;
}

async function uniqueTarget(dir, filename) {
  await ensureDir(dir);
  const parsed = path.parse(filename);
  let candidate = path.join(dir, filename);
  let suffix = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

async function saveDownload(download, dir, fallbackName) {
  const filename = cleanFilename(download.suggestedFilename(), fallbackName);
  const target = await uniqueTarget(dir, filename);
  await download.saveAs(target);
  return target;
}

function answerSelectors() {
  return [
    '[data-message-author-role="assistant"]',
    '[data-testid="assistant-message"]',
    '[data-gpt-pro-answer]',
    'article',
  ];
}

export async function extractAnswerLinks(page, prompt) {
  return page.evaluate(({ expectedPrompt, assistantSelectors }) => {
    function visibleText(node) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      return (node.innerText || node.textContent || '').trim();
    }

    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    const expected = normalized(expectedPrompt).slice(0, 200);
    const userSelectors = [
      '[data-message-author-role="user"]',
      '[data-testid="user-message"]',
      '[data-gpt-pro-user]',
    ];
    const users = userSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const matchingUsers = users.filter((node) => normalized(visibleText(node)).includes(expected));
    const anchor = matchingUsers[matchingUsers.length - 1];
    if (!anchor) return [];

    const assistantNodes = assistantSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const seenNodes = new Set();
    const found = [];
    const seenUrls = new Set();
    const addUrl = (raw, label = '') => {
      if (!raw) return;
      let url;
      try {
        url = new URL(raw, window.location.href).href;
      } catch {
        return;
      }
      if (!/^https?:\/\//i.test(url) || seenUrls.has(url)) return;
      seenUrls.add(url);
      found.push({ url, label });
    };

    for (const node of assistantNodes) {
      if (seenNodes.has(node)) continue;
      seenNodes.add(node);
      if (!(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      for (const link of node.querySelectorAll('a[href]')) {
        addUrl(link.getAttribute('href'), normalized(link.innerText || link.textContent || link.getAttribute('aria-label')));
      }
      const text = visibleText(node);
      for (const match of text.matchAll(/https?:\/\/[^\s<>)"']+/g)) {
        addUrl(match[0].replace(/[.,;:!?]+$/, ''));
      }
    }
    return found;
  }, { expectedPrompt: prompt, assistantSelectors: answerSelectors() });
}

async function clickFallbackDownloadAction(page, downloadDir, sourceLabel, timeoutMs) {
  const actions = await page.evaluate(() => {
    function visible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    const actions = [];
    let index = 0;
    for (const control of document.querySelectorAll('button,[role="button"],a[href]')) {
      if (!visible(control) || control.hasAttribute('data-gpt-pro-download-id')) continue;
      const label = normalized([
        control.innerText || control.textContent,
        control.getAttribute('aria-label'),
        control.getAttribute('title'),
        control.getAttribute('download'),
      ].filter(Boolean).join(' '));
      if (!/download|скач|сохран/i.test(label)) continue;
      const id = `gpt-pro-fallback-download-${Date.now()}-${index}`;
      index += 1;
      control.setAttribute('data-gpt-pro-fallback-download-id', id);
      actions.push({ id, label });
    }
    return actions;
  });

  for (const action of actions) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: timeoutMs }),
        triggerControl(page, `[data-gpt-pro-fallback-download-id="${action.id}"]`),
      ]);
      const target = await saveDownload(download, downloadDir, `download-${Date.now()}`);
      return { url: '', label: `${sourceLabel} / ${action.label}`, status: 'saved', path: target };
    } catch {
      // Try the next visible download action. The original control error remains the useful one.
    }
  }
  return null;
}

async function triggerControl(page, selector) {
  try {
    await page.locator(selector).click({ force: true, timeout: 5000 });
  } catch {
    await page.evaluate((value) => {
      document.querySelector(value)?.click();
    }, selector);
  }
}

export async function clickAnswerDownloadControls(page, prompt, downloadDir, options = {}) {
  await ensureDir(downloadDir);
  const controls = await page.evaluate(({ expectedPrompt, assistantSelectors }) => {
    function visibleText(node) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      return (node.innerText || node.textContent || '').trim();
    }

    function visible(node) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    const expected = normalized(expectedPrompt).slice(0, 200);
    const users = Array.from(document.querySelectorAll('[data-message-author-role="user"],[data-testid="user-message"],[data-gpt-pro-user]'));
    const matchingUsers = users.filter((node) => normalized(visibleText(node)).includes(expected));
    const anchor = matchingUsers[matchingUsers.length - 1];
    if (!anchor) return [];

    const assistantNodes = assistantSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const controls = [];
    let index = 0;
    for (const node of assistantNodes) {
      if (!(anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      for (const control of node.querySelectorAll('button,[role="button"]')) {
        if (!visible(control)) continue;
        const label = normalized([
          control.innerText || control.textContent,
          control.getAttribute('aria-label'),
          control.getAttribute('title'),
        ].filter(Boolean).join(' '));
        if (!/download|скач|сохран|\.(zip|pdf|txt|md|json|csv|xlsx|xls|docx|pptx|png|jpe?g|webp|gif|tgz|tar|gz)\b/i.test(label)) continue;
        const id = `gpt-pro-download-${Date.now()}-${index}`;
        index += 1;
        control.setAttribute('data-gpt-pro-download-id', id);
        controls.push({ id, label });
      }
    }
    return controls;
  }, { expectedPrompt: prompt, assistantSelectors: answerSelectors() });

  const downloads = [];
  const errors = [];
  const controlTimeoutMs = options.timeoutMs
    ? Math.min(Math.max(options.timeoutMs, 100), 30_000)
    : 10_000;
  for (const { id, label } of controls) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: controlTimeoutMs }),
        triggerControl(page, `[data-gpt-pro-download-id="${id}"]`),
      ]);
      const target = await saveDownload(download, downloadDir, `download-${downloads.length + 1}`);
      downloads.push({ url: '', label, status: 'saved', path: target });
    } catch (error) {
      const fallback = await clickFallbackDownloadAction(page, downloadDir, label, controlTimeoutMs);
      if (fallback) {
        downloads.push(fallback);
        continue;
      }
      errors.push({ url: '', label, status: 'failed', error: error.message });
    }
  }
  return { downloads, errors };
}

export async function downloadAnswerLinks(page, links, downloadDir, options = {}) {
  await ensureDir(downloadDir);
  const timeoutMs = options.timeoutMs || 60_000;
  const maxBytes = options.maxBytes || 250 * 1024 * 1024;
  const downloads = [];
  const errors = [];

  for (const [index, link] of links.entries()) {
    try {
      const response = await page.context().request.get(link.url, { timeout: timeoutMs, maxRedirects: 5 });
      if (!response.ok()) {
        throw new Error(`HTTP ${response.status()}`);
      }
      const headers = response.headers();
      const contentLength = Number.parseInt(headers['content-length'] || '0', 10);
      if (contentLength > maxBytes) {
        throw new Error(`download exceeds limit: ${maxBytes} bytes`);
      }
      const body = await response.body();
      if (body.byteLength > maxBytes) {
        throw new Error(`download exceeds limit: ${maxBytes} bytes`);
      }

      const rawName = filenameFromContentDisposition(headers['content-disposition'])
        || filenameFromUrl(response.url())
        || filenameFromUrl(link.url)
        || `link-${index + 1}${extensionFromContentType(headers['content-type'])}`;
      let filename = cleanFilename(rawName, `link-${index + 1}`);
      if (!path.extname(filename)) {
        filename = `${filename}${extensionFromContentType(headers['content-type']) || '.bin'}`;
      }
      const target = await uniqueTarget(downloadDir, filename);
      await fs.writeFile(target, body, { mode: 0o600 });
      downloads.push({
        url: link.url,
        finalUrl: response.url(),
        label: link.label || '',
        status: 'saved',
        path: target,
        bytes: body.byteLength,
        contentType: headers['content-type'] || '',
      });
    } catch (error) {
      errors.push({
        url: link.url,
        label: link.label || '',
        status: 'failed',
        error: error.message,
      });
    }
  }

  return { downloads, errors };
}

export async function downloadAnswerArtifacts(page, { prompt, downloadDir, timeoutMs, maxBytes }) {
  const linksDir = path.join(downloadDir, 'links');
  const links = await extractAnswerLinks(page, prompt);
  const controlResult = await clickAnswerDownloadControls(page, prompt, downloadDir, { timeoutMs });
  const linkResult = await downloadAnswerLinks(page, links, linksDir, { timeoutMs, maxBytes });
  return {
    links,
    downloads: [...controlResult.downloads, ...linkResult.downloads],
    errors: [...controlResult.errors, ...linkResult.errors],
  };
}
