import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runtimeFixture, decisionFor, consumer } from './fixtures/runtime.js';
import { VersionStore } from '../bootstrap/version-store.js';
import { ReceiptStore } from '../review/receipt-store.js';
import { DecisionNonces } from '../review/decision-nonce.js';
import { ReviewCoordinator } from '../review/review-coordinator.js';
import { runBootstrap } from '../bootstrap/host.js';
import { encodeNativeMessage } from '../native-host/native-framing.js';
import { sha256Json } from '../review/canonical-json.js';
import { collectMacOSEvidence } from '../review/macos-evidence.js';
import { policy as osPolicy, runner } from './fixtures/macos/fixture.js';

const policy = JSON.parse(readFileSync(new URL('../policy/review-policy.v1.json', import.meta.url)));
const favorable = { schemaVersion: 1, verdict: 'favorable', summary: 'No policy concerns', behavioralDifferences: [], dependencyChanges: [], unexplainedFiles: [], policyConcerns: [] };
async function liveFixture(t) {
  const f = await runtimeFixture(t); const first = await f.stage('first'); const next = await f.stage('next', '// next');
  const seed = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await seed.installVersion(first); await seed.activate(decisionFor(first)); await seed.completeActivation(decisionFor(first));
  const receipts = new ReceiptStore({ root: path.join(f.projectRoot, 'review-receipts'), immutable: async () => {} });
  let coordinator; let bootstrap; let failAfter = false;
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: d => coordinator.consumeDecision(d), verifyConsumedDecision: b => coordinator.verifyConsumedDecision(b) });
  const runtime = {
    snapshot: () => bootstrap.runtimeState,
    refreshPending: d => bootstrap.refreshPending(d), refreshRecovered: b => bootstrap.refreshRecovered(b),
    stopCandidate: () => bootstrap.stopCandidate(), restartPrevious: () => bootstrap.restartPrevious(),
    withTransition: operation => bootstrap.withTransition(operation),
  };
  const deps = { receiptStore: receipts, nonceStore: new DecisionNonces({ root: f.root }), versionStore: store, policy, reviewId: () => 'next', runtime,
    candidateSource: { inspect: async () => ({ state: 'available', digest: next.manifest.bundleDigest }), stage: async () => next },
    deterministicReview: async () => ({ passed: true, checks: [{ name: 'trusted-tests', passed: true }], activeBundleDigest: first.manifest.bundleDigest, candidateBundleDigest: next.manifest.bundleDigest, policySnapshotHash: sha256Json(policy) }),
    codexReview: async input => { const r = { passed: true, reasonCode: 'codex-favorable', attestation: favorable, activeBundleDigest: first.manifest.bundleDigest, candidateBundleDigest: next.manifest.bundleDigest, policySnapshotHash: sha256Json(policy) }; await input.finalizeResult(r); return r; },
    ownershipPolicy: phase => osPolicy(phase),
    collectEvidence: async input => { const e = await collectMacOSEvidence({ ...input, runner: runner().run }); if (input.phase === 'after' && failAfter) { failAfter = false; e.processes.find(p => p.name === 'active-host').listeners.push({ fd: 17, protocol: 'TCP', address: '127.0.0.1', port: 9000, transport: 'tcp' }); } return e; },
  };
  coordinator = new ReviewCoordinator(deps);
  const input = new PassThrough(); const starts = []; const turns = []; const reaped = [];
  bootstrap = await runBootstrap({ store, coordinator, input, output: new PassThrough(), signals: new EventEmitter(), proxyFactory: ({ active, onMessage }) => {
    starts.push(active.reviewId);
    return { pid: 103, send: m => { if (m.type === 'session.open') queueMicrotask(() => onMessage({ type: 'session.ready', threadId: 'thread-kept' })); else turns.push({ reviewId: active.reviewId, type: m.type }); }, close: async () => { reaped.push(active.reviewId); } };
  } });
  input.write(encodeNativeMessage({ type: 'session.open', threadId: 'thread-kept' }));
  while (!bootstrap.runtimeState?.threadId) await new Promise(r => setTimeout(r, 5));
  return { ...f, first, next, receipts, store, coordinator, bootstrap, input, starts, turns, reaped, deps,
    failAfter: () => { failAfter = true; }, events: async () => (await receipts.verifyChain()).receipts?.map(r => r.eventType),
  };
}

test('disconnect inside activation finalizer cannot commit a reaped candidate', { timeout: 15000 }, async t => {
  const f = await liveFixture(t); const e = await f.coordinator.startReview();
  const finalize = f.receipts.finalizeEvent.bind(f.receipts); let closing;
  f.receipts.finalizeEvent = async (input, options) => { if (input.eventType === 'activated') closing = f.bootstrap.close(); return finalize(input, options); };
  let result; try { result = await f.coordinator.acceptReview(e.decision); } catch { /* Cancellation may reject or finish rollback. */ }
  await closing;
  assert.notEqual(result?.state, 'activated');
  assert.equal((await f.events()).includes('activated'), false);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'active/pin.json'))).digest, f.first.manifest.bundleDigest);
  assert.ok(f.reaped.includes('next'));
});

test('conversation and interrupt cannot restart B between rollback reap and pin restoration', { timeout: 15000 }, async t => {
  const f = await liveFixture(t); const e = await f.coordinator.startReview(); f.failAfter();
  const verify = f.receipts.verifyChain.bind(f.receipts); let sent = false;
  f.receipts.verifyChain = async () => {
    if (!sent && f.bootstrap.runtimeState === null && JSON.parse(await readFile(path.join(f.root, 'active/pin.json'))).digest === f.next.manifest.bundleDigest) {
      sent = true;
      f.input.write(encodeNativeMessage({ type: 'turn.start', text: 'queued during rollback' }));
      f.input.write(encodeNativeMessage({ type: 'turn.interrupt' }));
      await new Promise(r => setTimeout(r, 100));
    }
    return verify();
  };
  try {
    assert.equal((await f.coordinator.acceptReview(e.decision)).state, 'rolled-back');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(sent, true);
    assert.deepEqual(f.starts, ['first', 'next', 'first']);
    assert.deepEqual(f.turns, [{ reviewId: 'first', type: 'turn.start' }, { reviewId: 'first', type: 'turn.interrupt' }]);
  } finally { await f.bootstrap.close(); }
});

