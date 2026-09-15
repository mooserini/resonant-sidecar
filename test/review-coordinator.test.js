import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewCoordinator } from '../review/review-coordinator.js';
import { VersionStore } from '../bootstrap/version-store.js';
import { runtimeFixture, decisionFor, consumer } from './fixtures/runtime.js';
import { sha256Bytes, canonicalJson } from '../review/canonical-json.js';
import { readFileSync } from 'node:fs';
import { chmod, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ReceiptStore } from '../review/receipt-store.js';
import { DecisionNonces } from '../review/decision-nonce.js';
import { sha256Json } from '../review/canonical-json.js';
import { collectMacOSEvidence } from '../review/macos-evidence.js';
import { policy as osPolicy, runner } from './fixtures/macos/fixture.js';
import { runBootstrap } from '../bootstrap/host.js';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const policy = JSON.parse(readFileSync(new URL('../policy/review-policy.v1.json', import.meta.url)));
const favorable = { schemaVersion: 1, verdict: 'favorable', summary: 'No policy concerns', behavioralDifferences: [], dependencyChanges: [], unexplainedFiles: [], policyConcerns: [] };
async function completionLedger(f, first, staged, binding) {
  const receipts = new ReceiptStore({ root: path.join(f.projectRoot, 'review-receipts'), immutable: async () => {} });
  const event = (eventType, osEvidence = { before: {}, verification: {}, after: {} }) => ({ reviewId: binding.reviewId, eventType, outcome: eventType, verifierIdentities: [{ name: 'review-coordinator', version: '1' }], activeBundleDigest: first.manifest.bundleDigest, candidateBundleDigest: staged.manifest.bundleDigest, humanDecisionRef: binding.nonceDigest, projectEvidence: { activeVersion: {}, candidateVersion: {}, sourceHashes: {}, dependencyLock: {}, testResults: {} }, osEvidence });
  for (const state of ['available', 'staged', 'deterministic-review', 'codex-review', 'eligible', 'human-accepted', 'activating']) await receipts.finalizeEvent(event(state));
  return { receipts, finalize: osEvidence => receipts.finalizeEvent(event('activated', osEvidence)) };
}
async function coordinatorFixture(t, options = {}) {
  const f = await runtimeFixture(t); const first = await f.stage('first');
  const baseline = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await baseline.installVersion(first); await baseline.activate(decisionFor(first)); await baseline.completeActivation(decisionFor(first));
  const staged = await f.stage('review-1', '// B candidate');
  const receiptStore = new ReceiptStore({ root: path.join(f.projectRoot, 'review-receipts'), immutable: async () => {} });
  const nonceStore = new DecisionNonces({ root: f.root });
  const effects = []; let coordinator; let runtimeState = { digest: first.manifest.bundleDigest, reviewId: 'first', pid: 103, threadId: 'thread-1' };
  const versionStore = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: d => coordinator.consumeDecision(d), verifyConsumedDecision: b => coordinator.verifyConsumedDecision(b) });
  versionStore.bindRuntimeGuard(expected => runtimeState !== null && expected.digest === runtimeState.digest && expected.reviewId === runtimeState.reviewId && (!expected.pid || expected.pid === runtimeState.pid) && (!expected.threadId || expected.threadId === runtimeState.threadId));
  const deps = {
    receiptStore, nonceStore, versionStore, policy, reviewId: () => 'review-1',
    candidateSource: { inspect: async () => ({ state: 'available', manifest: staged.manifest }), stage: async () => staged },
    deterministicReview: async () => ({ passed: true, checks: [{ name: 'trusted-tests', passed: true }], activeBundleDigest: first.manifest.bundleDigest, candidateBundleDigest: staged.manifest.bundleDigest, policySnapshotHash: sha256Json(policy) }),
    codexReview: async input => {
      effects.push('codex');
      const identity = { pid: 105, executablePath: '/usr/bin/true', executableSha256: sha256Bytes(readFileSync('/usr/bin/true')) };
      const binding = await input.sampleVerifier(identity);
      const result = { passed: true, reasonCode: 'codex-favorable', attestation: favorable, outputDigest: sha256Json(favorable), verifierIdentities: [{ name: 'codex-executable', sha256: 'c'.repeat(64) }, { name: 'codex-version', sha256: 'd'.repeat(64) }, { name: 'codex-process-evidence', sha256: sha256Json(binding) }], activeBundleDigest: first.manifest.bundleDigest, candidateBundleDigest: staged.manifest.bundleDigest, policySnapshotHash: sha256Json(policy) };
      await input.finalizeResult(result); return result;
    },
    collectEvidence: input => collectMacOSEvidence({ ...input, runner: runner().run }),
    ownershipPolicy: (phase, runtime) => {
      const value = osPolicy(phase);
      if (phase === 'verification' && runtime?.verifier) {
        const verifier = value.processes.find(process => process.name === 'verifier');
        verifier.pid = runtime.verifier.pid;
        verifier.executablePath = runtime.verifier.executablePath;
      }
      return value;
    },
    runtime: {
      withTransition: operation => operation(deps.runtime),
      snapshot: () => ({ ...runtimeState }),
      refreshPending: async d => { effects.push('refresh'); const active = await versionStore.resolvePendingHost(d); runtimeState = { digest: active.digest, reviewId: active.reviewId, pid: 103, threadId: 'thread-1' }; return { ...runtimeState }; },
      refreshRecovered: async b => { effects.push('resume'); const active = await deps.versionStore.resolveRecoveredHost(b); runtimeState = { digest: active.digest, reviewId: active.reviewId, pid: 103, threadId: b.threadId }; return { ...runtimeState }; },
      stopCandidate: async () => { effects.push('stop'); runtimeState = null; },
      restartPrevious: async () => { effects.push('restore'); const active = await deps.versionStore.resolveActiveHost(); runtimeState = { digest: active.digest, reviewId: active.reviewId, pid: 103, threadId: 'thread-1' }; return { ...runtimeState }; },
    }, ...options,
  };
  coordinator = new ReviewCoordinator(deps);
  return { ...f, first, staged, receiptStore, nonceStore, versionStore, coordinator, deps, effects,
    current: () => coordinator,
    restart: (nonces = new DecisionNonces({ root: f.root })) => { coordinator = new ReviewCoordinator({ ...deps, nonceStore: nonces }); return coordinator; },
    events: async () => (await receiptStore.verifyChain()).receipts.map(r => r.eventType),
  };
}

