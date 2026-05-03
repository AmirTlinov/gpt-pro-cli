import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { downloadAnswerArtifacts, extractAnswerLinks } from '../src/downloads.js';

function fakeDownloadServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/out.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="answer-file.txt"',
      });
      res.end('downloaded answer file');
      return;
    }
    if (req.url === '/missing.txt') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('missing');
      return;
    }
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <main>
        <a href="${base}/nav.txt">navigation link</a>
        <div data-message-author-role="user">fresh prompt</div>
        <div data-message-author-role="assistant">
          <a href="${base}/out.txt">answer file</a>
          Plain URL: ${base}/missing.txt
        </div>
      </main>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('answer downloader scopes links to the current assistant answer and records failures', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const { server, url } = await fakeDownloadServer();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-downloads-'));
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const links = await extractAnswerLinks(page, 'fresh prompt');
    assert.equal(links.length, 2);
    assert.equal(links.some((link) => link.url.endsWith('/nav.txt')), false);

    const result = await downloadAnswerArtifacts(page, {
      prompt: 'fresh prompt',
      downloadDir: dir,
      timeoutMs: 5000,
      maxBytes: 1024 * 1024,
    });
    assert.equal(result.downloads.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.downloads[0].path, /answer-file\.txt$/);
    assert.equal(await fs.readFile(result.downloads[0].path, 'utf8'), 'downloaded answer file');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
