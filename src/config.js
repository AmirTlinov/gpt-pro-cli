import os from 'node:os';
import path from 'node:path';

export const DEFAULT_IDLE_MS = 20 * 60 * 1000;
export const DEFAULT_PROJECT_NAME = 'CLI_QUESTIONS';

export function homeDir() {
  return process.env.GPT_PRO_HOME || path.join(os.homedir(), 'gpt-pro');
}

export function paths() {
  const root = homeDir();
  return {
    root,
    profileDir: path.join(root, 'browser-profile'),
    runtimeDir: path.join(root, 'runtime'),
    chatsDir: path.join(root, 'chats'),
    sessionsDir: path.join(root, 'sessions'),
    archivesDir: path.join(root, 'archives'),
    runtimeFile: path.join(root, 'runtime', 'keeper.json'),
    logFile: path.join(root, 'runtime', 'keeper.log'),
  };
}

export function settings() {
  return {
    baseUrl: process.env.GPT_PRO_CHATGPT_URL || 'https://chatgpt.com',
    browserChannel: process.env.GPT_PRO_BROWSER_CHANNEL || 'chrome',
    browserMode: process.env.GPT_PRO_BROWSER_MODE || 'background',
    projectName: process.env.GPT_PRO_PROJECT || DEFAULT_PROJECT_NAME,
    idleMs: Number.parseInt(process.env.GPT_PRO_IDLE_MS || `${DEFAULT_IDLE_MS}`, 10),
    operationTimeoutMs: Number.parseInt(process.env.GPT_PRO_OPERATION_TIMEOUT_MS || `${12 * 60 * 1000}`, 10),
    maxExtractBytes: Number.parseInt(process.env.GPT_PRO_MAX_EXTRACT_BYTES || `${250 * 1024 * 1024}`, 10),
    maxDownloadBytes: Number.parseInt(process.env.GPT_PRO_MAX_DOWNLOAD_BYTES || `${250 * 1024 * 1024}`, 10),
    downloadTimeoutMs: Number.parseInt(process.env.GPT_PRO_DOWNLOAD_TIMEOUT_MS || `${60 * 1000}`, 10),
  };
}
