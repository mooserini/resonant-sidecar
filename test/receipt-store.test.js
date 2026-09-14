import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, chmod, rm, writeFile, stat, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ReceiptStore } from '../review/receipt-store.js';

const digest = 'a'.repeat(64);
function event(eventType = 'available') {
  return { reviewId: 'review-1', eventType, outcome: eventType,
    verifierIdentities: [{ name: 'node', version: '22.0.0' }],
    activeBundleDigest: digest, candidateBundleDigest: digest,
    projectEvidence: { activeVersion: {}, candidateVersion: {}, sourceHashes: {}, dependencyLock: {}, testResults: {} },
    osEvidence: { before: {}, verification: {}, after: {} },
  };
}
async function fixture(t, options = {}) {
  const project = await mkdtemp(path.join(tmpdir(), 'sidecar-custody-'));
  const root = path.join(project, 'review-receipts');
  let tick = 0; let id = 0;
  const base = { root, clock: () => new Date(1789344000000 + tick++), randomUUID: () => `receipt-${++id}`, immutable: async () => {}, ...options };
  const store = new ReceiptStore(base);
  t.after(async () => {
    async function writable(dir) {
      await chmod(dir, 0o700);
      for (const item of await readdir(dir, { withFileTypes: true })) if (item.isDirectory()) await writable(path.join(dir, item.name));
    }
    await writable(project); await rm(project, { recursive: true });
  });
  return { root, project, store, base };
}

