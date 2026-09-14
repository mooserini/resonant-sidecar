import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { inspectLocalCandidate, stageLocalCandidate } from '../review/candidate-source.js';
import { runGit } from '../review/git-runner.js';
import { createFakeGit } from './fixtures/fake-git.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = 'c66b92d3b6a97c24cc27b611911e0076f0dbec28f34259f22cbd18011fe6bfd3';
const FILES = {
  'extension/manifest.json': {
    bytes: '{"manifest_version":3,"name":"Candidate","version":"1.0.0","permissions":["nativeMessaging","sidePanel","storage"]}\n',
  },
  'native-host/host.js': { bytes: 'export const candidate = true;\n' },
  'package.json': { bytes: '{"name":"candidate","version":"1.0.0","private":true,"type":"module"}\n' },
};
const policy = {
  schemaVersion: 1,
  approvedBundlePaths: Object.keys(FILES),
};
const execFileAsync = promisify(execFile);

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'resonant-candidate-'));
  t.after(async () => {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function makeWritable(target) {
  const info = await lstat(target).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(target, 0o700);
    for (const entry of await readdir(target)) await makeWritable(path.join(target, entry));
  } else {
    await chmod(target, 0o600);
  }
}

async function realGit(repoRoot, args) {
  return execFileAsync('/usr/bin/git', ['-C', repoRoot, ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
}

async function realCandidateRepo(t) {
  const repoRoot = await temporaryRoot(t);
  for (const [filePath, entry] of Object.entries(FILES)) {
    const destination = path.join(repoRoot, ...filePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes);
  }
  await realGit(repoRoot, ['init']);
  await realGit(repoRoot, ['config', 'user.name', 'Candidate Test']);
  await realGit(repoRoot, ['config', 'user.email', 'candidate@example.invalid']);
  await realGit(repoRoot, ['add', '--', ...policy.approvedBundlePaths]);
  await realGit(repoRoot, ['commit', '-m', 'candidate']);
  return repoRoot;
}

test('clean committed HEAD is available without copying or executing candidate files', async t => {
  const repoRoot = await temporaryRoot(t);
  const git = createFakeGit({ files: FILES });

  const result = await inspectLocalCandidate({ repoRoot, activeDigest: '0'.repeat(64), policy, git });

  assert.deepEqual(result, { state: 'available', commit: COMMIT, digest: DIGEST });
  await assert.rejects(readFile(path.join(repoRoot, 'package.json')), /ENOENT/);
  assert.equal(git.calls.some(call => ['fetch', 'pull', 'clone'].includes(call.args[0])), false);
});

test('uncommitted bundle input cannot become an available candidate', async t => {
  const repoRoot = await temporaryRoot(t);
  const git = createFakeGit({ files: FILES, status: ' M native-host/host.js\n' });

  const result = await inspectLocalCandidate({ repoRoot, activeDigest: '0'.repeat(64), policy, git });

  assert.deepEqual(result, { state: 'blocked', reason: 'bundle-inputs-dirty' });
  assert.equal(git.calls.some(call => call.args.includes('fetch')), false);
});

test('untracked bundle input cannot become an available candidate', async t => {
  const repoRoot = await temporaryRoot(t);
  const git = createFakeGit({ files: FILES, status: '?? native-host/host.js\n' });

  const result = await inspectLocalCandidate({ repoRoot, activeDigest: '0'.repeat(64), policy, git });

  assert.deepEqual(result, { state: 'blocked', reason: 'bundle-inputs-dirty' });
});

test('a committed bundle matching the active digest is unavailable', async t => {
  const repoRoot = await temporaryRoot(t);
  const git = createFakeGit({ files: FILES });

  const result = await inspectLocalCandidate({ repoRoot, activeDigest: DIGEST, policy, git });

  assert.deepEqual(result, { state: 'unavailable', reason: 'already-active' });
});

test('Git tree types and modes must describe one regular blob per approved path', async t => {
  const repoRoot = await temporaryRoot(t);
  for (const [name, override] of [
    ['symlink', { mode: '120000', type: 'blob' }],
    ['submodule', { mode: '160000', type: 'commit' }],
    ['tree', { mode: '040000', type: 'tree' }],
    ['special mode', { mode: '100600', type: 'blob' }],
  ]) {
    const git = createFakeGit({
      files: { ...FILES, 'native-host/host.js': { ...FILES['native-host/host.js'], ...override } },
    });
    const result = await inspectLocalCandidate({ repoRoot, activeDigest: '0'.repeat(64), policy, git });
    assert.deepEqual(result, { state: 'blocked', reason: 'candidate-tree-invalid' }, name);
  }

  const missingFiles = { ...FILES };
  delete missingFiles['native-host/host.js'];
  const missing = createFakeGit({ files: missingFiles });
  assert.deepEqual(
    await inspectLocalCandidate({ repoRoot, activeDigest: '0'.repeat(64), policy, git: missing }),
    { state: 'blocked', reason: 'candidate-tree-invalid' },
  );
});

test('policy traversal and duplicate bundle paths are rejected before Git runs', async t => {
  const repoRoot = await temporaryRoot(t);
  for (const approvedBundlePaths of [
    ['extension/manifest.json', '../escape'],
    ['extension/manifest.json', 'extension/manifest.json'],
  ]) {
    const git = createFakeGit({ files: FILES });
    const result = await inspectLocalCandidate({
      repoRoot,
      activeDigest: '0'.repeat(64),
      policy: { schemaVersion: 1, approvedBundlePaths },
      git,
    });
    assert.deepEqual(result, { state: 'blocked', reason: 'policy-invalid' });
    assert.equal(git.calls.length, 0);
  }
});

test('staging writes exact committed bytes under the validated quarantine and seals the bundle read-only', async t => {
  const repoRoot = await temporaryRoot(t);
  const quarantineRoot = path.join(repoRoot, 'runtime', 'quarantine');
  const git = createFakeGit({ files: FILES });
  await mkdir(path.join(repoRoot, 'native-host'), { recursive: true });
  await writeFile(path.join(repoRoot, 'native-host', 'host.js'), 'working tree bytes must not be staged\n');

  const staged = await stageLocalCandidate({ repoRoot, reviewId: 'review-01', quarantineRoot, policy, git });

  const expectedRoot = path.join(quarantineRoot, 'review-01', 'bundle');
  assert.equal(staged.bundleRoot, expectedRoot);
  assert.equal(staged.manifestPath, path.join(quarantineRoot, 'review-01', 'staging-manifest.json'));
  assert.equal(staged.manifest.bundleDigest, DIGEST);
  assert.equal(staged.manifest.sourceCommit, COMMIT);
  assert.equal(await readFile(path.join(expectedRoot, 'native-host', 'host.js'), 'utf8'), FILES['native-host/host.js'].bytes);
  assert.deepEqual(JSON.parse(await readFile(staged.manifestPath, 'utf8')), staged.manifest);
  assert.equal((await lstat(expectedRoot)).mode & 0o777, 0o500);
  assert.equal((await lstat(path.join(expectedRoot, 'native-host', 'host.js'))).mode & 0o777, 0o400);
  assert.equal((await lstat(staged.manifestPath)).mode & 0o777, 0o400);
});

test('staging does not execute candidate lifecycle scripts or entry points', async t => {
  const repoRoot = await temporaryRoot(t);
  const quarantineRoot = path.join(repoRoot, 'runtime', 'quarantine');
  const marker = path.join(repoRoot, 'executed');
  const files = {
    ...FILES,
    'package.json': {
      bytes: JSON.stringify({
        name: 'candidate',
        version: '1.0.0',
        scripts: { postinstall: `touch ${marker}`, start: `touch ${marker}` },
      }),
    },
    'native-host/host.js': { bytes: `await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(marker)}, 'executed'));\n` },
  };

  await stageLocalCandidate({ repoRoot, reviewId: 'review-no-exec', quarantineRoot, policy, git: createFakeGit({ files }) });

  await assert.rejects(lstat(marker), /ENOENT/);
});

test('staging rejects dirty inputs without creating quarantine state', async t => {
  const repoRoot = await temporaryRoot(t);
  const quarantineRoot = path.join(repoRoot, 'runtime', 'quarantine');
  const git = createFakeGit({ files: FILES, status: ' M package.json\n' });

  await assert.rejects(
    stageLocalCandidate({ repoRoot, reviewId: 'review-dirty', quarantineRoot, policy, git }),
    error => error?.code === 'bundle-inputs-dirty',
  );
  await assert.rejects(lstat(path.join(quarantineRoot, 'review-dirty')), /ENOENT/);
});

test('bundle input changes during staging invalidate and remove the new quarantine', async t => {
  const repoRoot = await temporaryRoot(t);
  const quarantineRoot = path.join(repoRoot, 'runtime', 'quarantine');
  const git = createFakeGit({ files: FILES, statuses: ['', '', ' M package.json\n'] });

  await assert.rejects(
    stageLocalCandidate({ repoRoot, reviewId: 'review-raced', quarantineRoot, policy, git }),
    error => error?.code === 'bundle-inputs-dirty',
  );
  await assert.rejects(lstat(path.join(quarantineRoot, 'review-raced')), /ENOENT/);
});

test('ancestor substitution cannot redirect failed-staging cleanup into unrelated data', async t => {
  const repoRoot = await temporaryRoot(t);
  const outside = await temporaryRoot(t);
  const quarantineRoot = path.join(repoRoot, 'runtime', 'quarantine');
  const movedQuarantine = path.join(repoRoot, 'runtime', 'quarantine-created');
  const outsideReview = path.join(outside, 'review-custody');
  await mkdir(outsideReview);
  await writeFile(path.join(outsideReview, 'preserved.txt'), 'unrelated');
  const git = createFakeGit({
    files: FILES,
    statuses: ['', '', ' M package.json\n'],
    onStatus: async ({ index }) => {
      if (index !== 2) return;
      await rename(quarantineRoot, movedQuarantine);
      await symlink(outside, quarantineRoot);
    },
  });

  let caught;
  try {
    await stageLocalCandidate({ repoRoot, reviewId: 'review-custody', quarantineRoot, policy, git });
  } catch (error) {
    caught = error;
  }
  assert.equal(await readFile(path.join(outsideReview, 'preserved.txt'), 'utf8'), 'unrelated');
  assert.equal((await lstat(path.join(movedQuarantine, 'review-custody'))).isDirectory(), true);
  assert.equal(caught?.code, 'quarantine-custody-changed');
});

test('archive extraction containment rejects traversal, an outside root, and symlinked quarantine components', async t => {
  const repoRoot = await temporaryRoot(t);
  const outside = await temporaryRoot(t);
  const git = createFakeGit({ files: FILES });

  await assert.rejects(
    stageLocalCandidate({ repoRoot, reviewId: '../escape', quarantineRoot: path.join(repoRoot, 'runtime', 'quarantine'), policy, git }),
    error => error?.code === 'quarantine-path-invalid',
  );
  await assert.rejects(
    stageLocalCandidate({ repoRoot, reviewId: 'review-outside', quarantineRoot: outside, policy, git }),
    error => error?.code === 'quarantine-path-invalid',
  );

  await mkdir(path.join(repoRoot, 'runtime'));
  await symlink(outside, path.join(repoRoot, 'runtime', 'quarantine'));
  await assert.rejects(
    stageLocalCandidate({ repoRoot, reviewId: 'review-link', quarantineRoot: path.join(repoRoot, 'runtime', 'quarantine'), policy, git }),
    error => error?.code === 'quarantine-path-invalid',
  );
});

test('an existing review directory is never overwritten', async t => {
  const repoRoot = await temporaryRoot(t);
  const quarantineRoot = path.join(repoRoot, 'runtime', 'quarantine');
  const reviewRoot = path.join(quarantineRoot, 'review-existing');
  await mkdir(reviewRoot, { recursive: true });
  await writeFile(path.join(reviewRoot, 'preserved.txt'), 'historical evidence');

  await assert.rejects(
    stageLocalCandidate({ repoRoot, reviewId: 'review-existing', quarantineRoot, policy, git: createFakeGit({ files: FILES }) }),
    error => error?.code === 'quarantine-exists',
  );
  assert.equal(await readFile(path.join(reviewRoot, 'preserved.txt'), 'utf8'), 'historical evidence');
});

test('default Git runner reads the real local repository with fixed argv', async () => {
  const repoRoot = path.resolve('.');
  const result = await runGit({ repoRoot, args: ['rev-parse', '--is-inside-work-tree'] });
  assert.equal(result.stdout.toString('utf8').trim(), 'true');
});

test('availability neutralizes a repository-configured fsmonitor executable', async t => {
  const repoRoot = await realCandidateRepo(t);
  const marker = path.join(repoRoot, 'fsmonitor-executed');
  const monitor = path.join(repoRoot, 'fsmonitor.sh');
  await writeFile(monitor, `#!/bin/sh\n/usr/bin/touch '${marker}'\nprintf '\\0'\n`);
  await chmod(monitor, 0o700);
  await realGit(repoRoot, ['config', 'core.fsmonitor', monitor]);

  const result = await inspectLocalCandidate({ repoRoot, activeDigest: '0'.repeat(64), policy });

  assert.equal(result.state, 'available');
  await assert.rejects(lstat(marker), /ENOENT/);
});

test('assume-unchanged cannot conceal a modified approved bundle input', async t => {
  const repoRoot = await realCandidateRepo(t);
  await realGit(repoRoot, ['update-index', '--assume-unchanged', 'native-host/host.js']);
  await writeFile(path.join(repoRoot, 'native-host', 'host.js'), 'hidden working-tree modification\n');
  assert.equal((await realGit(repoRoot, ['status', '--porcelain=v1'])).stdout, '');

  const result = await inspectLocalCandidate({ repoRoot, activeDigest: '0'.repeat(64), policy });

  assert.deepEqual(result, { state: 'blocked', reason: 'bundle-inputs-dirty' });
});

test('skip-worktree cannot conceal a missing approved bundle input', async t => {
  const repoRoot = await realCandidateRepo(t);
  await realGit(repoRoot, ['update-index', '--skip-worktree', 'package.json']);
  await rm(path.join(repoRoot, 'package.json'));
  assert.equal((await realGit(repoRoot, ['status', '--porcelain=v1'])).stdout, '');

  const result = await inspectLocalCandidate({ repoRoot, activeDigest: '0'.repeat(64), policy });

  assert.deepEqual(result, { state: 'blocked', reason: 'bundle-inputs-dirty' });
});
