import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, chmod, rm, writeFile, stat, symlink, rename, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ReceiptStore } from '../review/receipt-store.js';
import { loadReviewPolicy } from '../review/policy-registry.js';
import { canonicalJson, sha256Json } from '../review/canonical-json.js';
import { chromeReceipt } from './fixtures/chrome-receipt.js';
import { sourceFixture } from './fixtures/semantic-source.js';
import { buildSourceDiff } from '../review/source-diff.js';
import { buildSemanticEvidence, buildChromeReviewRequest } from '../review/semantic-evidence.js';
import { bindChromeReviewResult } from '../review/chrome-review.js';

const digest = 'a'.repeat(64);
function event(eventType = 'available') {
  return { reviewId: 'review-1', eventType, outcome: eventType,
    verifierIdentities: [{ name: 'node', version: '22.0.0' }],
    activeBundleDigest: digest, candidateBundleDigest: digest,
    projectEvidence: { activeVersion: {}, candidateVersion: {}, sourceHashes: {}, dependencyLock: {}, testResults: {} },
    osEvidence: { before: {}, verification: {}, after: {} },
  };
}

const semanticFile = 'semantic-reviews/chrome-language-model.json';
const goldenRoot = new URL('./fixtures/receipts/v1/review-receipts/', import.meta.url);
async function goldenHashes() {
  const readme = await readFile(new URL('./fixtures/receipts/v1/README.md', import.meta.url), 'utf8');
  return [...readme.matchAll(/^([a-f0-9]{64})  review-receipts\/(.+)$/gm)].map(([, hash, name]) => [name, hash]);
}
async function assertGolden(root, { canonicalOnly = false } = {}) {
  const hashes = await goldenHashes();
  assert.equal(hashes.length, 28);
  for (const [name, hash] of hashes) {
    if (canonicalOnly && !name.startsWith('2026-')) continue;
    assert.equal(createHash('sha256').update(await readFile(new URL(name, root))).digest('hex'), hash, name);
  }
}
async function copyGolden(root) {
  await cp(goldenRoot, root, { recursive: true });
  await mkdir(path.join(root, '.pending'), { recursive: true });
  async function seal(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await seal(target); else await chmod(target, 0o444);
    }
    await chmod(dir, 0o555);
  }
  for (const name of await readdir(root)) if (name.startsWith('2026-')) await seal(path.join(root, name));
}
async function enterChrome(store) {
  for (const type of ['available', 'staged', 'deterministic-review', 'codex-review', 'chrome-semantic-review']) await store.finalizeEvent(event(type));
}

test('retains actual Task 3 request and Task 4 result binding without changing generation or invocation types', async t => {
  const files = await sourceFixture(t);
  const policy = loadReviewPolicy(2);
  const bindings = { activeBundleDigest: files.activeManifest.bundleDigest, candidateBundleDigest: files.candidateManifest.bundleDigest };
  const common = buildSemanticEvidence({ reviewId: 'review-1', activeManifest: files.activeManifest, candidateManifest: files.candidateManifest, policy,
    deterministic: { passed: true, checks: [], ...bindings, policySnapshotHash: sha256Json(policy) }, sourceDiff: await buildSourceDiff(files) });
  const request = buildChromeReviewRequest({ ...common, invocationId: 'request:v2.test_1', runtimeGeneration: 0, adapterDigest: 'e'.repeat(64), deadline: '2026-09-14T12:01:00.000Z' });
  const shape = chromeReceipt();
  const { type, transportBinding: binding, ...result } = bindChromeReviewResult({ request, rawText: JSON.stringify(shape.analysis),
    browserObservation: shape.browserObservation, componentObservation: shape.componentObservation, completedAt: '2026-09-14T12:00:30.000Z' });
  assert.equal(type, 'ChromeReviewResult');
  const semanticReview = chromeReceipt({ ...result, ...bindings, reviewId: binding.reviewId, invocationId: binding.invocationId, runtimeGeneration: binding.runtimeGeneration,
    policySnapshotHash: binding.policyDigest, inputDigest: binding.inputDigest, promptDigest: binding.promptDigest, schemaDigest: binding.schemaDigest, adapterDigest: binding.adapterDigest,
    startedAt: '2026-09-14T12:00:00.000Z' });
  const { store } = await fixture(t, { policy, clock: () => new Date('2026-09-14T12:01:00.000Z') });
  for (const kind of ['available', 'staged', 'deterministic-review', 'codex-review', 'chrome-semantic-review']) await store.finalizeEvent({ ...event(kind), ...bindings });
  const receipt = await store.finalizeEvent({ ...event('eligible'), ...bindings, semanticReview });
  assert.equal(receipt.semanticReview.runtimeGeneration, 0);
  assert.equal(receipt.semanticReview.invocationId, 'request:v2.test_1');
  assert.equal(receipt.semanticReview.inputDigest, request.transportBinding.inputDigest);
  assert.equal((await store.verifyChain()).state, 'intact');
});