test('coordinator grants eligibility only with one live verifier sample bound to evidence and result', async t => {
  const f = await coordinatorFixture(t);
  const eligible = await f.coordinator.startReview();
  assert.equal(eligible.state, 'eligible');
  const chain = await f.receiptStore.verifyChain();
  const codexReceipt = chain.receipts.find(receipt => receipt.eventType === 'codex-review');
  const osEvidence = JSON.parse(await readFile(path.join(codexReceipt.directory, 'os/verification/evidence.json')));
  assert.equal(osEvidence.processes.find(process => process.name === 'verifier').pid, 105);
});

for (const mode of ['missing', 'duplicate', 'mismatch']) test(`coordinator refuses eligibility for ${mode} verifier evidence`, async t => {
  const f = await coordinatorFixture(t);
  f.deps.codexReview = async input => {
    const identity = { pid: 105, executablePath: '/usr/bin/true', executableSha256: sha256Bytes(readFileSync('/usr/bin/true')) };
    let binding;
    if (mode !== 'missing') binding = await input.sampleVerifier(identity);
    if (mode === 'duplicate') await input.sampleVerifier(identity);
    const result = { passed: true, reasonCode: 'codex-favorable', attestation: favorable, outputDigest: sha256Json(favorable), verifierIdentities: [{ name: 'codex-process-evidence', sha256: sha256Json(mode === 'mismatch' ? { ...binding, pid: 999 } : binding) }], activeBundleDigest: f.first.manifest.bundleDigest, candidateBundleDigest: f.staged.manifest.bundleDigest, policySnapshotHash: sha256Json(policy) };
    await input.finalizeResult(result); return result;
  };
  const coordinator = new ReviewCoordinator(f.deps);
  assert.notEqual((await coordinator.startReview()).state, 'eligible');
});

test('review retains A until bound acceptance and records all eight immutable transitions', async t => {
  const f = await coordinatorFixture(t); const eligible = await f.coordinator.startReview();
  assert.equal(eligible.state, 'eligible'); assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
  assert.deepEqual(await f.events(), ['available', 'staged', 'deterministic-review', 'codex-review', 'eligible']);
  await f.coordinator.acceptReview(eligible.decision);
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.staged.manifest.bundleDigest);
  assert.deepEqual(await f.events(), ['available', 'staged', 'deterministic-review', 'codex-review', 'eligible', 'human-accepted', 'activating', 'activated']);
  assert.deepEqual(f.effects, ['codex', 'refresh']);
  await assert.rejects(() => f.coordinator.acceptReview(eligible.decision), /consumed|state/);
  assert.equal((await f.receiptStore.verifyChain()).state, 'intact');
});

