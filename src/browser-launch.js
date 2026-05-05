export function chromeLaunchArgs({
  port,
  profileDir,
  mode = 'background',
  baseUrl,
  noStartupWindow = false,
}) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
  ];

  if (mode === 'headless') {
    args.push(
      '--headless=new',
      '--window-size=1440,1000',
      '--hide-scrollbars',
      '--mute-audio',
    );
  } else if (mode === 'background') {
    args.push(
      '--window-size=1440,1000',
      '--window-position=-24000,-24000',
      '--start-minimized',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    );
    if (noStartupWindow) {
      args.push('--no-startup-window');
    }
  } else {
    args.push('--window-size=1440,1000');
  }

  if (baseUrl && !(mode === 'background' && noStartupWindow)) args.push(baseUrl);
  return args;
}