test('finalizes the exact evidence layout with reproducible byte hashes and immutable modes', async t => {
  const { root, store } = await fixture(t);
  const first = await store.finalizeEvent(event());
  assert.equal(first.previousReceiptHash, null);
  // Hand-ordered three-path map of the known {} digest, checked with shasum.
  assert.equal(first.osEvidenceHash, '9b4af5558d4c42eaa3ba43c6564a8a264e567d44a705c6701b6331078399f5aa');
  assert.equal(path.basename(first.directory), '2026-09-14T00-00-00.000Z_review-1');
  assert.deepEqual((await readdir(first.directory)).sort(), ['attestation.json', 'os', 'policy-snapshot.json', 'project', 'receipt.json', 'receipt.sha256', 'report.md']);
  assert.deepEqual((await readdir(path.join(first.directory, 'project'))).sort(), ['active-version.json', 'candidate-version.json', 'dependency-lock.json', 'source-hashes.json', 'test-results.json']);
  for (const phase of ['before', 'verification', 'after']) assert.equal(await readFile(path.join(first.directory, 'os', phase, 'evidence.json'), 'utf8'), '{}');
  // Known SHA-256 of the literal canonical bytes "{}", independently derived.
  assert.equal(createHash('sha256').update(await readFile(path.join(first.directory, 'project/source-hashes.json'))).digest('hex'), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  const receiptBytes = await readFile(path.join(first.directory, 'receipt.json'));
  assert.equal(await readFile(path.join(first.directory, 'receipt.sha256'), 'utf8'), `${createHash('sha256').update(receiptBytes).digest('hex')}\n`);
  assert.equal((await stat(first.directory)).mode & 0o777, 0o555);
  assert.equal((await stat(path.join(first.directory, 'receipt.json'))).mode & 0o777, 0o444);
  assert.deepEqual(await readdir(path.join(root, '.pending')), []);
  assert.equal((await store.verifyChain()).state, 'intact');
});

test('hash-chain traversal is independent of directory ordering and keeps one receipt per event', async t => {
  const { store } = await fixture(t, { clock: () => new Date('2026-09-14T00:00:00Z') });
  const first = await store.finalizeEvent(event());
  const second = await store.finalizeEvent(event('review-failed'));
  assert.notEqual(first.directory, second.directory);
  assert.equal(second.previousReceiptHash, first.receiptHash);
  const chain = await store.verifyChain();
  assert.equal(chain.count, 2);
  assert.equal(chain.tailHash, second.receiptHash);
});

for (const deletion of ['first', 'tail', 'all']) {
  test(`removed ${deletion} canonical history blocks append, including after restart`, async t => {
    const { store, base } = await fixture(t);
    const first = await store.finalizeEvent(event());
    const second = await store.finalizeEvent(event('review-failed'));
    for (const receipt of deletion === 'all' ? [first, second] : [deletion === 'first' ? first : second]) {
      async function unlock(dir) { await chmod(dir, 0o700); for (const item of await readdir(dir, { withFileTypes: true })) if (item.isDirectory()) await unlock(path.join(dir, item.name)); }
      await unlock(receipt.directory); await rm(receipt.directory, { recursive: true });
    }
    assert.equal((await new ReceiptStore(base).verifyChain()).state, 'custody-broken');
    await assert.rejects(() => store.finalizeEvent(event()), /custody/i);
  });
}

for (const target of ['report.md', 'attestation.json', 'policy-snapshot.json', 'project/test-results.json', 'os/after/evidence.json', 'receipt.json']) {
  test(`changed ${target} breaks custody`, async t => {
    const { store } = await fixture(t);
    const receipt = await store.finalizeEvent(event());
    const file = path.join(receipt.directory, target);
    await chmod(file, 0o600); await writeFile(file, '{"passed":false}');
    assert.equal((await store.verifyChain()).state, 'custody-broken');
    await assert.rejects(() => store.finalizeEvent(event()), /custody/i);
  });
}

test('failed atomic rename exposes no canonical partial receipt and blocks interrupted append', async t => {
  const { root, store } = await fixture(t, { rename: async (from, to) => {
    if (from.includes(`${path.sep}.pending${path.sep}`)) {
      assert.equal(await readFile(path.join(from, 'os/after/evidence.json'), 'utf8'), '{}');
      throw new Error('simulated interruption');
    }
    return rename(from, to);
  } });
  await assert.rejects(() => store.finalizeEvent(event()), /interruption/);
  assert.equal((await readdir(root)).filter(name => /^2026-/.test(name)).length, 0);
  assert.equal((await store.verifyChain()).state, 'custody-broken');
});

test('immutable failure reports survive pointer corruption and reconstruction', async t => {
  const { root, store } = await fixture(t, { immutable: async () => { throw new Error('not supported'); } });
  assert.equal(await store.resolveLatestFailure(), null);
  const failure = await store.finalizeEvent(event('review-failed'));
  const before = await readFile(path.join(failure.directory, 'receipt.json'));
  await writeFile(path.join(root, 'latest-failure.json'), '{"directory":"/outside"}');
  assert.equal(await store.resolveLatestFailure(), path.join(failure.directory, 'report.md'));
  await rm(path.join(root, 'latest-failure.json'));
  await store.finalizeEvent(event());
  assert.equal(await store.resolveLatestFailure(), path.join(failure.directory, 'report.md'));
  assert.deepEqual(await readFile(path.join(failure.directory, 'receipt.json')), before);
});

test('sanitization rejection retains only fixed safe failure metadata', async t => {
  const { root, store } = await fixture(t);
  const input = event(); input.projectEvidence.testResults = { stdout: 'PAYLOAD_MUST_NEVER_SURVIVE' };
  await assert.rejects(() => store.finalizeEvent(input), /sanitization/i);
  const chain = await store.verifyChain();
  assert.equal(chain.state, 'intact');
  assert.equal(chain.count, 1);
  assert.equal(chain.receipts[0].outcome, 'sanitization-failed');
  async function scan(dir) { for (const item of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) await scan(file); else assert.equal((await readFile(file, 'utf8')).includes('PAYLOAD_MUST_NEVER_SURVIVE'), false); } }
  await scan(root);
});

test('historical comparison directories are preserved and excluded from the formal chain', async t => {
  const { root, store } = await fixture(t);
  for (const name of ['runtime-comparisons', 'repository-comparisons']) { await mkdir(path.join(root, name), { recursive: true }); await writeFile(path.join(root, name, 'receipt.json'), 'historical'); }
  await store.finalizeEvent(event());
  assert.equal((await store.verifyChain()).count, 1);
  assert.equal(await readFile(path.join(root, 'runtime-comparisons/receipt.json'), 'utf8'), 'historical');
});

