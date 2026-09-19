import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runtimeFixture, decisionFor, consumer } from './fixtures/runtime.js';
import { VersionStore, ChromeReviewJournal, withTestRuntimeLock } from './fixtures/runtime-components.js';
import { ReceiptStore } from '../review/receipt-store.js';
import { DecisionNonces } from '../review/decision-nonce.js';
import { ReviewCoordinator } from '../review/review-coordinator.js';
import { runBootstrap } from '../bootstrap/host.js';
import { encodeNativeMessage, NativeMessageDecoder } from '../native-host/native-framing.js';
import { sha256Bytes, sha256Json } from '../review/canonical-json.js';
import { collectMacOSEvidence } from '../review/macos-evidence.js';
import { policy as osPolicy, runner } from './fixtures/macos/fixture.js';
import { bridgeFixture, observations, NOW, RAW, until } from './fixtures/chrome-bridge.js';

import { ChromeReviewBridge } from '../review/chrome-review-bridge.js';
import { loadReviewPolicy } from '../review/policy-registry.js';

const policy = JSON.parse(readFileSync(new URL('../policy/review-policy.v1.json', import.meta.url)));
const favorable = { schemaVersion: 1, verdict: 'favorable', summary: 'No policy concerns', behavioralDifferences: [], dependencyChanges: [], unexplainedFiles: [], policyConcerns: [] };