test('deterministic failure blocks Codex and acceptance', async t => {
  const f = await coordinatorFixture(t, { deterministicReview: async () => ({ passed: false, checks: [{ name: 'trusted-tests', passed: false }] }) });
  assert.equal((await f.coordinator.startReview()).state, 'review-failed');
  assert.deepEqual(f.effects, []); assert.deepEqual(await f.events(), ['available', 'staged', 'deterministic-review', 'review-failed']);
});
test('favorable Codex callback followed by cleanup failure never exposes eligibility', async t => {
  const f = await coordinatorFixture(t); const original = f.deps.codexReview;
  f.deps.codexReview = async input => { await original(input); return { passed: false, reasonCode: 'cleanup-failed', attestation: null }; };
  const c = new ReviewCoordinator(f.deps);
  assert.equal((await c.startReview()).state, 'review-failed');
  assert.deepEqual(await f.events(), ['available', 'staged', 'deterministic-review', 'codex-review', 'review-failed']);
  const chain = await f.receiptStore.verifyChain();
  const tests = JSON.parse(await readFile(path.join(chain.receipts.at(-1).directory, 'project/test-results.json')));
  assert.ok(tests.checks.some(c => c.reasonCode === 'cleanup-failed'));
});
test('listener evidence with a forged passed flag rolls back and preserves failure receipts', async t => {
  const f = await coordinatorFixture(t); let after = 0;
  f.deps.collectEvidence = async input => {
    const evidence = await collectMacOSEvidence({ ...input, runner: runner().run });
    if (input.phase === 'after' && after++ === 0) evidence.processes.find(p => p.name === 'active-host').listeners.push({ fd: 17, protocol: 'TCP', address: '127.0.0.1', port: 9000, transport: 'tcp' });
    return evidence;
  };
  // The real store consumer must resolve this coordinator too.
  const c = f.restart(); const eligible = await c.startReview();
  assert.equal((await c.acceptReview(eligible.decision)).state, 'rolled-back');
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
  assert.deepEqual((await f.events()).slice(-3), ['activation-failed', 'rolling-back', 'rolled-back']);
  assert.deepEqual(f.effects, ['codex', 'refresh', 'stop', 'restore']);
});
test('restarting an eligible review invalidates decisions and receipts rejection', async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview(); const c = f.restart();
  assert.equal((await c.resumePendingActivation()).state, 'rejected');
  await assert.rejects(() => c.acceptReview(e.decision), /state|restart|consumed/);
  assert.equal((await f.events()).at(-1), 'rejected');
});
test('human response is snapshotted before awaits and cannot change bindings', async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview();
  for (const key of ['candidateDigest', 'policyDigest', 'reviewId', 'action']) await assert.rejects(() => f.coordinator.acceptReview({ ...e.decision, [key]: key.endsWith('Digest') ? 'c'.repeat(64) : 'changed' }), /binding|decision/);
  const d = { ...e.decision }; const work = f.coordinator.acceptReview(d); d.candidateDigest = 'c'.repeat(64);
  assert.equal((await work).state, 'activated');
});
test('broken canonical history halts refresh and leaves the active pin available', async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview(); const chain = await f.receiptStore.verifyChain();
  const file = path.join(chain.receipts[0].directory, 'receipt.json'); await chmod(file, 0o600); await writeFile(file, '{}');
  await assert.rejects(() => f.coordinator.acceptReview(e.decision), /[Cc]ustody/);
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
  assert.deepEqual(f.effects, ['codex']);
});
test('browser lifecycle data cannot supply consent, configuration, refresh or completion', async t => {
  const f = await coordinatorFixture(t);
  for (const message of [{ type: 'review.accept', nonce: 'x'.repeat(43) }, { type: 'review.start', path: '/tmp' }, { type: 'activation.completed' }, { type: 'review.status', policy: {} }]) await assert.rejects(() => f.coordinator.handle(message), /lifecycle/);
  assert.deepEqual(f.effects, []);
});

test('only verified consumed pending transactions resume after store restart without raw nonce', async t => {
  const f = await runtimeFixture(t); const first = await f.stage('first'); const next = await f.stage('next', '// B');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(first); await store.activate(decisionFor(first)); await store.completeActivation(decisionFor(first));
  await store.installVersion(next); const d = decisionFor(next, 'm'.repeat(32)); await store.activate(d);
  const b = { reviewId: 'next', candidateDigest: d.candidateDigest, policyDigest: d.policyDigest, nonceDigest: sha256Bytes(d.nonce), threadId: 'thread-1', expiresAt: Date.now() + 60000 };
  const restarted = new VersionStore({ projectRoot: f.projectRoot, verifyConsumedDecision: async value => {
    assert.deepEqual(value, b); return { ...value, consumed: true };
  } });
  await assert.rejects(() => restarted.resolveActiveHost(), /recovery/);
  await restarted.resumePendingActivation(b);
  assert.equal((await restarted.resolveRecoveredHost(b)).digest, next.manifest.bundleDigest);
  await assert.rejects(() => restarted.completeRecoveredActivation(b), /guard|authorization/);
  await restarted.recover();
  assert.equal((await restarted.resolveActiveHost()).digest, first.manifest.bundleDigest);
});

test('coordinator refuses missing trusted dependencies before any action', () => {
  assert.throws(() => new ReviewCoordinator({}), /dependencies/);
});

