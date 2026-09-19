import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, symlink, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { VersionStore } from './fixtures/runtime-components.js';
import { runtimeFixture, decisionFor, consumer } from './fixtures/runtime.js';

test('uses the supplied runtime lock provider instead of the production default', async t => {
  const f = await runtimeFixture(t); const staged = await f.stage('injected-lock');
  const withRuntimeLock = async () => { throw new Error('injected runtime lock reached'); };
  const store = new VersionStore({ projectRoot: f.projectRoot, withRuntimeLock });
  await assert.rejects(() => store.installVersion(staged), /injected runtime lock reached/);
});

test('install seals exact staged bytes and activation resolves only a consumed matching decision', async t => {
  const f = await runtimeFixture(t); const staged = await f.stage('first');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await assert.rejects(() => store.resolveActiveHost(), /active/i);
  await store.installVersion(staged);
  await store.activate(decisionFor(staged));
  const active = await store.resolveActiveHost();
  assert.equal(active.hostPath, path.join(f.root, 'versions', staged.manifest.bundleDigest, 'bundle/native-host/host.js'));
  assert.equal((await lstat(active.hostPath)).mode & 0o777, 0o400);
  assert.equal(await readFile(active.hostPath, 'utf8'), 'process.stdin.resume();');
  await store.completeActivation(decisionFor(staged));
  await assert.rejects(() => store.activate(decisionFor(staged)), /nonce|active/i);
});

test('untrusted or mismatching consent cannot switch active state', async t => {
  const f = await runtimeFixture(t); const staged = await f.stage('first');
  for (const consumeDecision of [undefined, async d => ({ ...d, consumed: false }), async d => ({ ...d, consumed: true, reviewId: 'other' })]) {
    const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision });
    await store.installVersion(staged);
    await assert.rejects(() => store.activate(decisionFor(staged)), /decision/i);
    await assert.rejects(() => store.resolveActiveHost(), /active/i);
  }
});

test('install refuses altered quarantine, unlisted files, and wrong review paths', async t => {
  const f = await runtimeFixture(t); const staged = await f.stage('first');
  const store = new VersionStore({ projectRoot: f.projectRoot });
  await assert.rejects(() => store.installVersion({ ...staged, bundleRoot: f.projectRoot }), /path|quarantine/i);
  await chmod(staged.bundleRoot, 0o700);
  await writeFile(path.join(staged.bundleRoot, 'extra.js'), 'bad', { mode: 0o400 });
  await assert.rejects(() => store.installVersion(staged), /inventory/i);
  const other = await f.stage('second');
  await chmod(path.join(other.bundleRoot, 'native-host/host.js'), 0o600);
  await writeFile(path.join(other.bundleRoot, 'native-host/host.js'), 'changed');
  await chmod(path.join(other.bundleRoot, 'native-host/host.js'), 0o400);
  await assert.rejects(() => store.installVersion(other), /digest/i);
});

test('symlinked runtime and permissive custody fail closed', async t => {
  const f = await runtimeFixture(t); const staged = await f.stage('first');
  await mkdir(path.join(f.projectRoot, 'outside'), { mode: 0o700 });
  await symlink(path.join(f.projectRoot, 'outside'), path.join(f.root, 'versions'));
  await assert.rejects(() => new VersionStore({ projectRoot: f.projectRoot }).installVersion(staged), /symbolic|custody/i);
  await chmod(f.root, 0o755);
  await assert.rejects(() => new VersionStore({ projectRoot: f.projectRoot }).resolveActiveHost(), /custody/i);
});

test('resolve and duplicate install reject tampering without overwriting the digest version', async t => {
  const f = await runtimeFixture(t); const staged = await f.stage('first');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(staged); await store.activate(decisionFor(staged));
  await store.completeActivation(decisionFor(staged));
  const { hostPath } = await store.resolveActiveHost();
  await chmod(hostPath, 0o600); await writeFile(hostPath, 'bad'); await chmod(hostPath, 0o400);
  await assert.rejects(() => store.resolveActiveHost(), /digest/i);
  await assert.rejects(() => store.installVersion(staged), /digest/i);
  assert.equal(await readFile(hostPath, 'utf8'), 'bad');
});

test('rollback retains previous and failure identity while restoring verified prior bytes', async t => {
  const f = await runtimeFixture(t); const first = await f.stage('first'); const next = await f.stage('next', '// next');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(first); await store.activate(decisionFor(first)); await store.completeActivation(decisionFor(first));
  await store.installVersion(next); await store.activate(decisionFor(next, 'm'.repeat(32)));
  await store.rollback({ reviewId: 'next', candidateDigest: next.manifest.bundleDigest, failureRef: 'failure-receipt-1' });
  assert.equal((await store.resolveActiveHost()).digest, first.manifest.bundleDigest);
  const state = JSON.parse(await readFile(path.join(f.root, 'recovery-state.json'), 'utf8'));
  assert.equal(state.phase, 'rolled-back'); assert.equal(state.failureRef, 'failure-receipt-1');
  assert.equal(state.candidate.digest, next.manifest.bundleDigest);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'previous/pin.json'), 'utf8')).digest, first.manifest.bundleDigest);
});