test('golden pre-V2 chain verifies without changing any historical bytes', async t => {
  const { root, base } = await fixture(t);
  await assertGolden(goldenRoot);
  await copyGolden(root);
  const chain = await new ReceiptStore({ ...base, policy: loadReviewPolicy(2) }).verifyChain();
  assert.equal(chain.state, 'intact'); assert.equal(chain.count, 2);
  assert.equal(chain.tailHash, 'c2a28877cf698c504739dd2f3089c14b0f128c66bc8dcbc1791e292fa650aeb5');
  await assertGolden(new URL(`file://${root}/`));
});

test('V1 prefix remains byte-identical while V2 introduces then carries one terminal artifact', async t => {
  const { root, base } = await fixture(t);
  await copyGolden(root);
  const store = new ReceiptStore({ ...base, policy: loadReviewPolicy(2) });
  for (const type of ['available', 'staged', 'deterministic-review', 'codex-review', 'chrome-semantic-review']) {
    const receipt = await store.finalizeEvent(event(type));
    assert.equal(receipt.semanticReviewsHash, null);
    await assert.rejects(() => stat(path.join(receipt.directory, 'semantic-reviews')), { code: 'ENOENT' });
  }
  const semanticReview = chromeReceipt();
  const eligible = await store.finalizeEvent({ ...event('eligible'), semanticReview });
  const bytes = await readFile(path.join(eligible.directory, semanticFile));
  assert.equal(bytes.toString(), canonicalJson(semanticReview));
  assert.equal(eligible.semanticReviewsHash, createHash('sha256').update(bytes).digest('hex'));
  semanticReview.analysis.summary = 'Caller mutation must not alter retained evidence';
  for (const type of ['human-accepted', 'activating', 'activation-failed', 'rolling-back', 'rolled-back']) {
    const next = await new ReceiptStore({ ...base, policy: loadReviewPolicy(2) }).finalizeEvent(event(type));
    assert.equal(next.semanticReviewsHash, eligible.semanticReviewsHash);
    assert.deepEqual(await readFile(path.join(next.directory, semanticFile)), bytes);
  }
  const chain = await store.verifyChain();
  assert.equal(chain.state, 'intact'); assert.equal(chain.count, 13);
  for (const old of chain.receipts.slice(0, 2)) {
    assert.equal(Object.hasOwn(old, 'semanticReviewsHash'), false);
    await assert.rejects(() => stat(path.join(old.directory, 'semantic-reviews')), { code: 'ENOENT' });
  }
  await assertGolden(new URL(`file://${root}/`), { canonicalOnly: true });
  await assertGolden(goldenRoot);
});