test('bootstrap explicitly resumes B with the journal thread and gates completion on readiness', async t => {
  const f = await runtimeFixture(t); const a = await f.stage('first'); const b = await f.stage('next', '// next');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(a); await store.activate(decisionFor(a)); await store.completeActivation(decisionFor(a));
  await store.installVersion(b); const d = { ...decisionFor(b, 'r'.repeat(32)), policyDigest: sha256Json(policy) }; await store.activate(d);
  const binding = { reviewId: 'next', candidateDigest: d.candidateDigest, policyDigest: d.policyDigest, nonceDigest: sha256Bytes(d.nonce), threadId: 'thread-kept', expiresAt: Date.now() + 60000 };
  const restarted = new VersionStore({ projectRoot: f.projectRoot, verifyConsumedDecision: value => ({ ...value, consumed: true }) });
  const ledger = await completionLedger(f, a, b, binding); restarted.bindReceiptStore(ledger.receipts);
  const after = await collectMacOSEvidence({ ...osPolicy('after'), runner: runner().run });
  const authorization = { runtime: { pid: 103, digest: b.manifest.bundleDigest, reviewId: 'next', threadId: 'thread-kept' }, ownershipPolicy: osPolicy('after'), osEvidence: { before: {}, verification: {}, after } };
  const input = new PassThrough(); const output = new PassThrough(); const signals = new EventEmitter(); const sent = [];
  let reaped = false;
  const bootstrap = await runBootstrap({ store: restarted, input, output, signals, resumeActivation: binding,
    proxyFactory: ({ active, onMessage }) => {
      assert.equal(active.digest, b.manifest.bundleDigest);
      return { pid: 103, send: message => { sent.push(message); queueMicrotask(() => onMessage({ type: 'session.ready', threadId: 'thread-kept' })); }, close: async () => { reaped = true; } };
    },
  });
  t.after(() => bootstrap.close());
  await assert.rejects(() => restarted.completeRecoveredActivation(binding, authorization, () => ledger.finalize(authorization.osEvidence)), /refresh/);
  const live = await bootstrap.refreshRecovered(binding);
  assert.equal(live.threadId, 'thread-kept'); assert.equal(live.digest, b.manifest.bundleDigest);
  assert.deepEqual(sent, [{ type: 'session.open', threadId: 'thread-kept' }]);
  const forged = structuredClone(authorization); forged.osEvidence.after.processes.find(p => p.name === 'active-host').listeners.push({ fd: 17, protocol: 'TCP', address: '127.0.0.1', port: 9000, transport: 'tcp' });
  await assert.rejects(() => restarted.completeRecoveredActivation(binding, forged, () => { throw new Error('must not finalize'); }), /authorization/);
  await assert.rejects(() => restarted.completeRecoveredActivation(binding, authorization, () => ({ phase: 'complete' })), /receipt/);
  await assert.rejects(() => restarted.completeRecoveredActivation(binding, authorization, async () => { await ledger.finalize(authorization.osEvidence); throw new Error('receipt committed before crash'); }), /before crash/);
  await restarted.completeRecoveredActivation(binding, authorization, () => { throw new Error('must not append a second activated receipt'); });
  assert.equal((await ledger.receipts.verifyChain()).receipts.filter(r => r.eventType === 'activated').length, 1);
  await bootstrap.close(); assert.equal(reaped, true);
});

