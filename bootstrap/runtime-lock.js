import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRuntimeLock, RUNTIME_LOCK_HELPER } from './runtime-lock-core.js';

// Identity v2 accepts routine Apple binary drift only when macOS validates the
// fixed designated requirement for the helper. The kernel-lock protocol and
// custody checks live in runtime-lock-core.js and are shared with test custody.
const CODESIGN = '/usr/bin/codesign';
const PERL_REQUIREMENT = 'identifier "com.apple.perl" and anchor apple';
const IDENTITY_OUTPUT_LIMIT = 4096;

export function runtimeLockIdentityInvocation() {
  return {
    command: CODESIGN,
    args: ['--verify', '--strict', `-R=${PERL_REQUIREMENT}`, '--', RUNTIME_LOCK_HELPER],
    cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, shell: false,
    timeoutMs: 10000, maxOutputBytes: IDENTITY_OUTPUT_LIMIT,
  };
}

export function assertRuntimeLockIdentityResult({ exitCode, stdout, stderr } = {}) {
  if (!Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stdout.length + stderr.length > IDENTITY_OUTPUT_LIMIT || exitCode !== 0 || stdout.length !== 0 || stderr.length !== 0) throw new Error('Trusted lock interpreter identity mismatch');
}

function trustedSystemExecutable(file) {
  const info = fs.lstatSync(file);
  if (fs.realpathSync(file) !== file || !info.isFile() || info.uid !== 0 || (info.mode & 0o022) || !(info.mode & 0o111)) throw new Error('Trusted lock interpreter identity mismatch');
  return info;
}

function verifyAppleRequirement() {
  trustedSystemExecutable(CODESIGN);
  return new Promise((resolve, reject) => {
    const invocation = runtimeLockIdentityInvocation();
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd, env: invocation.env, shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = []; const stderr = []; let bytes = 0; let failed = false; let settled = false;
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    const capture = target => chunk => { bytes += chunk.length; if (bytes > invocation.maxOutputBytes) fail(); else target.push(chunk); };
    const timer = setTimeout(fail, invocation.timeoutMs);
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', fail);
    child.once('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try {
        if (failed) throw new Error('Trusted lock interpreter identity mismatch');
        assertRuntimeLockIdentityResult({ exitCode: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

async function interpreterIdentity() {
  if (process.platform !== 'darwin') throw new Error('Trusted lock interpreter identity mismatch');
  const named = trustedSystemExecutable(RUNTIME_LOCK_HELPER);
  const fd = fs.openSync(RUNTIME_LOCK_HELPER, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const held = fs.fstatSync(fd);
    if (held.ino !== named.ino || held.dev !== named.dev || held.size !== named.size || held.mtimeMs !== named.mtimeMs) throw new Error('Trusted lock interpreter identity mismatch');
    await verifyAppleRequirement();
    const afterHeld = fs.fstatSync(fd); const afterNamed = fs.lstatSync(RUNTIME_LOCK_HELPER);
    if (fs.realpathSync(RUNTIME_LOCK_HELPER) !== RUNTIME_LOCK_HELPER || afterHeld.ino !== held.ino || afterHeld.dev !== held.dev || afterHeld.size !== held.size || afterHeld.mtimeMs !== held.mtimeMs || afterNamed.ino !== held.ino || afterNamed.dev !== held.dev || afterNamed.size !== held.size || afterNamed.mtimeMs !== held.mtimeMs) throw new Error('Trusted lock interpreter identity mismatch');
    return held;
  } finally { fs.closeSync(fd); }
}

export const withRuntimeLock = createRuntimeLock({ verifyInterpreterIdentity: interpreterIdentity });
