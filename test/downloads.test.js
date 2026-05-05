import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { downloadAnswerArtifacts, downloadAnswerLinks, extractAnswerLinks } from '../src/downloads.js';

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

test('answer downloader saves GitHub blob links as raw content instead of HTML', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-github-raw-'));
  const calls = [];
  const page = {
    context() {
      return {
        request: {
          async get(url) {
            calls.push(url);
            if (url === 'https://raw.githubusercontent.com/AmirTlinov/gpt-pro-cli/main/README.md') {
              return {
                ok: () => true,
                status: () => 200,
                headers: () => ({ 'content-type': 'text/markdown' }),
                url: () => url,
                body: async () => Buffer.from('# raw readme'),
              };
            }
            return {
              ok: () => true,
              status: () => 200,
              headers: () => ({ 'content-type': 'text/html' }),
              url: () => url,
              body: async () => Buffer.from('<html>GitHub blob page, not raw content</html>'),
            };
          },
        },
      };
    },
  };

  const result = await downloadAnswerLinks(page, [
    {
      url: 'https://github.com/AmirTlinov/gpt-pro-cli/blob/main/README.md',
      label: 'README',
    },
  ], dir, { timeoutMs: 5000, maxBytes: 1024 * 1024 });

  assert.deepEqual(calls, [
    'https://raw.githubusercontent.com/AmirTlinov/gpt-pro-cli/main/README.md',
  ]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.downloads.length, 1);
  assert.equal(result.downloads[0].finalUrl, 'https://raw.githubusercontent.com/AmirTlinov/gpt-pro-cli/main/README.md');
  assert.match(result.downloads[0].path, /README\.md$/);
  assert.equal(await fs.readFile(result.downloads[0].path, 'utf8'), '# raw readme');
});

test('answer downloader clicks filename-like assistant file controls', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-file-control-'));
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html>
      <main>
        <div data-message-author-role="user">make downloadable file</div>
        <div data-message-author-role="assistant">
          <p>Done: cli-live-output.zip</p>
          <button id="download-file" style="position:absolute; top:-1000px; left:0">cli-live-output.zip</button>
        </div>
        <script>
          document.querySelector('#download-file').addEventListener('click', () => {
            const blob = new Blob(['LIVE_GENERATED_FILE_OK'], { type: 'application/zip' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'cli-live-output.zip';
            document.body.appendChild(link);
            link.click();
          });
        </script>
      </main>`);

    const result = await downloadAnswerArtifacts(page, {
      prompt: 'make downloadable file',
      downloadDir: dir,
      timeoutMs: 5000,
      maxBytes: 1024 * 1024,
    });

    assert.equal(result.downloads.length, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(result.downloads[0].label, 'cli-live-output.zip');
    assert.match(result.downloads[0].path, /cli-live-output\.zip$/);
    assert.equal(await fs.readFile(result.downloads[0].path, 'utf8'), 'LIVE_GENERATED_FILE_OK');
  } finally {
    await context.close();
    await browser.close();
  }
});

test('answer downloader follows file preview download actions', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-preview-download-'));
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html>
      <main>
        <div data-message-author-role="user">make preview file</div>
        <div data-message-author-role="assistant">
          <button id="file-chip">report.zip</button>
        </div>
        <div id="preview"></div>
        <script>
          document.querySelector('#file-chip').addEventListener('click', () => {
            document.querySelector('#preview').innerHTML = '<button id="real-download">Download</button>';
            document.querySelector('#real-download').addEventListener('click', () => {
              const blob = new Blob(['PREVIEW_DOWNLOAD_OK'], { type: 'application/zip' });
              const link = document.createElement('a');
              link.href = URL.createObjectURL(blob);
              link.download = 'report.zip';
              document.body.appendChild(link);
              link.click();
            });
          });
        </script>
      </main>`);

    const result = await downloadAnswerArtifacts(page, {
      prompt: 'make preview file',
      downloadDir: dir,
      timeoutMs: 50,
      maxBytes: 1024 * 1024,
    });

    assert.equal(result.downloads.length, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(result.downloads[0].label, 'report.zip / Download');
    assert.match(result.downloads[0].path, /report\.zip$/);
    assert.equal(await fs.readFile(result.downloads[0].path, 'utf8'), 'PREVIEW_DOWNLOAD_OK');
  } finally {
    await context.close();
    await browser.close();
  }
});

test('answer downloader does not use preexisting page-global download buttons as fallback', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-global-download-'));
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html>
      <main>
        <button id="old-download">Download</button>
        <div data-message-author-role="user">make missing preview file</div>
        <div data-message-author-role="assistant">
          <button id="file-chip">report.zip</button>
        </div>
        <script>
          document.querySelector('#old-download').addEventListener('click', () => {
            const blob = new Blob(['OLD_GLOBAL_DOWNLOAD_SHOULD_NOT_BE_USED'], { type: 'application/zip' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = 'old.zip';
            document.body.appendChild(link);
            link.click();
          });
          document.querySelector('#file-chip').addEventListener('click', () => {
            document.body.setAttribute('data-preview-opened', '1');
          });
        </script>
      </main>`);

    const result = await downloadAnswerArtifacts(page, {
      prompt: 'make missing preview file',
      downloadDir: dir,
      timeoutMs: 50,
      maxBytes: 1024 * 1024,
    });

    assert.equal(result.downloads.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].label, /report\.zip/);
  } finally {
    await context.close();
    await browser.close();
  }
});