async function pendingReview(f) {
  const e = await f.coordinator.startReview(); const proof = f.nonceStore.consume(e.decision);
  for (const eventType of ['human-accepted', 'activating']) await f.receiptStore.finalizeEvent({ reviewId: 'review-1', eventType, outcome: eventType, verifierIdentities: [{ name: 'review-coordinator', version: '1' }], activeBundleDigest: f.first.manifest.bundleDigest, candidateBundleDigest: f.staged.manifest.bundleDigest, humanDecisionRef: proof.nonceDigest, projectEvidence: { activeVersion: {}, candidateVersion: {}, sourceHashes: {}, dependencyLock: {}, testResults: {} }, osEvidence: { before: {}, verification: {}, after: {} } });
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: d => { f.nonceStore.recover(sha256Bytes(d.nonce)); return { ...d, consumed: true }; } });
  await store.installVersion(f.staged); await store.activate(e.decision);
  let c;
  f.deps.versionStore = new VersionStore({ projectRoot: f.projectRoot, verifyConsumedDecision: b => f.current().verifyConsumedDecision(b) });
  f.deps.versionStore.bindRuntimeGuard(expected => { const live = f.deps.runtime.snapshot(); return live.digest === expected.digest && live.reviewId === expected.reviewId && (!expected.pid || expected.pid === live.pid) && (!expected.threadId || expected.threadId === live.threadId); });
  c = f.restart(); return { c, proof, decision: e.decision };
}
test('coordinator restart resumes only consumed journal and writes activated after fresh after evidence', async t => {
  const f = await coordinatorFixture(t); const { c, decision } = await pendingReview(f);
  assert.equal((await c.resumePendingActivation()).state, 'activated');
  assert.equal((await f.deps.versionStore.resolveActiveHost()).digest, f.staged.manifest.bundleDigest);
  assert.deepEqual((await f.events()).slice(-3), ['human-accepted', 'activating', 'activated']);
  assert.deepEqual(f.effects, ['codex', 'resume']);
  await assert.rejects(() => c.acceptReview(decision), /state/);
});
for (const damage of ['prepared', 'unconsumed', 'policy', 'candidate', 'expired']) test(`restart ${damage} cannot resume B and restores A with receipts`, async t => {
  const f = await coordinatorFixture(t); const { c, proof } = await pendingReview(f);
  const journal = path.join(f.root, 'recovery-state.json');
  if (damage === 'prepared') { const state = JSON.parse(await readFile(journal)); state.phase = 'prepared'; await writeFile(journal, canonicalJson(state) + '\n'); }
  if (damage === 'unconsumed') { const file = path.join(f.root, 'review-decisions', `${proof.nonceDigest}.used.json`); await chmod(file, 0o600); await writeFile(file, '{}\n'); await chmod(file, 0o400); }
  if (damage === 'policy') { const file = path.join(f.root, 'decisions', `${proof.nonceDigest}.json`); const state = JSON.parse(await readFile(file)); state.policyDigest = 'c'.repeat(64); await chmod(file, 0o600); await writeFile(file, canonicalJson(state) + '\n'); await chmod(file, 0o400); }
  if (damage === 'candidate') { const file = path.join(f.root, 'versions', f.staged.manifest.bundleDigest, 'bundle/native-host/host.js'); await chmod(file, 0o600); await writeFile(file, '// corrupt candidate'); await chmod(file, 0o400); }
  if (damage === 'expired') { f.deps.nonceStore = new DecisionNonces({ root: f.root, clock: () => proof.expiresAt }); }
  const recovering = damage === 'expired' ? f.restart(f.deps.nonceStore) : c;
  assert.equal((await recovering.resumePendingActivation()).state, 'rolled-back');
  assert.equal((await f.deps.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
  assert.deepEqual((await f.events()).slice(-3), ['activation-failed', 'rolling-back', 'rolled-back']);
});
test('rollback failure is a permanent terminal custody receipt and cannot refresh again', async t => {
  const f = await coordinatorFixture(t); f.deps.runtime.refreshPending = async () => { throw new Error('refresh failure'); };
  f.deps.runtime.restartPrevious = async () => { throw new Error('restored topology unavailable'); };
  const c = f.restart(); const e = await c.startReview();
  assert.equal((await c.acceptReview(e.decision)).state, 'custody-broken');
  assert.deepEqual((await f.events()).slice(-3), ['activation-failed', 'rolling-back', 'custody-broken']);
  await assert.rejects(() => c.checkAvailability(), /[Cc]ustody/);
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
});
test('before custody failure writes custody-broken and never invokes Codex', async t => {
  const f = await coordinatorFixture(t); f.deps.collectEvidence = async input => {
    const e = await collectMacOSEvidence({ ...input, runner: runner().run }); e.processes.find(p => p.name === 'bootstrap').ppid = 999; return e;
  };
  assert.equal((await f.restart().startReview()).state, 'custody-broken');
  assert.deepEqual(f.effects, []); assert.equal((await f.events()).at(-1), 'custody-broken');
});

test('same-bootstrap rollback reaps B then restarts A on the bound thread', async t => {
  const f = await runtimeFixture(t); const a = await f.stage('first'); const b = await f.stage('next', '// next');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(a); await store.activate(decisionFor(a)); await store.completeActivation(decisionFor(a));
  await store.installVersion(b); const d = decisionFor(b, 's'.repeat(32)); await store.activate(d);
  const binding = { reviewId: 'next', candidateDigest: d.candidateDigest, policyDigest: d.policyDigest, nonceDigest: sha256Bytes(d.nonce), threadId: 'thread-kept', expiresAt: Date.now() + 60000 };
  const restarted = new VersionStore({ projectRoot: f.projectRoot, verifyConsumedDecision: v => ({ ...v, consumed: true }) });
  let running = null; const ordering = [];
  const bootstrap = await runBootstrap({ store: restarted, input: new PassThrough(), output: new PassThrough(), signals: new EventEmitter(), resumeActivation: binding,
    proxyFactory: ({ active, onMessage }) => {
      assert.equal(running, null); running = active.digest; ordering.push(active.reviewId);
      return { pid: 222, send: () => queueMicrotask(() => onMessage({ type: 'session.ready', threadId: 'thread-kept' })), close: async () => { ordering.push('reaped'); running = null; } };
    },
  });
  t.after(() => bootstrap.close());
  await bootstrap.refreshRecovered(binding); await bootstrap.stopCandidate();
  assert.equal(running, null); await restarted.recover();
  const restored = await bootstrap.restartPrevious();
  assert.equal(restored.digest, a.manifest.bundleDigest); assert.equal(restored.threadId, 'thread-kept');
  assert.deepEqual(ordering, ['next', 'reaped', 'first']);
  await bootstrap.close();
});
test('expiry rejects the decision permanently without changing the active pin', async t => {
  const f = await coordinatorFixture(t); let now = Date.now();
  const nonces = new DecisionNonces({ root: f.root, clock: () => now, ttlMs: 10 });
  const c = f.restart(nonces); const e = await c.startReview(); now += 10;
  await assert.rejects(() => c.acceptReview(e.decision), /expired/);
  assert.equal((await f.events()).at(-1), 'rejected');
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
});
test('availability is read-only for runtime and repeat checks do not fork the receipt history', async t => {
  const f = await coordinatorFixture(t);
  assert.equal((await f.coordinator.checkAvailability()).state, 'available');
  assert.equal((await f.coordinator.checkAvailability()).state, 'available');
  assert.deepEqual(await f.events(), ['available']); assert.deepEqual(f.effects, []);
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
});
test('explicit rejection consumes the separate bound action and never activates', async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview();
  await assert.rejects(() => f.coordinator.rejectReview(e.decision), /binding/);
  assert.equal((await f.coordinator.rejectReview(e.rejection)).state, 'rejected');
  await assert.rejects(() => f.coordinator.acceptReview(e.decision), /state/);
  assert.deepEqual(f.effects, ['codex']); assert.equal((await f.events()).length, 6);
});
for (const field of ['pid', 'threadId', 'digest', 'reviewId']) test(`post-refresh ${field} substitution cannot complete activation`, async t => {
  const f = await coordinatorFixture(t); const refresh = f.deps.runtime.refreshPending;
  f.deps.runtime.refreshPending = async d => ({ ...await refresh(d), [field]: field === 'pid' ? 999 : 'changed' });
  const c = f.restart(); const e = await c.startReview();
  assert.equal((await c.acceptReview(e.decision)).state, 'rolled-back');
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
});
for (const kind of ['malformed', 'unfavorable', 'unbound', 'no-finalizer']) test(`Codex ${kind} result fails closed with permanent review-failed`, async t => {
  const f = await coordinatorFixture(t); const original = f.deps.codexReview;
  f.deps.codexReview = async input => {
    if (kind === 'malformed') return 'approved';
    if (kind === 'no-finalizer') return { passed: true, reasonCode: 'codex-favorable', attestation: favorable };
    const r = await original(input);
    return kind === 'unbound' ? { ...r, candidateBundleDigest: 'c'.repeat(64) } : { ...r, passed: false, reasonCode: 'codex-unfavorable', attestation: { ...favorable, verdict: 'unfavorable' } };
  };
  const c = f.restart(); assert.equal((await c.startReview()).state, 'review-failed');
  assert.equal((await f.events()).at(-1), 'review-failed');
});
test('trusted policy change invalidates eligibility while preserving active service', async t => {
  const f = await coordinatorFixture(t); let current = policy; f.deps.currentPolicy = () => current;
  const c = f.restart(); const e = await c.startReview(); current = { ...policy, schemaVersion: 2 };
  await assert.rejects(() => c.acceptReview(e.decision), /[Cc]ustody/);
  assert.equal((await f.events()).at(-1), 'custody-broken');
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
});
test('concurrent acceptance has exactly one nonce consumption and one activation', async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview();
  const results = await Promise.allSettled([f.coordinator.acceptReview(e.decision), f.coordinator.acceptReview(e.decision)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.events()).filter(s => s === 'human-accepted').length, 1);
  assert.equal((await f.events()).filter(s => s === 'activated').length, 1);
});