test('Chrome cancel remains observable after result resolution and before permanent receipt acknowledgement', async t => {
  const f = await bridgeFixture(t); const journal = new ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: f.binding.restartId }); await journal.recover();
  let ready;
  const bridge = new ChromeReviewBridge({ journal, currentChannel: () => f.current, send: value => { ready = value; }, clock: () => NOW, ...observations });
  t.after(() => bridge.close('connection-loss'));
  const work = bridge.request({ binding: f.binding, packet: f.packet, deadline: f.deadline }); await until(() => ready);
  assert.equal(bridge.handleSettlement({ type: 'review.chromeResult', ...f.binding, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' }), true);
  assert.equal((await work).type, 'ChromeReviewResult');
  assert.equal(journal.recoveryState(), 'terminal-unreceipted');
  assert.equal(bridge.handleSettlement({ type: 'review.chromeCancel', ...f.binding, reasonCode: 'emergency-stop', availabilityStatus: 'available', executionStatus: 'failed' }), true);
  assert.equal(bridge.status(f.binding).reasonCode, 'emergency-stop');
  assert.equal(bridge.handleSettlement({ type: 'review.chromeResult', ...f.binding, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' }), false);
});
async function liveFixture(t, options = {}) {
  const fixturePolicy = options.chrome ? loadReviewPolicy(2) : policy;
  const f = await runtimeFixture(t); const first = await f.stage('first'); const next = await f.stage('next', '// next');
  const seed = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await seed.installVersion(first); await seed.activate(decisionFor(first)); await seed.completeActivation(decisionFor(first));
  const receipts = new ReceiptStore({ root: path.join(f.projectRoot, 'review-receipts'), policy: fixturePolicy, immutable: async () => {} });
  let coordinator; let bootstrap; let failAfter = false; let rejectSend = false;
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: d => coordinator.consumeDecision(d), verifyConsumedDecision: b => coordinator.verifyConsumedDecision(b) });
  const runtime = {
    snapshot: () => bootstrap.runtimeState,
    refreshPending: d => bootstrap.refreshPending(d), refreshRecovered: b => bootstrap.refreshRecovered(b),
    stopCandidate: () => bootstrap.stopCandidate(), restartPrevious: () => bootstrap.restartPrevious(),
    withTransition: operation => bootstrap.withTransition(operation),
  };
  const deps = { receiptStore: receipts, nonceStore: new DecisionNonces({ root: f.root }), versionStore: store, policy: fixturePolicy, reviewId: () => 'next', runtime,
    candidateSource: { inspect: async () => ({ state: 'available', digest: next.manifest.bundleDigest }), stage: async () => next },
    deterministicReview: async () => ({ passed: true, checks: [{ name: 'trusted-tests', passed: true }], activeBundleDigest: first.manifest.bundleDigest, candidateBundleDigest: next.manifest.bundleDigest, policySnapshotHash: sha256Json(fixturePolicy) }),
    codexReview: async input => {
      const identity = { pid: 105, executablePath: '/usr/bin/true', executableSha256: sha256Bytes(readFileSync('/usr/bin/true')) };
      const binding = await input.sampleVerifier(identity);
      const r = { passed: true, reasonCode: 'codex-favorable', attestation: favorable, verifierIdentities: [{ name: 'codex-process-evidence', sha256: sha256Json(binding) }], activeBundleDigest: first.manifest.bundleDigest, candidateBundleDigest: next.manifest.bundleDigest, policySnapshotHash: sha256Json(fixturePolicy) };
      await input.finalizeResult(r); return r;
    },
    ownershipPolicy: (phase, live) => {
      const value = osPolicy(phase);
      if (phase === 'verification' && live?.verifier) {
        const verifier = value.processes.find(process => process.name === 'verifier');
        verifier.pid = live.verifier.pid;
        verifier.executablePath = live.verifier.executablePath;
      }
      return value;
    },
    collectEvidence: async input => { const e = await collectMacOSEvidence({ ...input, runner: runner().run }); if (input.phase === 'after' && failAfter) { failAfter = false; e.processes.find(p => p.name === 'active-host').listeners.push({ fd: 17, protocol: 'TCP', address: '127.0.0.1', port: 9000, transport: 'tcp' }); } return e; },
  };
  if (options.chrome) Object.assign(deps, {
    chromeJournal: Object.fromEntries(['recover', 'snapshot', 'markReceipted', 'finish'].map(method => [method, (...args) => bootstrap.chromeReviewJournal[method](...args)])),
    chromeContext: () => ({ ...bootstrap.chromeReviewIdentity, adapterDigest: 'a'.repeat(64), ...observations }),
    mintChromeInvocation: () => bootstrap.mintChromeInvocation(), chromeReview: request => bootstrap.requestChromeReview(request),
    chromeReviewStatus: binding => bootstrap.chromeReviewStatus(binding), completeChromeReview: binding => bootstrap.completeChromeReview(binding), clock: () => NOW,
  });
  coordinator = new ReviewCoordinator(deps);
  const input = new PassThrough(); const starts = []; const turns = []; const reaped = [];
  const output = new PassThrough(); const messages = []; const decoder = new NativeMessageDecoder(message => messages.push(message)); output.on('data', chunk => decoder.push(chunk));
  bootstrap = await runBootstrap({ store, coordinator, input, output, ...(options.chrome ? { chromeReview: { projectRoot: f.projectRoot, clock: () => NOW, ...observations, withRuntimeLock: withTestRuntimeLock } } : {}), signals: new EventEmitter(), proxyFactory: ({ active, onMessage }) => {
    starts.push(active.reviewId);
    return { pid: 103, send: m => { if (rejectSend) throw new Error('proxy transport rejected frame'); if (m.type === 'session.open') queueMicrotask(() => onMessage({ type: 'session.ready', threadId: 'thread-kept' })); else turns.push({ reviewId: active.reviewId, type: m.type }); }, close: async () => { reaped.push(active.reviewId); } };
  } });
  input.write(encodeNativeMessage({ type: 'session.open', threadId: 'thread-kept' }));
  while (!bootstrap.runtimeState?.threadId) await new Promise(r => setTimeout(r, 5));
  return { ...f, first, next, receipts, store, coordinator, bootstrap, input, starts, turns, reaped, deps, messages,
    failAfter: () => { failAfter = true; }, rejectSend: () => { rejectSend = true; }, events: async () => (await receipts.verifyChain()).receipts?.map(r => r.eventType),
  };
}

test('native emergency Stop after Chrome result finalizes one failed artifact and still interrupts conversation', async t => {
  const f = await liveFixture(t, { chrome: true });
  try {
  const finalize = f.receipts.finalizeEvent.bind(f.receipts); let interrupts = 0;
  f.receipts.finalizeEvent = async input => {
    if (input.eventType === 'eligible') { interrupts++; f.input.write(encodeNativeMessage({ type: 'turn.interrupt' })); }
    return finalize(input);
  };
  let issued = 0; const issue = f.deps.nonceStore.issue.bind(f.deps.nonceStore);
  f.deps.nonceStore.issue = (...args) => { issued++; return issue(...args); };
  const work = f.coordinator.startReview();
  await until(() => f.messages.some(message => message.type === 'review.chromeReady'));
  const { type, packet, ...binding } = f.messages.find(message => message.type === 'review.chromeReady');
  const result = { type: 'review.chromeResult', ...binding, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' };
  f.input.write(encodeNativeMessage(result));
  assert.equal((await work).state, 'review-failed');
  await until(() => f.turns.some(turn => turn.type === 'turn.interrupt'));
  assert.equal(interrupts, 1); assert.equal(issued, 0);
  assert.equal(f.bootstrap.chromeReviewJournal.recoveryState(), 'receipted');
  const chain = await f.receipts.verifyChain(); const terminal = chain.receipts.at(-1);
  assert.equal(terminal.semanticReview.reasonCode, 'cancellation'); assert.equal(terminal.semanticReview.analysis, null);
  assert.equal(chain.receipts.filter(receipt => receipt.eventType === 'review-failed').length, 1);
  f.input.write(encodeNativeMessage(result)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.coordinator.state, 'review-failed'); assert.equal(issued, 0);
  assert.equal((await f.store.resolveActiveHost()).digest, f.first.manifest.bundleDigest);
  } finally { await f.bootstrap.close(); }
});

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

for (const type of ['turn.start', 'turn.interrupt']) test(`queued ${type} survives candidate resolution failure and reaches restored A`, { timeout: 15000 }, async t => {
  const f = await liveFixture(t); const e = await f.coordinator.startReview();
  let entered; let rejectResolution;
  const resolving = new Promise(r => { entered = r; });
  f.store.resolvePendingHost = () => { entered(); return new Promise((resolve, reject) => { rejectResolution = reject; }); };
  try {
    const accepting = f.coordinator.acceptReview(e.decision); await resolving;
    f.input.write(encodeNativeMessage(type === 'turn.start' ? { type, text: 'queued during candidate resolution' } : { type }));
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(f.turns, []);
    rejectResolution(new Error('candidate resolution failed'));
    assert.equal((await accepting).state, 'rolled-back');
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(f.starts, ['first', 'first']);
    assert.equal(f.bootstrap.runtimeState?.digest, f.first.manifest.bundleDigest);
    assert.deepEqual(f.turns, [{ reviewId: 'first', type }]);
    assert.deepEqual((await f.events()).slice(-3), ['activation-failed', 'rolling-back', 'rolled-back']);
    f.input.write(encodeNativeMessage({ type: 'turn.start', text: 'A remains usable' }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(f.turns.length, 2);
  } finally { await f.bootstrap.close(); }
});

for (const failure of ['proxy-send', 'framing']) test(`actual ${failure} failure still closes and reaps the active proxy`, { timeout: 15000 }, async t => {
  const f = await liveFixture(t);
  if (failure === 'proxy-send') { f.rejectSend(); f.input.write(encodeNativeMessage({ type: 'turn.interrupt' })); }
  else f.input.write(Buffer.from([255, 255, 255, 255]));
  await f.bootstrap.closed;
  assert.equal(f.bootstrap.runtimeState, null);
  assert.deepEqual(f.reaped, ['first']);
  assert.deepEqual(f.turns, []);
});

test('native disconnect invalidates an emitted Chrome invocation before late result can settle it', async t => {
  const f = await bridgeFixture(t, { runtimeGeneration: 1 }); const input = new PassThrough(); let reaped = false;
  const runtime = await runBootstrap({ input, output: new PassThrough(), signals: new EventEmitter(),
    chromeReview: { projectRoot: f.projectRoot, ...observations, clock: () => NOW, withRuntimeLock: withTestRuntimeLock },
    store: { recover: async () => {}, bindRuntimeGuard() {}, resolveActiveHost: async () => ({ digest: f.binding.activeDigest, reviewId: 'active' }) },
    proxyFactory: () => ({ pid: 103, send() {}, close: async () => { reaped = true; } }),
  });
  t.after(() => runtime.close()); assert.equal(typeof runtime.requestChromeReview, 'function');
  input.write(encodeNativeMessage({ type: 'turn.start', text: 'ordinary' })); await until(() => runtime.runtimeState);
  const binding = { ...f.binding, ...runtime.chromeReviewIdentity };
  const pending = runtime.requestChromeReview({ binding, packet: f.packet, deadline: f.deadline });
  await until(() => runtime.chromeReviewJournal.recoveryState() === 'pending');
  const closing = runtime.close();
  input.write(encodeNativeMessage({ type: 'review.chromeResult', ...binding, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' }));
  assert.equal((await pending).reasonCode, 'connection-loss'); await closing;
  assert.equal(reaped, true); assert.equal(runtime.chromeReviewJournal.snapshot().reasonCode, 'connection-loss');
});

for (const action of ['generation-change', 'emergency-stop']) test(`${action} aborts Chrome immediately while preserving ordinary runtime ownership`, async t => {
  const f = await bridgeFixture(t, { runtimeGeneration: 1 }); const input = new PassThrough(); const turns = [];
  const runtime = await runBootstrap({ input, output: new PassThrough(), signals: new EventEmitter(), chromeReview: { projectRoot: f.projectRoot, ...observations, clock: () => NOW, withRuntimeLock: withTestRuntimeLock },
    store: { recover: async () => {}, bindRuntimeGuard() {}, resolveActiveHost: async () => ({ digest: f.binding.activeDigest, reviewId: 'active' }) },
    proxyFactory: () => ({ pid: 103, send: message => turns.push(message), close: async () => {} }),
  });
  t.after(() => runtime.close()); input.write(encodeNativeMessage({ type: 'turn.start', text: 'ordinary' })); await until(() => runtime.runtimeState);
  const binding = { ...f.binding, ...runtime.chromeReviewIdentity }; const pending = runtime.requestChromeReview({ binding, packet: f.packet, deadline: f.deadline });
  await until(() => runtime.chromeReviewJournal.recoveryState() === 'pending');
  let settled = false; pending.then(() => { settled = true; });
  if (action === 'generation-change') {
    await runtime.stopCandidate();
    const settledBeforeReturn = settled;
    if (!settledBeforeReturn) { await runtime.close(); await pending; }
    assert.equal(settledBeforeReturn, true, 'runtime transition cannot return with its Chrome invocation pending');
  } else {
    input.write(encodeNativeMessage({ type: 'turn.interrupt' }));
    input.write(encodeNativeMessage({ type: 'review.chromeResult', ...binding, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' }));
  }
  const result = await pending;
  assert.equal(result?.reasonCode, action === 'generation-change' ? 'connection-loss' : 'emergency-stop');
  assert.equal(runtime.runtimeState === null, action === 'generation-change');
  if (action === 'emergency-stop') { await until(() => turns.length === 2); assert.equal(turns[1].type, 'turn.interrupt'); }
});
