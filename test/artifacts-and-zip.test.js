import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  archiveLocalChats,
  nextMessageDir,
  readSessionCache,
  resolveSessionFromCache,
  sessionSlugFromUrl,
  writeMessageArtifacts,
  writeSessionCache,
} from '../src/artifacts.js';
import { safeExtractZip, stageAttachment } from '../src/zip.js';

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gpt-pro-test-'));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
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

test('session cache resolves agent-friendly refs', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const cache = await writeSessionCache('CLI_QUESTIONS', [
    { title: 'Latest', url: 'https://chatgpt.com/g/g-p-demo/c/abcdef12-0000-0000-0000-000000000000' },
    { title: 'Second', url: 'https://chatgpt.com/g/g-p-demo/c/bcdef123-0000-0000-0000-000000000000' },
  ]);

  assert.equal((await readSessionCache('CLI_QUESTIONS')).sessions.length, 2);
  assert.equal(resolveSessionFromCache(cache, 'latest').shortId, 'abcdef12');
  assert.equal(resolveSessionFromCache(cache, '2').shortId, 'bcdef123');
  assert.equal(resolveSessionFromCache(cache, 'abcdef12').title, 'Latest');
});

test('message artifacts include a verifiable receipt', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const messageDir = await nextMessageDir('receipt-session');
  await fs.writeFile(path.join(messageDir, 'files', 'artifact.txt'), 'artifact');

  const result = await writeMessageArtifacts(messageDir, {
    prompt: 'hello',
    answer: 'world',
    links: ['https://example.com/file.txt'],
    downloads: ['/tmp/file.txt'],
    meta: {
      command: 'ask',
      project: 'CLI_QUESTIONS',
      sessionUrl: 'https://chatgpt.com/g/g-p-demo/c/receipt-session',
      downloads: ['/tmp/file.txt'],
      linkDownloads: [],
      downloadErrors: [],
      extractedFiles: [],
      elapsedMs: 1234,
    },
  });

  const receipt = JSON.parse(await fs.readFile(result.path, 'utf8'));
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.project, 'CLI_QUESTIONS');
  assert.equal(receipt.counts.downloads, 1);
  assert.equal(receipt.warnings.length, 0);
  assert.ok(receipt.files.some((file) => file.path === 'answer.md' && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(receipt.files.some((file) => file.path === 'files/artifact.txt'));
  assert.match(await fs.readFile(path.join(messageDir, 'receipt.md'), 'utf8'), /status: ok/);
});

test('message receipt surfaces hidden download failures as warnings', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const messageDir = await nextMessageDir('warning-session');

  const result = await writeMessageArtifacts(messageDir, {
    prompt: 'hello',
    answer: 'world',
    downloads: [{ label: 'report.zip', status: 'failed', error: 'timeout' }],
    meta: {
      command: 'ask',
      project: 'CLI_QUESTIONS',
      sessionUrl: 'https://chatgpt.com/g/g-p-demo/c/warning-session',
      downloads: [],
      linkDownloads: [],
      downloadErrors: [{ label: 'report.zip', error: 'timeout' }],
      extractedFiles: [],
    },
  });

  const receipt = JSON.parse(await fs.readFile(result.path, 'utf8'));
  assert.equal(receipt.status, 'warn');
  assert.equal(receipt.counts.downloadErrors, 1);
  assert.match(receipt.warnings.join('\n'), /report\.zip/);
});

test('archive includes project chats, project sessions, and manifest only', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const messageDir = await nextMessageDir('abcdef12-0000-0000-0000-000000000000');
  await fs.writeFile(path.join(messageDir, 'answer.md'), 'hello');
  const localOnlyMessageDir = await nextMessageDir('local-only-project-session');
  await fs.writeFile(path.join(localOnlyMessageDir, 'answer.md'), 'local project');
  await fs.writeFile(path.join(localOnlyMessageDir, 'meta.json'), JSON.stringify({ project: 'CLI_QUESTIONS' }));
  const oldMessageDir = await nextMessageDir('old-global-session');
  await fs.writeFile(path.join(oldMessageDir, 'answer.md'), 'old');
  await fs.writeFile(path.join(oldMessageDir, 'meta.json'), JSON.stringify({ project: 'GENERAL' }));

  const result = await archiveLocalChats({
    projectName: 'CLI_QUESTIONS',
    sessionRef: 'all',
    sessions: [
      { title: 'Latest', id: 'abcdef12-0000-0000-0000-000000000000', shortId: 'abcdef12', url: 'https://chatgpt.com/g/g-p-demo/c/abcdef12-0000-0000-0000-000000000000' },
    ],
    warnings: [],
  });

  const archive = new AdmZip(result.path);
  const entries = archive.getEntries().map((entry) => entry.entryName);
  assert.ok(entries.includes('manifest.json'));
  assert.ok(entries.includes('project-sessions.json'));
  assert.ok(entries.includes('chats/abcdef12-0000-0000-0000-000000000000/message-1/answer.md'));
  assert.ok(entries.includes('chats/local-only-project-session/message-1/answer.md'));
  assert.equal(entries.some((entry) => entry.includes('old-global-session')), false);
  assert.equal(entries.some((entry) => entry.includes('browser-profile')), false);
});