test('V2 terminal failure atomically introduces and seals the required artifact', async t => {
  const { store } = await fixture(t, { policy: loadReviewPolicy(2), rename: async (from, to) => {
    if (from.includes(`${path.sep}.pending${path.sep}`)) {
      const receipt = JSON.parse(await readFile(path.join(from, 'receipt.json')));
      if (receipt.eventType === 'review-failed') assert.equal(receipt.semanticReviewsHash, createHash('sha256').update(await readFile(path.join(from, semanticFile))).digest('hex'));
    }
    await rename(from, to);
  } });
  await enterChrome(store);
  const semanticReview = chromeReceipt({ executionStatus: 'failed', reasonCode: 'timeout', analysis: null, analysisDigest: null, eligibilityEffect: 'candidate-withheld' });
  const receipt = await store.finalizeEvent({ ...event('review-failed'), semanticReview });
  assert.equal(receipt.semanticReviewsHash, sha256Json(semanticReview));
  assert.equal((await stat(path.join(receipt.directory, 'semantic-reviews'))).mode & 0o777, 0o555);
  assert.equal((await stat(path.join(receipt.directory, semanticFile))).mode & 0o777, 0o444);
  assert.equal((await store.verifyChain()).state, 'intact');
});

test('only the incomplete-input failure may bind before Chrome entry and all its digests remain required', async t => {
  const { store } = await fixture(t, { policy: loadReviewPolicy(2) });
  for (const type of ['available', 'staged', 'deterministic-review']) await store.finalizeEvent(event(type));
  await assert.rejects(() => store.finalizeEvent({ ...event('eligible'), semanticReview: chromeReceipt() }));
  const semanticReview = chromeReceipt({ coverageStatus: 'incomplete-input', availabilityStatus: 'not-checked', executionStatus: 'not-run', reasonCode: 'incomplete-input', analysis: null, analysisDigest: null, eligibilityEffect: 'candidate-withheld' });
  const receipt = await store.finalizeEvent({ ...event('review-failed'), semanticReview });
  assert.equal(receipt.semanticReviewsHash, sha256Json(semanticReview));
  assert.equal((await store.verifyChain()).state, 'intact');
});

test('incomplete-input chronology cannot satisfy an already pending Chrome entry', async t => {
  const { store } = await fixture(t, { policy: loadReviewPolicy(2) });
  await enterChrome(store);
  const semanticReview = chromeReceipt({ coverageStatus: 'incomplete-input', availabilityStatus: 'not-checked', executionStatus: 'not-run', reasonCode: 'incomplete-input', analysis: null, analysisDigest: null, eligibilityEffect: 'candidate-withheld' });
  await assert.rejects(() => store.finalizeEvent({ ...event('review-failed'), semanticReview }), /schema|custody/i);
  const chain = await store.verifyChain();
  assert.equal(chain.state, 'intact'); assert.equal(chain.count, 5);
  assert.equal(chain.receipts.at(-1).eventType, 'chrome-semantic-review');
});

test('incomplete-input chronology remains invalid after contradictory Chrome history is fully rehashed', async t => {
  const { store, root } = await fixture(t, { policy: loadReviewPolicy(2) });
  await enterChrome(store);
  await store.finalizeEvent({ ...event('review-failed'), semanticReview: chromeReceipt({ executionStatus: 'failed', reasonCode: 'timeout', analysis: null, analysisDigest: null, eligibilityEffect: 'candidate-withheld' }) });
  const chain = await store.verifyChain();
  await rehashHistory(root, chain.receipts, async (receipt, directory, index) => {
    if (index !== 5) return;
    const artifact = chromeReceipt({ coverageStatus: 'incomplete-input', availabilityStatus: 'not-checked', executionStatus: 'not-run', reasonCode: 'incomplete-input', analysis: null, analysisDigest: null, eligibilityEffect: 'candidate-withheld' });
    const target = path.join(directory, semanticFile);
    await chmod(target, 0o600); await writeFile(target, canonicalJson(artifact)); await chmod(target, 0o444);
    receipt.semanticReviewsHash = sha256Json(artifact);
  });
  assert.equal((await store.verifyChain()).state, 'custody-broken');
});