test('rehydration rechecks persisted custody after the asynchronous consumed-proof boundary', async t => {
  const f = await runtimeFixture(t); const a = await f.stage('first'); const b = await f.stage('next', '// next');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(a); await store.activate(decisionFor(a)); await store.completeActivation(decisionFor(a));
  await store.installVersion(b); const d = decisionFor(b, 'q'.repeat(32)); await store.activate(d);
  const binding = { reviewId: 'next', candidateDigest: d.candidateDigest, policyDigest: d.policyDigest, nonceDigest: sha256Bytes(d.nonce), threadId: 'thread-kept', expiresAt: Date.now() + 60000 };
  const restarted = new VersionStore({ projectRoot: f.projectRoot, verifyConsumedDecision: async value => {
    const file = path.join(f.root, 'active/pin.json'); const pin = JSON.parse(await readFile(file)); pin.reviewId = 'changed'; await writeFile(file, canonicalJson(pin) + '\n');
    return { ...value, consumed: true };
  } });
  await assert.rejects(() => restarted.resumePendingActivation(binding), /custody|binding/i);
});
test('candidate changed after eligibility creates a custody receipt before nonce consumption or activation', async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview();
  f.deps.candidateSource.inspect = async () => ({ state: 'available', digest: 'c'.repeat(64) });
  assert.equal((await f.coordinator.acceptReview(e.decision)).state, 'custody-broken');
  assert.deepEqual(f.effects, ['codex']);
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
});
test('failure to reap candidate never starts previous and retains rollback-failed custody', async t => {
  const f = await coordinatorFixture(t); f.deps.runtime.refreshPending = async () => { throw new Error('refresh'); };
  f.deps.runtime.stopCandidate = async () => { throw new Error('not reaped'); };
  const c = f.restart(); const e = await c.startReview();
  assert.equal((await c.acceptReview(e.decision)).state, 'custody-broken');
  assert.equal(f.effects.includes('restore'), false);
  assert.deepEqual((await f.events()).slice(-3), ['activation-failed', 'rolling-back', 'custody-broken']);
});

