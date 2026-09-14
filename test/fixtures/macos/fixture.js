import { readFile } from 'node:fs/promises';
export const ps = await readFile(new URL('./ps.txt', import.meta.url), 'utf8');
export const lsof = await readFile(new URL('./lsof.txt', import.meta.url), 'utf8');
const signing = await readFile(new URL('./codesign.txt', import.meta.url), 'utf8');
export function policy(phase = 'before') {
  return { phase, chromeExited: false,
    expectedChrome: { executablePath: '/usr/bin/true', identifier: 'com.google.Chrome.dev', teamId: 'EQHXZ8M8AV', cdpPorts: [9222] },
    processes: [
      { pid: 101, name: 'chrome', parent: null, executablePath: '/usr/bin/true' },
      { pid: 102, name: 'bootstrap', parent: 'chrome', executablePath: '/usr/bin/true' },
      { pid: 103, name: 'active-host', parent: 'bootstrap', executablePath: '/usr/bin/true' },
      { pid: 104, name: 'sidecar-codex', parent: 'active-host', executablePath: '/usr/bin/true' },
      ...(phase === 'verification' ? [{ pid: 105, name: 'verifier', parent: 'bootstrap', executablePath: '/usr/bin/true' }] : []),
    ],
  };
}
export function runner(overrides = {}) {
  const calls = [];
  const run = async invocation => {
    calls.push(invocation);
    const { command, args } = invocation;
    if (overrides[command]) return overrides[command](invocation, calls);
    let stdout = ''; let stderr = '';
    if (command === '/bin/ps') stdout = ps;
    else if (command === '/usr/sbin/lsof') stdout = lsof.replaceAll('\n', '\0\n');
    else if (command === '/usr/bin/codesign') stderr = args[0] === '--display' ? signing : '';
    else if (command === '/usr/bin/sample') stdout = 'Call graph:\n    100 Thread_123\n      100 read\nPath: /Users/example/secret\nCookie: never-retain\n';
    else if (command === '/usr/bin/sw_vers') stdout = '27.0\n';
    else if (command === '/usr/sbin/sysctl') stdout = args[1] === 'hw.machine' ? 'arm64\n' : '11111111-2222-3333-4444-555555555555\n';
    else throw new Error('Unexpected command');
    return { exitCode: 0, stdout, stderr };
  };
  return { run, calls };
}