test('V2 cannot omit the first terminal artifact or attach one at Chrome entry', async t => {
  const { store } = await fixture(t, { policy: loadReviewPolicy(2) });
  await assert.rejects(() => store.finalizeEvent({ ...event('chrome-semantic-review'), semanticReview: chromeReceipt() }));
  await enterChrome(store);
  for (const type of ['eligible', 'review-failed']) await assert.rejects(() => store.finalizeEvent(event(type)), /semantic|schema|custody/i);
  assert.equal((await store.verifyChain()).count, 5);
});

test('V2 cannot change or explicitly drop bound Chrome evidence, bundles or review policy', async t => {
  const { store, base } = await fixture(t, { policy: loadReviewPolicy(2) });
  await enterChrome(store);
  await store.finalizeEvent({ ...event('eligible'), semanticReview: chromeReceipt() });
  const changed = chromeReceipt({ invocationId: 'another-invocation' });
  for (const input of [
    { ...event('human-accepted'), semanticReview: null },
    { ...event('human-accepted'), semanticReview: changed },
    { ...event('human-accepted'), candidateBundleDigest: 'f'.repeat(64) },
  ]) await assert.rejects(() => store.finalizeEvent(input), /semantic|schema|custody/i);
  await assert.rejects(() => new ReceiptStore({ ...base, policy: loadReviewPolicy(1) }).finalizeEvent(event('human-accepted')), /policy|custody/i);
  assert.equal((await store.verifyChain()).count, 6);
});

for (const alteration of ['drop', 'missing-file', 'change', 'extra', 'null-hash', 'wrong-policy', 'symlink']) {
  test(`V2 verification rejects ${alteration} semantic artifact even after event rehash`, async t => {
    const { store, root } = await fixture(t, { policy: loadReviewPolicy(2) });
    await enterChrome(store);
    await store.finalizeEvent({ ...event('eligible'), semanticReview: chromeReceipt() });
    // custody-broken permits null before Chrome: dropping its bound hash can be
    // caught only by same-review history, not the standalone event layout.
    const last = await store.finalizeEvent(event('custody-broken'));
    const target = path.join(last.directory, semanticFile);
    const receipt = JSON.parse(await readFile(path.join(last.directory, 'receipt.json')));
    await chmod(path.dirname(target), 0o700);
    if (alteration === 'drop') { await chmod(last.directory, 0o700); await rm(target); await rm(path.dirname(target), { recursive: true }); await chmod(last.directory, 0o555); receipt.semanticReviewsHash = null; }
    if (alteration === 'missing-file') await rm(target);
    if (alteration === 'change') { const changed = chromeReceipt({ invocationId: 'other-invocation' }); await chmod(target, 0o600); await writeFile(target, canonicalJson(changed)); await chmod(target, 0o444); receipt.semanticReviewsHash = sha256Json(changed); }
    if (alteration === 'extra') await writeFile(path.join(path.dirname(target), 'extra.json'), '{}', { mode: 0o444 });
    if (alteration === 'null-hash') receipt.semanticReviewsHash = null;
    if (alteration === 'wrong-policy') receipt.policySnapshotHash = 'f'.repeat(64);
    if (alteration === 'symlink') { await rm(target); await symlink('/etc/passwd', target); }
    if (alteration !== 'drop') await chmod(path.dirname(target), 0o555);
    for (const [name, bytes] of [['receipt.json', canonicalJson(receipt)], ['receipt.sha256', `${sha256Json(receipt)}\n`]]) {
      const file = path.join(last.directory, name); await chmod(file, 0o600); await writeFile(file, bytes); await chmod(file, 0o444);
    }
    await writeFile(path.join(root, '.custody-head'), canonicalJson({ count: 7, tailHash: sha256Json(receipt) }));
    assert.equal((await store.verifyChain()).state, 'custody-broken');
  });
}

test('V2 ignores no semantic directories in pre-Chrome or historical V1 receipts', async t => {
  for (const version of [1, 2]) {
    const { store } = await fixture(t, { policy: loadReviewPolicy(version) });
    const receipt = await store.finalizeEvent(event());
    await chmod(receipt.directory, 0o700);
    await mkdir(path.join(receipt.directory, 'semantic-reviews'), { mode: 0o555 });
    await chmod(receipt.directory, 0o555);
    assert.equal((await store.verifyChain()).state, 'custody-broken');
  }
});