test('rejects schema, policy, root, and symlink misuse without following evidence links', async t => {
  const { root, project, store } = await fixture(t);
  assert.throws(() => new ReceiptStore({ root: project }), /root/i);
  assert.throws(() => new ReceiptStore({ root, policy: { schemaVersion: 1 } }), /policy/i);
  await assert.rejects(() => store.finalizeEvent({ ...event(), eventType: 'invented' }), /schema/i);
  const receipt = await store.finalizeEvent(event());
  await chmod(receipt.directory, 0o700);
  await rm(path.join(receipt.directory, 'receipt.json'));
  await symlink('/etc/passwd', path.join(receipt.directory, 'receipt.json'));
  assert.equal((await store.verifyChain()).state, 'custody-broken');
});

test('concurrent appends never fork the chain', async t => {
  const { store, base } = await fixture(t);
  const results = await Promise.allSettled([store.finalizeEvent(event()), new ReceiptStore(base).finalizeEvent(event())]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  const chain = await store.verifyChain();
  assert.equal(chain.state, 'intact');
  assert.equal(chain.count, results.filter(result => result.status === 'fulfilled').length);
});

for (const alteration of ['missing', 'mismatched']) {
  test(`${alteration} custody witness blocks append after restart`, async t => {
    const { root, store, base } = await fixture(t);
    await store.finalizeEvent(event());
    const witness = path.join(root, '.custody-head');
    if (alteration === 'missing') await rm(witness);
    else await writeFile(witness, '{"count":0,"tailHash":null}');
    assert.equal((await new ReceiptStore(base).verifyChain()).state, 'custody-broken');
    await assert.rejects(() => store.finalizeEvent(event()), /custody/i);
  });
}

test('restoring altered evidence does not silently clear a recorded custody break', async t => {
  const { store, base } = await fixture(t);
  const receipt = await store.finalizeEvent(event());
  const target = path.join(receipt.directory, 'project/test-results.json');
  const original = await readFile(target);
  await chmod(target, 0o600); await writeFile(target, '{"passed":false}');
  assert.equal((await store.verifyChain()).state, 'custody-broken');
  await writeFile(target, original);
  assert.equal((await new ReceiptStore(base).verifyChain()).state, 'custody-broken');
});

test('interrupted convenience pointer writes do not invalidate canonical receipts', async t => {
  const { store } = await fixture(t, { rename: async (from, to) => {
    if (path.basename(to) === 'latest-failure.json') throw new Error('pointer unavailable');
    return rename(from, to);
  } });
  await store.finalizeEvent(event('review-failed'));
  assert.equal((await store.verifyChain()).state, 'intact');
  await store.finalizeEvent(event());
  assert.equal((await store.verifyChain()).count, 2);
});

test('unexpected empty directories break the exact evidence layout', async t => {
  const { store } = await fixture(t);
  const receipt = await store.finalizeEvent(event());
  await chmod(receipt.directory, 0o700); await mkdir(path.join(receipt.directory, 'untracked'));
  assert.equal((await store.verifyChain()).state, 'custody-broken');
});

test('duplicate generated receipt IDs are refused before exposing a new canonical event', async t => {
  const { store } = await fixture(t, { randomUUID: () => 'same-id' });
  await store.finalizeEvent(event());
  await assert.rejects(() => store.finalizeEvent(event()), /receipt.*ID/i);
  assert.equal((await store.verifyChain()).count, 1);
});

test('loss of required read-only evidence modes is a custody break', async t => {
  const { store } = await fixture(t);
  const receipt = await store.finalizeEvent(event());
  await chmod(path.join(receipt.directory, 'receipt.json'), 0o644);
  assert.equal((await store.verifyChain()).state, 'custody-broken');
});

test('verification serializes with appends and never latches an in-progress checkpoint as corruption', async t => {
  let interruptedRead;
  let store;
  const fixtureResult = await fixture(t, { rename: async (from, to) => {
    if (path.basename(to) === '.custody-head') interruptedRead = await store.verifyChain();
    return rename(from, to);
  } });
  store = fixtureResult.store;
  await store.finalizeEvent(event());
  assert.equal(interruptedRead.state, 'busy');
  assert.equal((await store.verifyChain()).state, 'intact');
});

test('invalid UTF-8 substitution cannot preserve a canonical evidence hash via replacement decoding', async t => {
  const { store } = await fixture(t);
  const input = event();
  input.projectEvidence.testResults = { summary: '\uFFFD' };
  const receipt = await store.finalizeEvent(input);
  const target = path.join(receipt.directory, 'project/test-results.json');
  const original = await readFile(target);
  const marker = original.indexOf(Buffer.from('\uFFFD'));
  assert.ok(marker >= 0);
  const changed = Buffer.concat([original.subarray(0, marker), Buffer.from([0xff]), original.subarray(marker + 3)]);
  assert.notDeepEqual(changed, original);
  assert.equal(changed.toString('utf8'), original.toString('utf8'));
  await chmod(target, 0o600); await writeFile(target, changed); await chmod(target, 0o444);
  assert.equal((await store.verifyChain()).state, 'custody-broken');
  await assert.rejects(() => store.finalizeEvent(event()), /custody/i);
});

test('nested environment evidence yields only fixed sanitized failure metadata', async t => {
  const { root, store } = await fixture(t);
  const input = event();
  input.projectEvidence.testResults = { checks: [{ name: 'AWS_SECRET_ACCESS_KEY', actual: 'SYNTHETIC-CUSTODY-PROBE' }] };
  await assert.rejects(() => store.finalizeEvent(input), /sanitization/i);
  const chain = await store.verifyChain();
  assert.equal(chain.state, 'intact');
  assert.equal(chain.count, 1);
  assert.equal(chain.receipts[0].outcome, 'sanitization-failed');
  assert.equal(chain.receipts[0].reviewId, 'sanitization-failure');
  async function scan(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, item.name);
      if (item.isDirectory()) await scan(target);
      else assert.doesNotMatch(await readFile(target, 'utf8'), /SYNTHETIC-CUSTODY-PROBE|AWS_SECRET_ACCESS_KEY/);
    }
  }
  await scan(root);
});

