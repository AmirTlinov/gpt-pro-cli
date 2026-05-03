import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { nextMessageDir, sessionSlugFromUrl } from '../src/artifacts.js';
import { safeExtractZip, stageAttachment } from '../src/zip.js';

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-test-'));
}

test('session slug and message directories are deterministic', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  assert.equal(sessionSlugFromUrl('https://chatgpt.com/c/abc-123', 'Ignored'), 'abc-123');
  assert.equal(sessionSlugFromUrl('', 'A title with spaces'), 'A-title-with-spaces');

  const first = await nextMessageDir('abc-123');
  const second = await nextMessageDir('abc-123');
  assert.equal(path.basename(first), 'message-1');
  assert.equal(path.basename(second), 'message-2');
});

test('directory attachments are zipped and safely extracted', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const source = path.join(home, 'source');
  const nested = path.join(source, 'nested');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'hello.txt'), 'hello');

  const zipFile = path.join(home, 'staged', 'input.zip');
  await stageAttachment(source, zipFile);
  const output = path.join(home, 'output');
  const extracted = await safeExtractZip(zipFile, output);

  assert.equal(await fs.readFile(path.join(output, 'nested', 'hello.txt'), 'utf8'), 'hello');
  assert.equal(extracted.length, 1);
});

test('safe extraction blocks zip-slip and overwrites', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;

  const evilZip = new AdmZip();
  evilZip.addFile('safe.txt', Buffer.from('bad'));
  evilZip.getEntries()[0].entryName = '../evil.txt';
  const evilPath = path.join(home, 'evil.zip');
  evilZip.writeZip(evilPath);
  await assert.rejects(() => safeExtractZip(evilPath, path.join(home, 'out')), /Unsafe zip entry path/);

  const normalZip = new AdmZip();
  normalZip.addFile('same.txt', Buffer.from('new'));
  const normalPath = path.join(home, 'normal.zip');
  normalZip.writeZip(normalPath);
  const out = path.join(home, 'overwrite');
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'same.txt'), 'old');
  await assert.rejects(() => safeExtractZip(normalPath, out), /Refusing to overwrite/);
});
