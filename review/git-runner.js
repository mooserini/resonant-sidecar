import { spawn } from 'node:child_process';
import path from 'node:path';

const GIT = '/usr/bin/git';
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export class GitProcessError extends Error {
  constructor(code = 'git-command-failed') {
    super('Git command failed');
    this.name = 'GitProcessError';
    this.code = code;
  }
}

export function runGit({ repoRoot, args, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    throw new TypeError('Git repository root must be an absolute path');
  }
  if (!Array.isArray(args) || args.length === 0 || args.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new TypeError('Git arguments must be a non-empty array of strings without NUL bytes');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('Git output limit must be a positive safe integer');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(GIT, ['-C', repoRoot, ...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
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

    const fail = code => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
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
      if (code !== 0) {
        reject(new GitProcessError());
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

export const localGit = Object.freeze({ run: runGit });
