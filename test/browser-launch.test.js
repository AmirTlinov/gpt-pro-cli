import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeLaunchArgs } from '../src/browser-launch.js';

test('background Chrome launches minimized instead of stealing the desktop', () => {
  const args = chromeLaunchArgs({
    port: 12345,
    profileDir: '/tmp/gpt-pro-profile',
    mode: 'background',
    baseUrl: 'https://chatgpt.com',
  });
  assert.ok(args.includes('--start-minimized'));
  assert.ok(args.includes('--window-position=-24000,-24000'));
  assert.ok(args.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(args.includes('--disable-renderer-backgrounding'));
  assert.ok(!args.some((arg) => arg.startsWith('--headless')));
  assert.equal(args.at(-1), 'https://chatgpt.com');
});

test('background Chrome can start without an initial visible URL on macOS', () => {
  const args = chromeLaunchArgs({
    port: 12345,
    profileDir: '/tmp/gpt-pro-profile',
    mode: 'background',
    baseUrl: 'https://chatgpt.com',
    noStartupWindow: true,
  });
  assert.ok(args.includes('--no-startup-window'));
  assert.ok(args.includes('--start-minimized'));
  assert.ok(!args.includes('https://chatgpt.com'));
});

test('headless Chrome uses the selected CDP-compatible headless flavor with the same profile', () => {
  const args = chromeLaunchArgs({
    port: 12345,
    profileDir: '/tmp/gpt-pro-profile',
    mode: 'headless',
    baseUrl: 'https://chatgpt.com',
    headlessFlavor: 'old',
  });
  assert.ok(args.includes('--headless=old'));
  assert.ok(args.includes('--window-size=1440,1000'));
  assert.ok(args.includes('--hide-scrollbars'));
  assert.ok(args.includes('--mute-audio'));
  assert.ok(args.includes('--user-data-dir=/tmp/gpt-pro-profile'));
  assert.ok(!args.includes('https://chatgpt.com'));
  assert.ok(!args.includes('--start-minimized'));
});

test('headless Chrome defaults to supported new headless without opening a startup URL', () => {
  const args = chromeLaunchArgs({
    port: 12345,
    profileDir: '/tmp/gpt-pro-profile',
    mode: 'headless',
    baseUrl: 'https://chatgpt.com',
  });
  assert.ok(args.includes('--headless=new'));
  assert.ok(!args.includes('https://chatgpt.com'));
});

test('headless Chrome rejects unknown headless flavors instead of guessing', () => {
  assert.throws(() => chromeLaunchArgs({
    port: 12345,
    profileDir: '/tmp/gpt-pro-profile',
    mode: 'headless',
    baseUrl: 'https://chatgpt.com',
    headlessFlavor: 'maybe',
  }), /headlessFlavor must be "old" or "new"/);
});

test('headed Chrome remains visible for login and manual challenge recovery', () => {
  const args = chromeLaunchArgs({
    port: 12345,
    profileDir: '/tmp/gpt-pro-profile',
    mode: 'headed',
    baseUrl: 'https://chatgpt.com',
  });
  assert.ok(args.includes('--window-size=1440,1000'));
  assert.ok(!args.some((arg) => arg.startsWith('--headless')));
  assert.ok(!args.includes('--start-minimized'));
});