test('V2 rejected semantic payload retains only fixed sanitized failure metadata', async t => {
  const { store, root } = await fixture(t, { policy: loadReviewPolicy(2) });
  await enterChrome(store);
  const semanticReview = chromeReceipt(); semanticReview.rawPrompt = 'PAYLOAD_MUST_NEVER_SURVIVE';
  await assert.rejects(() => store.finalizeEvent({ ...event('eligible'), semanticReview }), /sanitization/);
  const chain = await store.verifyChain();
  assert.equal(chain.state, 'intact'); assert.equal(chain.count, 6);
  const failure = chain.receipts.at(-1);
  assert.equal(failure.reviewId, 'sanitization-failure-v2-1'); assert.equal(failure.semanticReviewsHash, null);
  assert.equal(failure.outcome, 'sanitization-failed');
  async function inspect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else assert.doesNotMatch(await readFile(file, 'utf8'), /PAYLOAD_MUST_NEVER_SURVIVE|rawPrompt/);
    }
  }
  await inspect(root);
});

for (const predecessor of ['chrome-semantic-review', 'deterministic-review']) {
  for (const binding of ['activeBundleDigest', 'candidateBundleDigest']) {
    test(`first semantic artifact cannot change ${binding} from ${predecessor}`, async t => {
      const { store } = await fixture(t, { policy: loadReviewPolicy(2) });
      if (predecessor === 'chrome-semantic-review') await enterChrome(store);
      else for (const type of ['available', 'staged', 'deterministic-review']) await store.finalizeEvent(event(type));
      const semanticReview = predecessor === 'chrome-semantic-review' ? chromeReceipt() : chromeReceipt({
        coverageStatus: 'incomplete-input', availabilityStatus: 'not-checked', executionStatus: 'not-run', reasonCode: 'incomplete-input',
        analysis: null, analysisDigest: null, eligibilityEffect: 'candidate-withheld',
      });
      semanticReview[binding] = 'f'.repeat(64);
      const type = predecessor === 'chrome-semantic-review' ? 'eligible' : 'review-failed';
      await assert.rejects(() => store.finalizeEvent({ ...event(type), [binding]: 'f'.repeat(64), semanticReview }), /schema|custody/i);
      assert.equal((await store.verifyChain()).count, predecessor === 'chrome-semantic-review' ? 5 : 3);
    });
  }
}

test('Chrome entry cannot evade its artifact obligation with an intervening staged event', async t => {
  const { store } = await fixture(t, { policy: loadReviewPolicy(2) });
  await enterChrome(store);
  await assert.rejects(() => store.finalizeEvent(event('staged')), /schema|custody/i);
  await assert.rejects(() => store.finalizeEvent(event('review-failed')), /schema|custody/i);
  assert.equal((await store.verifyChain()).count, 5);
});

test('V2 sanitizer failure chooses an unused trusted identity across V1 and V2 history', async t => {
  const { store, base } = await fixture(t);
  const rejected = { ...event(), unexpected: 'REJECTED_PRIVATE_PAYLOAD' };
  await assert.rejects(() => store.finalizeEvent(rejected), /sanitization/);
  const old = (await store.verifyChain()).receipts[0];
  assert.equal(old.reviewId, 'sanitization-failure');
  const oldBytes = await readFile(path.join(old.directory, 'receipt.json'));
  await store.finalizeEvent({ ...event(), reviewId: 'sanitization-failure-v2-1' });
  const v2 = new ReceiptStore({ ...base, policy: loadReviewPolicy(2) });
  for (const expected of ['sanitization-failure-v2-2', 'sanitization-failure-v2-3']) {
    await assert.rejects(() => v2.finalizeEvent(rejected), /sanitization/);
    const chain = await v2.verifyChain();
    assert.equal(chain.state, 'intact');
    assert.equal(chain.receipts.at(-1).reviewId, expected);
    assert.equal(chain.receipts.at(-1).semanticReviewsHash, null);
    assert.deepEqual(chain.receipts.at(-1).verifierIdentities, [{ name: 'sanitizer', version: '2' }]);
  }
  assert.equal((await v2.verifyChain()).count, 4);
  assert.deepEqual(await readFile(path.join(old.directory, 'receipt.json')), oldBytes);
});

