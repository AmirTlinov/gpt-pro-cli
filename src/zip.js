import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { settings } from './config.js';
import { ensureDir, isSubPath, pathExists } from './fsx.js';

async function addDirToZip(zip, root, current) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const rel = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      await addDirToZip(zip, root, absolute);
    } else if (entry.isFile()) {
      zip.addLocalFile(absolute, path.dirname(rel) === '.' ? '' : path.dirname(rel));
    }
  }
}

export async function stageAttachment(source, destinationZip) {
  const stat = await fs.stat(source);
  await ensureDir(path.dirname(destinationZip));
  if (stat.isDirectory()) {
    const zip = new AdmZip();
    await addDirToZip(zip, source, source);
    zip.writeZip(destinationZip);
    return destinationZip;
  }
  if (stat.isFile() && source.toLowerCase().endsWith('.zip')) {
    await fs.copyFile(source, destinationZip);
    return destinationZip;
  }
  throw new Error(`Attachment must be a .zip file or directory: ${source}`);
}

export async function safeExtractZip(zipFile, destination, options = {}) {
  const maxBytes = options.maxBytes || settings().maxExtractBytes;
  const overwrite = Boolean(options.overwrite);
  await ensureDir(destination);
  const zip = new AdmZip(zipFile);
  let total = 0;
  const extracted = [];
  for (const entry of zip.getEntries()) {
    const segments = entry.entryName.split(/[\\/]+/);
    if (segments.includes('..') || entry.entryName.startsWith('/') || entry.entryName.startsWith('\\')) {
      throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
    }
    const normalized = path.normalize(entry.entryName);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
    }
    const target = path.resolve(destination, normalized);
    if (!isSubPath(path.resolve(destination), target)) {
      throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
    }
    total += entry.header.size;
    if (total > maxBytes) {
      throw new Error(`Zip exceeds extraction limit: ${maxBytes} bytes`);
    }
    if (!entry.isDirectory && !overwrite && await pathExists(target)) {
      throw new Error(`Refusing to overwrite existing file: ${target}`);
    }
    extracted.push({ entry, target });
  }
  for (const { entry, target } of extracted) {
    if (entry.isDirectory) {
      await ensureDir(target);
      continue;
    }
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, entry.getData(), { mode: 0o600 });
  }
  return extracted.filter(({ entry }) => !entry.isDirectory).map(({ target }) => target);
}