test('archive delete-local removes only archived project chat directories after zip is written', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const cachedSessionId = 'abcdef12-0000-0000-0000-000000000000';
  const messageDir = await nextMessageDir(cachedSessionId);
  await fs.writeFile(path.join(messageDir, 'answer.md'), 'hello');
  const localOnlyMessageDir = await nextMessageDir('local-only-project-session');
  await fs.writeFile(path.join(localOnlyMessageDir, 'answer.md'), 'local project');
  await fs.writeFile(path.join(localOnlyMessageDir, 'meta.json'), JSON.stringify({ project: 'CLI_QUESTIONS' }));
  const oldMessageDir = await nextMessageDir('old-global-session');
  await fs.writeFile(path.join(oldMessageDir, 'answer.md'), 'old');
  await fs.writeFile(path.join(oldMessageDir, 'meta.json'), JSON.stringify({ project: 'GENERAL' }));

  const result = await archiveLocalChats({
    projectName: 'CLI_QUESTIONS',
    sessionRef: 'all',
    sessions: [
      { title: 'Latest', id: cachedSessionId, shortId: 'abcdef12', url: `https://chatgpt.com/g/g-p-demo/c/${cachedSessionId}` },
    ],
    warnings: [],
    deleteLocal: true,
  });

  const archive = new AdmZip(result.path);
  const entries = archive.getEntries().map((entry) => entry.entryName);
  const manifest = JSON.parse(archive.readAsText('manifest.json'));
  assert.ok(entries.includes(`chats/${cachedSessionId}/message-1/answer.md`));
  assert.ok(entries.includes('chats/local-only-project-session/message-1/answer.md'));
  assert.equal(entries.some((entry) => entry.includes('old-global-session')), false);
  assert.equal(await exists(path.join(home, 'chats', cachedSessionId)), false);
  assert.equal(await exists(path.join(home, 'chats', 'local-only-project-session')), false);
  assert.equal(await exists(path.join(home, 'chats', 'old-global-session')), true);
  assert.equal(result.manifest.localDeletion.requested, true);
  assert.deepEqual(result.manifest.localDeletion.deletedSessions.sort(), [cachedSessionId, 'local-only-project-session'].sort());
  assert.deepEqual(result.manifest.localDeletion.failedSessions, []);
  assert.deepEqual(manifest.localDeletion.deletedSessions.sort(), [cachedSessionId, 'local-only-project-session'].sort());
});

test('archive does not guess all chats when project cache is empty', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const messageDir = await nextMessageDir('old-global-session');
  await fs.writeFile(path.join(messageDir, 'answer.md'), 'old');

  const result = await archiveLocalChats({
    projectName: 'CLI_QUESTIONS',
    sessionRef: 'all',
    sessions: [],
    warnings: [],
  });

  const archive = new AdmZip(result.path);
  const entries = archive.getEntries().map((entry) => entry.entryName);
  assert.equal(result.manifest.sessionsCount, 0);
  assert.equal(entries.some((entry) => entry.includes('old-global-session')), false);
  assert.match(result.manifest.warnings.join('\n'), /no sessions found for project CLI_QUESTIONS/);
});

test('archive rejects explicit local session refs outside the project', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const messageDir = await nextMessageDir('old-global-session');
  await fs.writeFile(path.join(messageDir, 'answer.md'), 'old');
  await fs.writeFile(path.join(messageDir, 'meta.json'), JSON.stringify({ project: 'GENERAL' }));

  const result = await archiveLocalChats({
    projectName: 'CLI_QUESTIONS',
    sessionRef: 'old-global-session',
    sessions: [],
    warnings: [],
    deleteLocal: true,
  });

  const archive = new AdmZip(result.path);
  const entries = archive.getEntries().map((entry) => entry.entryName);
  assert.equal(result.manifest.sessionsCount, 0);
  assert.equal(result.manifest.localDeletion.requested, true);
  assert.deepEqual(result.manifest.localDeletion.deletedSessions, []);
  assert.equal(await exists(path.join(home, 'chats', 'old-global-session')), true);
  assert.equal(entries.some((entry) => entry.includes('old-global-session')), false);
  assert.match(result.manifest.warnings.join('\n'), /not known in project CLI_QUESTIONS/);
});

