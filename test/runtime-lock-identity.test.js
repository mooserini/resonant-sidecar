import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeLockIdentityInvocation, assertRuntimeLockIdentityResult } from '../bootstrap/runtime-lock.js';
import { runtimeLockHelperInvocation } from '../bootstrap/runtime-lock-core.js';

test('lock compatibility is proven by the flock protocol without a Perl version pin', () => {
  const invocation = runtimeLockHelperInvocation();
  assert.equal(invocation.command, '/usr/bin/perl');
  assert.equal(invocation.cwd, '/');
  assert.deepEqual(invocation.env, { PATH: '/usr/bin:/bin', LC_ALL: 'C' });
  assert.equal(invocation.shell, false);
  assert.match(invocation.args.join('\n'), /Fcntl.*flock/);
  assert.doesNotMatch(invocation.args.join('\n'), /\$\^V|v5\./);
});

test('uses one fixed Apple designated-requirement verification command', () => {
  assert.deepEqual(runtimeLockIdentityInvocation(), {
    command: '/usr/bin/codesign',
    args: ['--verify', '--strict', '-R=identifier "com.apple.perl" and anchor apple', '--', '/usr/bin/perl'],
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    shell: false,
    timeoutMs: 10000,
    maxOutputBytes: 4096,
  });
});

test('accepts only silent successful code-signing verification', () => {
  assert.doesNotThrow(() => assertRuntimeLockIdentityResult({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
  for (const result of [
    { exitCode: 3, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
    { exitCode: 0, stdout: Buffer.from('unexpected'), stderr: Buffer.alloc(0) },
    { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.from('unexpected') },
    { exitCode: 0, stdout: 'not bytes', stderr: Buffer.alloc(0) },
  ]) assert.throws(() => assertRuntimeLockIdentityResult(result), /identity mismatch/);
});
