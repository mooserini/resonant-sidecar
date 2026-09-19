import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sha256Bytes } from '../review/canonical-json.js';

// macOS system Perl supplies flock through its core Fcntl module. This fixed
// interpreter identity is part of the trusted bootstrap, not candidate policy.
const PERL = '/usr/bin/perl';
const PERL_SHA256 = '85e5621137742a37be052f58800372b2005f91f609ad55019832214b5d9e61bc';
const SOURCE = `exit 70 if $^V ne v5.34.1; open(my $lock, '+<&=3') or exit 71; flock($lock, LOCK_EX) or exit 72; print STDOUT "locked\\n" or exit 73;`;

function interpreterIdentity() {
  const info = fs.lstatSync(PERL);
  if (process.platform !== 'darwin' || fs.realpathSync(PERL) !== PERL || !info.isFile() || info.uid !== 0 || (info.mode & 0o022) || !(info.mode & 0o111) || sha256Bytes(fs.readFileSync(PERL)) !== PERL_SHA256) throw new Error('Trusted lock interpreter identity mismatch');
  return info;
}
function assertLock(file, fd, device) {
  const held = fs.fstatSync(fd); const named = fs.lstatSync(file);
  if (fs.realpathSync(file) !== file || !held.isFile() || !named.isFile() || held.ino !== named.ino || held.dev !== named.dev || held.dev !== device || held.uid !== process.getuid() || (held.mode & 0o077) || held.nlink !== 1 || named.nlink !== 1) throw new Error('Runtime kernel lock custody changed');
}

async function acquire(fd, cwd) {
  const identity = interpreterIdentity();
  await new Promise((resolve, reject) => {
    const child = spawn(PERL, ['-MFcntl=:flock', '-e', SOURCE], {
      cwd, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, shell: false,
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
      try {
        const after = interpreterIdentity();
        if (failure || code !== 0 || output !== 'locked\n' || after.ino !== identity.ino || after.dev !== identity.dev) throw failure ?? new Error('Runtime lock helper behavior mismatch');
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

export async function withRuntimeLock({ file, device }, action) {
  // The named inode is permanent. No owner PID, stale unlink, rename, or
  // reclamation protocol can split legitimate callers across different locks.
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    assertLock(file, fd, device);
    fs.fsyncSync(fd);
    await acquire(fd, path.dirname(file));
    assertLock(file, fd, device);
    // flock is attached to the shared open-file description. Parent retains
    // it after the helper exits; close/crash releases it in the kernel.
    return await action();
  } finally { fs.closeSync(fd); }
}