test('archive delete-local does not trust a project-looking URL over negative local metadata', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const messageDir = await nextMessageDir('old-global-session');
  await fs.writeFile(path.join(messageDir, 'answer.md'), 'old');
  await fs.writeFile(path.join(messageDir, 'meta.json'), JSON.stringify({ project: 'GENERAL' }));

  const result = await archiveLocalChats({
    projectName: 'CLI_QUESTIONS',
    sessionRef: 'https://chatgpt.com/g/cli-questions/c/old-global-session',
    sessions: [],
    warnings: [],
    deleteLocal: true,
  });

  const archive = new AdmZip(result.path);
  const entries = archive.getEntries().map((entry) => entry.entryName);
  assert.equal(result.manifest.sessionsCount, 0);
  assert.deepEqual(result.manifest.localDeletion.deletedSessions, []);
  assert.equal(await exists(path.join(home, 'chats', 'old-global-session')), true);
  assert.equal(entries.some((entry) => entry.includes('old-global-session')), false);
  assert.match(result.manifest.warnings.join('\n'), /not known in project CLI_QUESTIONS/);
});

test('archive delete-local lets negative local metadata veto stale cached sessions', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const messageDir = await nextMessageDir('old-global-session');
  await fs.writeFile(path.join(messageDir, 'answer.md'), 'old');
  await fs.writeFile(path.join(messageDir, 'meta.json'), JSON.stringify({ project: 'GENERAL' }));

  const result = await archiveLocalChats({
    projectName: 'CLI_QUESTIONS',
    sessionRef: 'all',
    sessions: [
      { title: 'Stale', id: 'old-global-session', shortId: 'old-glob', url: 'https://chatgpt.com/g/cli-questions/c/old-global-session' },
    ],
    warnings: [],
    deleteLocal: true,
  });

  const archive = new AdmZip(result.path);
  const entries = archive.getEntries().map((entry) => entry.entryName);
  assert.equal(result.manifest.sessionsCount, 0);
  assert.deepEqual(result.manifest.localDeletion.deletedSessions, []);
  assert.equal(await exists(path.join(home, 'chats', 'old-global-session')), true);
  assert.equal(entries.some((entry) => entry.includes('old-global-session')), false);
  assert.match(result.manifest.warnings.join('\n'), /local metadata for a different project/);
});

test('archive delete-local keeps URL-inferred sessions local unless project ownership is proven', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;
  const messageDir = await nextMessageDir('url-only-session');
  await fs.writeFile(path.join(messageDir, 'answer.md'), 'url only');

  const result = await archiveLocalChats({
    projectName: 'CLI_QUESTIONS',
    sessionRef: 'https://chatgpt.com/g/cli-questions/c/url-only-session',
    sessions: [],
    warnings: [],
    deleteLocal: true,
  });

  const archive = new AdmZip(result.path);
  const entries = archive.getEntries().map((entry) => entry.entryName);
  assert.equal(result.manifest.sessionsCount, 1);
  assert.ok(entries.includes('chats/url-only-session/message-1/answer.md'));
  assert.deepEqual(result.manifest.localDeletion.deletedSessions, []);
  assert.deepEqual(result.manifest.localDeletion.skippedSessions, [
    { id: 'url-only-session', reason: 'project membership is inferred from URL only' },
  ]);
  assert.equal(await exists(path.join(home, 'chats', 'url-only-session')), true);
  assert.match(result.manifest.warnings.join('\n'), /skipped local deletion/);
});

test('archive delete-local rejects dot-dot session refs before filesystem access', async () => {
  const home = await tempHome();
  process.env.GPT_PRO_HOME = home;

  const result = await archiveLocalChats({
    projectName: 'CLI_QUESTIONS',
    sessionRef: '..',
    sessions: [],
    warnings: [],
    deleteLocal: true,
  });

  assert.equal(result.manifest.sessionsCount, 0);
  assert.deepEqual(result.manifest.localDeletion.deletedSessions, []);
  assert.equal(await exists(home), true);
  assert.equal(await exists(path.join(home, 'archives')), true);
  assert.match(result.manifest.warnings.join('\n'), /unsafe local session id/);
});