// Deliberately rebuild every local hash after a forged record edit. These cases
// exercise cross-event custody, rather than passing on a stale checksum alone.
async function rehashHistory(root, receipts, mutate) {
  let previousReceiptHash = null;
  for (let index = 0; index < receipts.length; index++) {
    const directory = receipts[index].directory;
    const receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json')));
    await chmod(directory, 0o700);
    await mutate(receipt, directory, index);
    const report = `# Local review receipt\n\nReview: ${receipt.reviewId}\n\nEvent: ${receipt.eventType}\n\nOutcome: ${receipt.outcome}\n\nCreated: ${receipt.createdAt}\n`;
    const write = async (name, bytes) => { const file = path.join(directory, name); await chmod(file, 0o600); await writeFile(file, bytes); await chmod(file, 0o444); };
    await write('report.md', report);
    const hashes = {};
    for (const name of ['report.md', 'attestation.json', ...(await readdir(path.join(directory, 'project'))).map(name => `project/${name}`)]) {
      hashes[name] = createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex');
    }
    receipt.projectEvidenceHash = sha256Json(hashes);
    receipt.previousReceiptHash = previousReceiptHash;
    await write('receipt.json', canonicalJson(receipt));
    previousReceiptHash = sha256Json(receipt);
    await write('receipt.sha256', `${previousReceiptHash}\n`);
    await chmod(directory, 0o555);
  }
  await writeFile(path.join(root, '.custody-head'), canonicalJson({ count: receipts.length, tailHash: previousReceiptHash }));
}

test('verification rejects a first artifact whose rehashed terminal binding differs from Chrome entry', async t => {
  const { store, root } = await fixture(t, { policy: loadReviewPolicy(2) });
  await enterChrome(store);
  await store.finalizeEvent({ ...event('eligible'), semanticReview: chromeReceipt() });
  const chain = await store.verifyChain(); assert.equal(chain.state, 'intact');
  await rehashHistory(root, chain.receipts, async (receipt, directory, index) => {
    if (index !== 5) return;
    const artifact = chromeReceipt({ candidateBundleDigest: 'f'.repeat(64) });
    const target = path.join(directory, semanticFile);
    await chmod(target, 0o600); await writeFile(target, canonicalJson(artifact)); await chmod(target, 0o444);
    receipt.candidateBundleDigest = artifact.candidateBundleDigest; receipt.semanticReviewsHash = sha256Json(artifact);
  });
  assert.equal((await store.verifyChain()).state, 'custody-broken');
});

test('verification remembers Chrome obligation through a fully rehashed staged then failed sequence', async t => {
  const { store, root } = await fixture(t, { policy: loadReviewPolicy(2) });
  await enterChrome(store);
  const semanticReview = chromeReceipt({ executionStatus: 'failed', reasonCode: 'timeout', analysis: null, analysisDigest: null, eligibilityEffect: 'candidate-withheld' });
  await store.finalizeEvent({ ...event('review-failed'), semanticReview });
  await store.finalizeEvent(event('custody-broken'));
  const chain = await store.verifyChain(); assert.equal(chain.state, 'intact');
  await rehashHistory(root, chain.receipts, async (receipt, directory, index) => {
    if (index < 5) return;
    const semantic = path.join(directory, 'semantic-reviews');
    await chmod(semantic, 0o700); await rm(path.join(directory, semanticFile)); await rm(semantic, { recursive: true });
    receipt.eventType = index === 5 ? 'staged' : 'review-failed'; receipt.outcome = receipt.eventType; receipt.semanticReviewsHash = null;
  });
  assert.equal((await store.verifyChain()).state, 'custody-broken');
});
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