for (const swap of ['file', 'parent-directory']) {
  test(`post-rename ${swap} symlink substitution cannot chmod unrelated material or succeed`, async t => {
    let outside;
    const { project, store } = await fixture(t, { rename: async (from, to) => {
      await rename(from, to);
      if (from.includes(`${path.sep}.pending${path.sep}`)) {
        if (swap === 'file') {
          await rm(path.join(to, 'report.md'));
          await symlink(path.join(outside, 'unrelated.txt'), path.join(to, 'report.md'));
        } else {
          await rename(path.join(to, 'project'), path.join(to, 'displaced-project'));
          await symlink(outside, path.join(to, 'project'));
        }
      }
    } });
    outside = path.join(project, 'outside');
    await mkdir(outside, { mode: 0o700 });
    for (const name of ['unrelated.txt', 'active-version.json', 'candidate-version.json', 'source-hashes.json', 'dependency-lock.json', 'test-results.json']) await writeFile(path.join(outside, name), 'unrelated', { mode: 0o600 });
    const result = await Promise.allSettled([store.finalizeEvent(event())]);
    assert.equal((await stat(path.join(outside, swap === 'file' ? 'unrelated.txt' : 'active-version.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(outside)).mode & 0o777, 0o700);
    assert.equal(await readFile(path.join(outside, 'unrelated.txt'), 'utf8'), 'unrelated');
    assert.equal(result[0].status, 'rejected');
    assert.equal((await store.verifyChain()).state, 'custody-broken');
  });
}
