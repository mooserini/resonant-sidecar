import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const RUNTIME_LOCK_HELPER = '/usr/bin/perl';
const SOURCE = `open(my $lock, '+<&=3') or exit 71; flock($lock, LOCK_EX) or exit 72; print STDOUT "locked\\n" or exit 73;`;

export function runtimeLockHelperInvocation() {
  return {
    command: RUNTIME_LOCK_HELPER,
    args: ['-MFcntl=:flock', '-e', SOURCE],
    cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, shell: false,
  };
}

function assertLock(file, fd, device) {
  const held = fs.fstatSync(fd); const named = fs.lstatSync(file);
  if (fs.realpathSync(file) !== file || !held.isFile() || !named.isFile() || held.ino !== named.ino || held.dev !== named.dev || held.dev !== device || held.uid !== process.getuid() || (held.mode & 0o077) || held.nlink !== 1 || named.nlink !== 1) throw new Error('Runtime kernel lock custody changed');
}

export function createRuntimeLock({ verifyInterpreterIdentity }) {
  if (typeof verifyInterpreterIdentity !== 'function') throw new TypeError('Runtime lock identity verifier required');

  async function acquire(fd) {
    const identity = await verifyInterpreterIdentity();
    const invocation = runtimeLockHelperInvocation();
    await new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd, env: invocation.env, shell: invocation.shell,
        stdio: ['ignore', 'pipe', 'pipe', fd],
      });
      let output = ''; let bytes = 0; let failure;
      const stop = () => { failure = new Error('Runtime kernel lock acquisition failed'); child.kill('SIGKILL'); };
      const timer = setTimeout(stop, 15000);
      child.on('error', () => { failure = new Error('Runtime lock helper unavailable'); });
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64) stop(); else output += chunk; });
      child.stderr.on('data', stop);
      child.once('close', code => {
        clearTimeout(timer);
        if (failure || code !== 0 || output !== 'locked\n') reject(failure ?? new Error('Runtime lock helper behavior mismatch'));
        else resolve();
      });
    });
    const after = await verifyInterpreterIdentity();
    if (after.ino !== identity.ino || after.dev !== identity.dev || after.size !== identity.size || after.mtimeMs !== identity.mtimeMs) throw new Error('Runtime lock helper behavior mismatch');
  }

  return async function withRuntimeLock({ file, device }, action) {
    // The named inode is permanent. No owner PID, stale unlink, rename, or
    // reclamation protocol can split legitimate callers across different locks.
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      assertLock(file, fd, device);
      fs.fsyncSync(fd);
      await acquire(fd);
      assertLock(file, fd, device);
      // flock is attached to the shared open-file description. Parent retains
      // it after the helper exits; close/crash releases it in the kernel.
      return await action();
    } finally { fs.closeSync(fd); }
  };
}