const reviewPath = ['available', 'staged', 'deterministic-review', 'codex-review', 'eligible', 'human-accepted', 'activating', 'activation-failed', 'rolling-back', 'rolled-back'];
for (const [state, expected] of [['available', 'custody-broken'], ['staged', 'review-failed'], ['deterministic-review', 'review-failed'], ['codex-review', 'review-failed'], ['eligible', 'rejected'], ['human-accepted', 'rolled-back'], ['activating', 'rolled-back'], ['activation-failed', 'rolled-back'], ['rolling-back', 'rolled-back'], ['rolled-back', 'rolled-back']]) test(`restart at ${state} cannot invent human authority (${expected})`, async t => {
  const f = await coordinatorFixture(t);
  for (const eventType of reviewPath.slice(0, reviewPath.indexOf(state) + 1)) await f.receiptStore.finalizeEvent({ reviewId: 'review-1', eventType, outcome: eventType, verifierIdentities: [{ name: 'review-coordinator', version: '1' }], activeBundleDigest: f.first.manifest.bundleDigest, candidateBundleDigest: f.staged.manifest.bundleDigest, projectEvidence: { activeVersion: {}, candidateVersion: {}, sourceHashes: {}, dependencyLock: {}, testResults: {} }, osEvidence: { before: {}, verification: {}, after: {} } });
  const c = f.restart(); assert.equal((await c.resumePendingActivation()).state, expected);
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
  assert.equal(f.effects.includes('refresh') || f.effects.includes('resume'), false);
});
test('chain corruption during install is detected before candidate activation or refresh', async t => {
  const f = await coordinatorFixture(t); const install = f.versionStore.installVersion.bind(f.versionStore);
  f.versionStore.installVersion = async staged => {
    await install(staged); const chain = await f.receiptStore.verifyChain(); const file = path.join(chain.receipts[0].directory, 'receipt.json');
    await chmod(file, 0o600); await writeFile(file, '{}');
  };
  const e = await f.coordinator.startReview(); await assert.rejects(() => f.coordinator.acceptReview(e.decision), /[Cc]ustody/);
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
  assert.deepEqual(f.effects, ['codex']);
});
test('chain corruption during pin swap blocks the next runtime mutation', async t => {
  const f = await coordinatorFixture(t); const activate = f.versionStore.activate.bind(f.versionStore);
  f.versionStore.activate = async decision => {
    await activate(decision); const chain = await f.receiptStore.verifyChain(); const file = path.join(chain.receipts[0].directory, 'receipt.json');
    await chmod(file, 0o600); await writeFile(file, '{}');
  };
  const e = await f.coordinator.startReview(); await assert.rejects(() => f.coordinator.acceptReview(e.decision), /[Cc]ustody/);
  assert.deepEqual(f.effects, ['codex']);
});
test('Codex executable and version evidence survives finalization and cleanup', async t => {
  const f = await coordinatorFixture(t); await f.coordinator.startReview();
  const chain = await f.receiptStore.verifyChain(); const receipt = chain.receipts.find(r => r.eventType === 'codex-review');
  const evidence = JSON.parse(await readFile(path.join(receipt.directory, 'project/test-results.json')));
  assert.ok(evidence.verifierIdentities?.some(i => i.name === 'codex-executable' && i.sha256 === 'c'.repeat(64)));
  assert.ok(evidence.verifierIdentities?.some(i => i.name === 'codex-version' && i.sha256 === 'd'.repeat(64)));
  assert.ok(evidence.checks.some(c => c.name === 'codex-result' && c.outputDigest === sha256Json(favorable)));
});
test('custody is rechecked after candidate inspection before consuming human response', async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview();
  f.deps.candidateSource.inspect = async () => {
    const chain = await f.receiptStore.verifyChain(); const file = path.join(chain.receipts[0].directory, 'receipt.json');
    await chmod(file, 0o600); await writeFile(file, '{}'); return { state: 'available', digest: f.staged.manifest.bundleDigest };
  };
  await assert.rejects(() => f.coordinator.acceptReview(e.decision), /[Cc]ustody/);
  const { readdir } = await import('node:fs/promises');
  assert.equal((await readdir(path.join(f.root, 'review-decisions'))).some(n => n.endsWith('.used.json')), false);
});

