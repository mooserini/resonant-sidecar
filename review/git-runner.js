import { spawn } from 'node:child_process';
import path from 'node:path';

const GIT = '/usr/bin/git';
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export class GitProcessError extends Error {
  constructor(code = 'git-command-failed') {
    super('Git command failed');
    this.name = 'GitProcessError';
    this.code = code;
  }
}

export function runGit({
  repoRoot,
  args,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    throw new TypeError('Git repository root must be an absolute path');
  }
  if (!Array.isArray(args) || args.length === 0 || args.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new TypeError('Git arguments must be a non-empty array of strings without NUL bytes');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('Git output limit must be a positive safe integer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('Git timeout must be between 1 and 60000 milliseconds');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(GIT, ['-c', 'core.fsmonitor=false', '-C', repoRoot, ...args], {
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_EXTERNAL_DIFF: '',
      },
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timer;

    const terminate = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const fail = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminate();
      reject(new GitProcessError(code));
    };
    const collect = target => chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail('git-output-limit');
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', () => fail());
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new GitProcessError());
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    timer = setTimeout(() => fail('git-timeout'), timeoutMs);
  });
}

export const localGit = Object.freeze({ run: runGit });
