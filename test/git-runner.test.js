import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runGit } from '../review/git-runner.js';

const execFileAsync = promisify(execFile);

async function temporaryGitRepo(t) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'resonant-git-runner-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await execFileAsync('/usr/bin/git', ['-C', repoRoot, 'init'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  return repoRoot;
}

test('every Git subprocess disables implicit lazy object fetching', async t => {
  const repoRoot = await temporaryGitRepo(t);
  await execFileAsync('/usr/bin/git', [
    '-C', repoRoot,
    'config',
    'alias.assert-no-lazy-fetch',
    '!test "$GIT_NO_LAZY_FETCH" = 1',
  ]);

  const result = await runGit({ repoRoot, args: ['assert-no-lazy-fetch'] });

  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
});

test('a silent Git child is terminated at the trusted deadline', async t => {
  const repoRoot = await temporaryGitRepo(t);
  const pidFile = path.join(repoRoot, 'silent-child.pid');
  await execFileAsync('/usr/bin/git', [
    '-C', repoRoot,
    'config',
    'alias.silent-child',
    `!printf '%s' "$$" > '${pidFile}'; exec /bin/sleep 2`,
  ]);

  await assert.rejects(
    runGit({ repoRoot, args: ['silent-child'], timeoutMs: 50 }),
    error => error?.code === 'git-timeout',
  );

  const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
  assert.throws(() => process.kill(pid, 0), error => error?.code === 'ESRCH');
});