for (const boundary of ['before-activated-receipt', 'after-activated-receipt', 'after-journal-complete']) test(`completion crash ${boundary} reconciles to one truthful terminal outcome`, async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview();
  const finalize = f.receiptStore.finalizeEvent.bind(f.receiptStore);
  if (boundary !== 'after-journal-complete') f.receiptStore.finalizeEvent = async input => {
    if (input.eventType === 'activated') {
      if (boundary === 'after-activated-receipt') await finalize(input);
      throw new Error('simulated crash');
    }
    return finalize(input);
  };
  else {
    const complete = f.versionStore.completeReviewedActivation?.bind(f.versionStore);
    f.versionStore.completeReviewedActivation = async (...args) => { await complete(...args); throw new Error('simulated crash'); };
  }
  await assert.rejects(() => f.coordinator.acceptReview(e.decision));
  f.receiptStore.finalizeEvent = finalize;
  f.deps.versionStore = new VersionStore({ projectRoot: f.projectRoot, verifyConsumedDecision: b => f.current().verifyConsumedDecision(b) });
  f.deps.versionStore.bindRuntimeGuard(expected => { const live = f.deps.runtime.snapshot(); return live.digest === expected.digest && live.reviewId === expected.reviewId; });
  const c = f.restart();
  const result = await c.resumePendingActivation();
  const committed = boundary !== 'before-activated-receipt';
  assert.equal(result.state, committed ? 'activated' : 'rolled-back');
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'recovery-state.json'))).phase, committed ? 'complete' : 'rolled-back');
  assert.equal((await f.deps.versionStore.resolveActiveHost()).digest, committed ? f.staged.manifest.bundleDigest : f.first.manifest.bundleDigest);
  assert.equal((await f.events()).filter(v => v === 'activated').length, committed ? 1 : 0);
  assert.equal((await c.resumePendingActivation()).state, committed ? 'activated' : 'rolled-back');
});
test('a completion adapter claiming complete cannot invent evidence or activated custody', async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview();
  f.versionStore.completeReviewedActivation = async () => ({ phase: 'complete' });
  assert.equal((await f.coordinator.acceptReview(e.decision)).state, 'rolled-back');
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
  assert.equal((await f.events()).includes('activated'), false);
});
test('rollback restores A before the runtime adapter may resolve or restart it', async t => {
  const f = await coordinatorFixture(t); const e = await f.coordinator.startReview();
  // Reproduce the former completed-journal B with no activated receipt.
  const refresh = f.deps.runtime.refreshPending;
  f.deps.runtime.refreshPending = async decision => {
    await refresh(decision);
    const file = path.join(f.root, 'recovery-state.json'); const state = JSON.parse(await readFile(file)); state.phase = 'complete'; await writeFile(file, canonicalJson(state) + '\n');
    throw new Error('post-swap failure');
  };
  const restart = f.deps.runtime.restartPrevious;
  f.deps.runtime.restartPrevious = async () => {
    assert.equal(JSON.parse(await readFile(path.join(f.root, 'active/pin.json'))).digest, f.first.manifest.bundleDigest);
    return restart();
  };
  assert.equal((await f.coordinator.acceptReview(e.decision)).state, 'rolled-back');
  assert.equal((await f.versionStore.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
});
test('restart after after-evidence but before completion witness safely resumes verification', { timeout: 10000 }, async t => {
  const f = await coordinatorFixture(t); const { c } = await pendingReview(f);
  let reached; let failed;
  const boundary = new Promise((resolve, reject) => { reached = resolve; failed = reject; });
  f.deps.versionStore.completeRecoveredActivation = () => { reached(); return new Promise(() => {}); };
  // Suspend the old coordinator at the durable boundary, modeling its loss.
  // There are no subprocesses, timers, or resources owned by this pending call.
  void c.resumePendingActivation().catch(failed);
  await boundary;
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(path.join(f.root, 'completions')), []);
  assert.equal((await f.events()).at(-1), 'activating');
  f.deps.versionStore = new VersionStore({ projectRoot: f.projectRoot, verifyConsumedDecision: b => f.current().verifyConsumedDecision(b) });
  f.deps.versionStore.bindRuntimeGuard(expected => { const live = f.deps.runtime.snapshot(); return live.digest === expected.digest && live.reviewId === expected.reviewId; });
  const restarted = f.restart(); assert.equal((await restarted.resumePendingActivation()).state, 'activated');
  assert.equal((await f.events()).filter(v => v === 'activated').length, 1);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'recovery-state.json'))).phase, 'complete');
});
