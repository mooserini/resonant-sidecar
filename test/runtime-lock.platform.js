import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withRuntimeLock } from '../bootstrap/runtime-lock.js';

test('macOS rejects a mismatched designated requirement for the lock helper', () => {
  const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '-R=identifier "com.apple.notperl" and anchor apple', '--', '/usr/bin/perl'], {
    cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, shell: false, encoding: null,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.length, 0);
});

test('current macOS provider accepts the Apple-designated Perl helper', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-platform-lock-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const device = (await stat(root)).dev;
  const result = await withRuntimeLock({ file: path.join(root, '.lock'), device }, async () => 'locked');
  assert.equal(result, 'locked');
});