test('an installed digest cannot be activated under a different review identity', async t => {
  const f = await runtimeFixture(t); const staged = await f.stage('first');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(staged);
  await assert.rejects(() => store.activate({ ...decisionFor(staged), reviewId: 'not-installed' }), /review/i);
});

test('completion refuses a changed policy and a tampered canonical active pin blocks a new activation', async t => {
  const f = await runtimeFixture(t); const first = await f.stage('first'); const next = await f.stage('next', '// next');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(first); await store.activate(decisionFor(first));
  await assert.rejects(() => store.completeActivation({ ...decisionFor(first), policyDigest: 'c'.repeat(64) }), /completion|decision/i);
  await store.completeActivation(decisionFor(first)); await store.installVersion(next);
  await writeFile(path.join(f.root, 'active/pin.json'), 'null\n');
  await assert.rejects(() => store.activate(decisionFor(next, 'm'.repeat(32))), /pin|recovery/i);
});

test('persisted nonce consumption blocks replay after coordinator and store restart', async t => {
  const f = await runtimeFixture(t); const first = await f.stage('first'); const next = await f.stage('next', '// next');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(first); await store.activate(decisionFor(first)); await store.completeActivation(decisionFor(first));
  await store.installVersion(next);
  const restarted = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await assert.rejects(() => restarted.activate(decisionFor(next)), /nonce/i);
  assert.equal((await restarted.resolveActiveHost()).digest, first.manifest.bundleDigest);
});

test('caller mutation after activate cannot replace the validated A decision with B', async t => {
  const f = await runtimeFixture(t); const a = await f.stage('a'); const b = await f.stage('b', '// b');
  let consumed;
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: async d => { consumed = d; return { ...d, consumed: true }; } });
  await store.installVersion(a); await store.installVersion(b);
  const decision = decisionFor(a); const expected = { ...decision };
  const activation = store.activate(decision);
  Object.assign(decision, decisionFor(b, 'm'.repeat(32)));
  const result = await activation;
  assert.deepEqual(consumed, expected);
  assert.equal(Object.isFrozen(consumed), true);
  assert.equal(result.candidate.digest, a.manifest.bundleDigest);
  await store.completeActivation(expected);
  assert.equal((await store.resolveActiveHost()).digest, a.manifest.bundleDigest);
});

for (const operation of ['rollback', 'recover']) {
  test(`${operation} restores healthy A even when failed pending B bytes are corrupt`, async t => {
    const f = await runtimeFixture(t); const a = await f.stage('a'); const b = await f.stage('b', '// b');
    const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
    await store.installVersion(a); await store.activate(decisionFor(a)); await store.completeActivation(decisionFor(a));
    await store.installVersion(b); await store.activate(decisionFor(b, 'm'.repeat(32)));
    const corrupt = path.join(f.root, 'versions', b.manifest.bundleDigest, 'bundle/native-host/host.js');
    await chmod(corrupt, 0o600); await writeFile(corrupt, 'corrupt B evidence'); await chmod(corrupt, 0o400);
    if (operation === 'rollback') await store.rollback({ reviewId: 'b', candidateDigest: b.manifest.bundleDigest, failureRef: 'failed-b' });
    else await new VersionStore({ projectRoot: f.projectRoot }).recover();
    assert.equal((await store.resolveActiveHost()).digest, a.manifest.bundleDigest);
    assert.equal(await readFile(corrupt, 'utf8'), 'corrupt B evidence');
    const state = JSON.parse(await readFile(path.join(f.root, 'recovery-state.json'), 'utf8'));
    assert.equal(state.candidate.digest, b.manifest.bundleDigest); assert.equal(state.phase, 'rolled-back');
  });
}

test('rollback refuses corrupt previous A and preserves pending B state', async t => {
  const f = await runtimeFixture(t); const a = await f.stage('a'); const b = await f.stage('b', '// b');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(a); await store.activate(decisionFor(a)); await store.completeActivation(decisionFor(a));
  await store.installVersion(b); await store.activate(decisionFor(b, 'm'.repeat(32)));
  const corrupt = path.join(f.root, 'versions', a.manifest.bundleDigest, 'bundle/native-host/host.js');
  await chmod(corrupt, 0o600); await writeFile(corrupt, 'corrupt A'); await chmod(corrupt, 0o400);
  await assert.rejects(() => store.rollback({ reviewId: 'b', candidateDigest: b.manifest.bundleDigest, failureRef: 'failed-b' }), /digest/i);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'recovery-state.json'), 'utf8')).phase, 'pending-verification');
});