for (const boundary of ['before', 'after']) test(`disconnect ${boundary} canonical commit gate has one recoverable outcome`, { timeout: 15000 }, async t => {
  const f = await liveFixture(t); const e = await f.coordinator.startReview();
  const scope = f.receipts.withCommitGuard.bind(f.receipts); let closing; let checked = false;
  f.receipts.withCommitGuard = (guard, operation) => scope(() => {
    checked = true;
    if (boundary === 'before') { closing = f.bootstrap.close(); return guard(); }
    const live = guard();
    queueMicrotask(() => { closing = f.bootstrap.close(); });
    return live;
  }, operation);
  const finalize = f.receipts.finalizeEvent.bind(f.receipts); let reapedBeforeReceipt;
  f.receipts.finalizeEvent = async input => {
    const receipt = await finalize(input);
    if (input.eventType === 'activated') reapedBeforeReceipt = f.reaped.includes('next');
    return receipt;
  };
  const result = await f.coordinator.acceptReview(e.decision);
  await closing;
  assert.equal(checked, true);
  const committed = boundary === 'after';
  assert.equal(result.state === 'activated', committed);
  assert.equal((await f.events()).filter(v => v === 'activated').length, committed ? 1 : 0);
  assert.equal((await f.receipts.verifyChain()).state, 'intact');
  if (committed) assert.equal(reapedBeforeReceipt, false, 'lease holds B through receipt sealing');
  const restarted = new VersionStore({ projectRoot: f.projectRoot }); restarted.bindReceiptStore(f.receipts);
  await restarted.recover(); await restarted.recover();
  assert.equal((await restarted.resolveActiveHost()).digest, committed ? f.next.manifest.bundleDigest : f.first.manifest.bundleDigest);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'recovery-state.json'))).phase, committed ? 'complete' : 'rolled-back');
  assert.equal((await f.events()).filter(v => v === 'activated').length, committed ? 1 : 0);
  await assert.rejects(() => f.coordinator.acceptReview(e.decision));
});

test('disconnect after durable witness is rechecked before invoking canonical finalizer', { timeout: 15000 }, async t => {
  const f = await liveFixture(t); const e = await f.coordinator.startReview();
  const verify = f.receipts.verifyChain.bind(f.receipts); let closing; let finalized = false;
  f.receipts.verifyChain = async () => {
    const { readdir } = await import('node:fs/promises');
    if (!closing && (await readdir(path.join(f.root, 'completions'))).length) closing = f.bootstrap.close();
    return verify();
  };
  const finalize = f.receipts.finalizeEvent.bind(f.receipts);
  f.receipts.finalizeEvent = input => { if (input.eventType === 'activated') finalized = true; return finalize(input); };
  await f.coordinator.acceptReview(e.decision); await closing;
  assert.ok(closing); assert.equal(finalized, false);
  assert.equal((await f.events()).includes('activated'), false);
  assert.equal((await f.store.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
});

test('split-lane turns wait across B pin swap until B readiness and completion', { timeout: 15000 }, async t => {
  const f = await liveFixture(t); const e = await f.coordinator.startReview();
  const activate = f.store.activate.bind(f.store); let entered; let release;
  const swapped = new Promise(r => { entered = r; }); const proceed = new Promise(r => { release = r; });
  f.store.activate = async decision => { const result = await activate(decision); entered(); await proceed; return result; };
  try {
    const accepting = f.coordinator.acceptReview(e.decision); await swapped;
    assert.equal((await f.store.resolveActiveHost()).digest, f.next.manifest.bundleDigest);
    assert.equal(f.bootstrap.runtimeState.digest, f.first.manifest.bundleDigest);
    f.input.write(encodeNativeMessage({ type: 'turn.start', text: 'during cutover' }));
    f.input.write(encodeNativeMessage({ type: 'turn.interrupt' }));
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(f.turns, []); assert.deepEqual(f.starts, ['first']);
    release(); assert.equal((await accepting).state, 'activated');
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(f.starts, ['first', 'next']);
    assert.deepEqual(f.turns, [{ reviewId: 'next', type: 'turn.start' }, { reviewId: 'next', type: 'turn.interrupt' }]);
  } finally { release(); await f.bootstrap.close(); }
});

test('failed rollback reservation cannot fall back to lazily restarting pending B', { timeout: 15000 }, async t => {
  const f = await liveFixture(t); const e = await f.coordinator.startReview(); f.failAfter();
  const recover = f.store.recover.bind(f.store); const rollback = f.store.rollback.bind(f.store);
  f.store.rollback = async () => { throw new Error('restoration unavailable'); };
  f.store.recover = async () => { throw new Error('restoration unavailable'); };
  try {
    assert.equal((await f.coordinator.acceptReview(e.decision)).state, 'custody-broken');
    f.input.write(encodeNativeMessage({ type: 'turn.start', text: 'after rollback failure' }));
    f.input.write(encodeNativeMessage({ type: 'turn.interrupt' }));
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(f.starts, ['first', 'next']);
    assert.deepEqual(f.turns, []);
  } finally { f.store.rollback = rollback; f.store.recover = recover; await f.bootstrap.close(); }
});
