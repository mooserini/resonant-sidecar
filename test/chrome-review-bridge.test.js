import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChromeReviewJournal } from './fixtures/runtime-components.js';
import { ChromeReviewBridge, parseChromeSettlement } from '../review/chrome-review-bridge.js';
import { bridgeFixture, observations, RAW, NOW, OTHER, until, wireBinding } from './fixtures/chrome-bridge.js';
import { buildChromeReviewRequest } from '../review/semantic-evidence.js';
import { BoundedDecoder } from '../bootstrap/native-proxy.js';
import { encodeNativeMessage } from '../native-host/native-framing.js';

async function fixture(t, options = {}) {
  const f = await bridgeFixture(t); const journal = new ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: f.binding.restartId }); await journal.recover();
  const messages = []; let now = NOW; let current = f.current;
  const bridge = new ChromeReviewBridge({ journal, ...observations, clock: () => now, currentChannel: () => current, send: message => {
    const record = JSON.parse(fs.readFileSync(path.join(f.projectRoot, 'runtime/chrome-review-pending.json')));
    assert.equal(record.status, 'pending'); assert.deepEqual(record.binding, f.binding); messages.push(message);
  }, ...options });
  t.after(() => bridge.close('connection-loss'));
  return { ...f, bridge, journal, messages, tick: value => { now = value; }, channel: value => { current = value; },
    start: () => bridge.request({ binding: f.binding, packet: f.packet, deadline: f.deadline }),
    result: () => ({ type: 'review.chromeResult', ...f.binding, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' }) };
}
test('one issued invocation journals before emission and revalidates raw output before durable completion', async t => {
  const f = await fixture(t); assert.equal(f.bridge.handleSettlement(f.result()), false);
  const pending = f.start(); await until(() => f.messages.length === 1);
  assert.deepEqual(f.messages[0], { type: 'review.chromeReady', ...f.binding, packet: f.packet });
  assert.equal(f.bridge.handleSettlement(f.result()), true); assert.equal(f.bridge.handleSettlement(f.result()), false);
  const result = await pending;
  assert.equal(result.type, 'ChromeReviewResult'); assert.equal(result.analysis.outcome, 'no-blocking-concern');
  assert.equal(result.modelIdentityAssurance, 'not-attested'); assert.deepEqual(result.binding, f.binding);
  assert.equal(result.availabilityStatus, 'available'); assert.equal(result.executionStatus, 'completed');
  assert.equal(f.journal.recoveryState(), 'terminal-unreceipted'); assert.equal(f.journal.snapshot().reasonCode, 'completed');
  assert.equal(f.bridge.handleSettlement(f.result()), false); await assert.rejects(f.start());
});

test('malformed native UTF-8 cannot become a repaired ChromeReviewResult through decoder, bridge and durable journal', async t => {
  const f = await fixture(t); const pending = f.start(); await until(() => f.messages.length === 1);
  const valid = encodeNativeMessage(f.result()); const corrupted = Buffer.from(valid);
  const summaryStart = corrupted.indexOf(Buffer.from('No blocking concern.')); assert.ok(summaryStart > 4);
  corrupted[summaryStart] = 0xff;
  let dispatched = 0; let failure;
  const decoder = new BoundedDecoder(message => { dispatched++; f.bridge.handleSettlement(message); });
  try { decoder.push(Buffer.concat([corrupted, valid])); } catch (error) { failure = error; }
  // Mirrors bootstrap's framing-error path: channel loss closes the pending
  // bridge; a malformed frame must never reach its settlement callback.
  if (failure) await f.bridge.close('connection-loss');
  const result = await pending;
  assert.ok(failure instanceof TypeError, 'malformed UTF-8 must fail at the byte boundary');
  assert.equal(dispatched, 0); assert.equal(result.type, 'ChromeReviewFailure'); assert.equal(result.reasonCode, 'connection-loss');
  assert.equal(Object.hasOwn(result, 'analysis'), false);
  assert.equal(f.journal.recoveryState(), 'terminal-unreceipted'); assert.equal(f.journal.snapshot().reasonCode, 'connection-loss');
  assert.equal(f.bridge.handleSettlement(f.result()), false);
});
for (const field of ['reviewId', 'candidateDigest', 'activeDigest', 'policyDigest', 'invocationId', 'runtimeGeneration', 'inputDigest', 'evidenceDigest', 'promptDigest', 'schemaDigest', 'adapterDigest', 'deadline', 'channelId', 'restartId']) test(`cross-${field} cannot settle the issued invocation`, async t => {
  const f = await fixture(t); const pending = f.start(); await until(() => f.messages.length);
  const forged = f.result(); forged[field] = field === 'runtimeGeneration' ? 99 : field === 'deadline' ? '2026-09-14T12:00:30.000Z' : field.endsWith('Digest') ? 'f'.repeat(64) : OTHER;
  assert.equal(f.bridge.handleSettlement(forged), false); assert.equal(f.journal.recoveryState(), 'pending');
  assert.equal(f.bridge.handleSettlement(f.result()), true); assert.equal((await pending).type, 'ChromeReviewResult');
});
for (const reasonCode of ['cancellation', 'panel-closure', 'emergency-stop']) test(`${reasonCode} consumes once and rejects late output`, async t => {
  const f = await fixture(t); const pending = f.start(); await until(() => f.messages.length);
  assert.equal(f.bridge.handleSettlement({ type: 'review.chromeCancel', ...f.binding, reasonCode, availabilityStatus: 'available', executionStatus: 'failed' }), true);
  assert.equal(f.bridge.handleSettlement(f.result()), false);
  assert.equal((await pending).reasonCode, reasonCode); assert.equal(f.journal.snapshot().reasonCode, reasonCode);
});
for (const cause of ['timeout', 'generation', 'channel', 'close']) test(`${cause} invalidates pending or late favorable output`, async t => {
  const f = await fixture(t); const pending = f.start(); await until(() => f.messages.length);
  if (cause === 'timeout') f.tick(NOW + 60001);
  if (cause === 'generation') f.channel({ ...f.current, runtimeGeneration: 4 });
  if (cause === 'channel') f.channel({ ...f.current, channelId: OTHER });
  if (cause === 'close') await f.bridge.close('connection-loss');
  assert.equal(f.bridge.handleSettlement(f.result()), false);
  const result = await pending; assert.equal(result.type, 'ChromeReviewFailure');
  assert.equal(result.reasonCode, cause === 'timeout' ? 'timeout' : 'connection-loss');
  assert.equal(result.availabilityStatus, 'not-checked'); assert.equal(result.executionStatus, 'failed');
});
test('favorable callback followed by close during journal finalization remains failure', async t => {
  const f = await fixture(t); const finish = f.journal.finish.bind(f.journal); let entered; let release;
  const inside = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.journal.finish = async (...args) => { entered(); await gate; return finish(...args); };
  const pending = f.start(); await until(() => f.messages.length); assert.equal(f.bridge.handleSettlement(f.result()), true);
  await inside; const closing = f.bridge.close('connection-loss'); release(); await closing;
  assert.equal((await pending).reasonCode, 'connection-loss'); assert.equal(f.journal.snapshot().reasonCode, 'connection-loss');
});
test('exact cancellation can invalidate favorable output while its terminal journal write is pending', async t => {
  const f = await fixture(t); const finish = f.journal.finish.bind(f.journal); let entered; let release;
  const inside = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.journal.finish = async (...args) => { entered(); await gate; return finish(...args); };
  const pending = f.start(); await until(() => f.messages.length); f.bridge.handleSettlement(f.result()); await inside;
  const accepted = f.bridge.handleSettlement({ type: 'review.chromeCancel', ...f.binding, reasonCode: 'panel-closure', availabilityStatus: 'available', executionStatus: 'failed' }); release();
  const result = await pending; assert.equal(accepted, true);
  assert.equal(result.reasonCode, 'panel-closure'); assert.equal(f.journal.snapshot().reasonCode, 'panel-closure');
});
for (const stage of ['pending', 'terminal']) test(`failed ${stage} atomic rename never resolves favorable or exposes an unjournaled request`, async t => {
  const f = await fixture(t); const rename = fs.renameSync; const file = path.join(f.projectRoot, 'runtime/chrome-review-pending.json');
  const breakRename = (from, to) => { if (to === file) throw new Error('injected rename failure'); return rename(from, to); };
  let pending;
  if (stage === 'pending') fs.renameSync = breakRename;
  try {
    pending = f.start(); const rejected = assert.rejects(pending, /journal unavailable/);
    if (stage === 'terminal') { await until(() => f.messages.length); fs.renameSync = breakRename; f.bridge.handleSettlement(f.result()); }
    await rejected;
  } finally { fs.renameSync = rename; }
  assert.equal(f.messages.length, stage === 'pending' ? 0 : 1);
  assert.equal(f.journal.recoveryState(), stage === 'pending' ? 'empty' : 'pending');
});
test('raw malformed output becomes a bound fixed failure without retaining model prose', async t => {
  const f = await fixture(t); const pending = f.start(); await until(() => f.messages.length);
  assert.equal(f.bridge.handleSettlement({ ...f.result(), rawText: '{"schemaVersion":2,"schemaVersion":2}' }), true);
  const result = await pending; assert.equal(result.reasonCode, 'malformed-output'); assert.equal(Object.hasOwn(result, 'rawText'), false);
  assert.equal(result.availabilityStatus, 'available'); assert.equal(result.executionStatus, 'failed');
});
test('null-output preflight failure stays bound without manufacturing analysis or provenance', async t => {
  const f = await fixture(t); const pending = f.start(); await until(() => f.messages.length);
  assert.equal(f.bridge.handleSettlement({ ...f.result(), rawText: null, reasonCode: 'api-absent', availabilityStatus: 'api-absent', executionStatus: 'not-run' }), true);
  const result = await pending; assert.equal(result.reasonCode, 'api-absent'); assert.equal(Object.hasOwn(result, 'analysis'), false); assert.deepEqual(result.binding, f.binding);
  assert.equal(result.availabilityStatus, 'api-absent'); assert.equal(result.executionStatus, 'not-run');
});
test('tampered Task 3 packet or digest is rejected before journal and emission', async t => {
  const f = await fixture(t);
  for (const mutation of ['source', 'digest']) {
    const packet = structuredClone(f.packet); const binding = { ...f.binding };
    if (mutation === 'source') packet.evidence.sourceDiff.changedFiles[0].afterText = 'forged'; else binding.inputDigest = 'f'.repeat(64);
    await assert.rejects(f.bridge.request({ binding, packet, deadline: f.deadline }));
  }
  assert.equal(f.messages.length, 0); assert.equal(f.journal.recoveryState(), 'empty');
});
test('deadline timer durably fails an invocation even when no browser callback arrives', async t => {
  const f = await fixture(t, { send() {} });
  const request = buildChromeReviewRequest({ evidence: f.packet.evidence, evidenceDigest: f.packet.evidenceDigest, invocationId: f.packet.invocationId, runtimeGeneration: 3, adapterDigest: f.packet.adapterDigest, deadline: new Date(NOW + 20).toISOString() });
  const result = await f.bridge.request({ binding: wireBinding(request), packet: request.packet, deadline: request.packet.deadline });
  assert.equal(result.reasonCode, 'timeout'); assert.equal(f.journal.snapshot().reasonCode, 'timeout'); assert.equal(f.journal.recoveryState(), 'terminal-unreceipted');
});
test('close during pending persistence suppresses ready emission and leaves a durable terminal failure', async t => {
  const f = await fixture(t); const begin = f.journal.begin.bind(f.journal); let release;
  const gate = new Promise(resolve => { release = resolve; }); f.journal.begin = async binding => { await gate; return begin(binding); };
  const pending = f.start(); const closing = f.bridge.close('connection-loss'); release(); await closing;
  assert.equal((await pending).reasonCode, 'connection-loss'); assert.equal(f.messages.length, 0); assert.equal(f.journal.snapshot().reasonCode, 'connection-loss');
});
test('trusted cancellation latch rejects a callback before asynchronous terminal persistence finishes', async t => {
  const f = await fixture(t); const pending = f.start(); await until(() => f.messages.length);
  const cancelling = f.bridge.cancelPending('emergency-stop'); const accepted = f.bridge.handleSettlement(f.result());
  const result = await pending; await cancelling;
  assert.equal(accepted, false); assert.equal(result.reasonCode, 'emergency-stop');
});

test('Chrome settlement lane has exact data-only result/cancel shapes and no lifecycle authority', async t => {
  const f = await bridgeFixture(t);
  assert.equal(typeof parseChromeSettlement, 'function');
  const messages = [{ type: 'review.chromeResult', ...f.binding, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' },
    { type: 'review.chromeResult', ...f.binding, rawText: null, reasonCode: 'setup-required', availabilityStatus: 'setup-required', executionStatus: 'not-run' },
    ...['cancellation', 'panel-closure', 'emergency-stop'].map(reasonCode => ({ type: 'review.chromeCancel', ...f.binding, reasonCode, availabilityStatus: 'available', executionStatus: 'failed' }))];
  for (const message of messages) {
    assert.deepEqual(parseChromeSettlement(message), message);
    for (const key of Object.keys(message).filter(key => key !== 'type')) { const missing = { ...message }; delete missing[key]; assert.throws(() => parseChromeSettlement(missing)); }
    for (const key of ['path', 'tool', 'command', 'policy', 'decision', 'nonce', 'action', 'url', 'state', 'analysis', 'browserObservation']) assert.throws(() => parseChromeSettlement({ ...message, [key]: 'private' }));
  }
  for (const type of ['review.start', 'review.accept', 'review.reject', 'review.openReport', 'review.openDesktop', 'update.status', 'turn.start']) assert.equal(parseChromeSettlement({ type, ...f.binding }), null);
  for (const patch of [{ rawText: RAW, reasonCode: 'unavailable' }, { rawText: null, reasonCode: null }, { rawText: null, reasonCode: 'interrupted-restart' }, { rawText: 'x'.repeat(65537), reasonCode: null }, { rawText: { outcome: 'accept' }, reasonCode: null }]) assert.throws(() => parseChromeSettlement({ ...messages[0], ...patch }));
  assert.throws(() => parseChromeSettlement({ type: 'review.chromeCancel', ...f.binding, reasonCode: 'browser-restart' }));
  let reads = 0; const getter = { ...messages[0], get rawText() { reads++; return RAW; } };
  assert.throws(() => parseChromeSettlement(getter)); assert.equal(reads, 0);
  assert.throws(() => parseChromeSettlement(new Proxy(messages[0], {})));
});

test('Chrome status scalars obey the complete Task 5 reason and execution coherence table', async t => {
  const f = await bridgeFixture(t);
  const availability = ['available', 'api-absent', 'setup-required', 'setup-declined', 'unavailable', 'not-checked'];
  const interruptionPairs = ['available/failed', 'available/not-run', 'api-absent/not-run', 'setup-required/not-run', 'setup-declined/not-run', 'unavailable/not-run', 'not-checked/not-run'];
  const rules = [
    [null, ['available/completed']], ['api-absent', ['api-absent/not-run']], ['setup-required', ['setup-required/not-run']], ['setup-declined', ['setup-declined/not-run']], ['unavailable', ['unavailable/not-run']], ['malformed-output', ['available/failed']],
    ...['timeout', 'connection-loss', 'provenance-drift', 'custody-failure', 'cancellation', 'panel-closure', 'emergency-stop'].map(reason => [reason, interruptionPairs]),
  ];
  for (const [reasonCode, allowed] of rules) for (const availabilityStatus of availability) for (const executionStatus of ['completed', 'failed', 'not-run']) {
    const cancel = ['cancellation', 'panel-closure', 'emergency-stop'].includes(reasonCode);
    const message = { type: cancel ? 'review.chromeCancel' : 'review.chromeResult', ...f.binding, reasonCode, availabilityStatus, executionStatus, ...(cancel ? {} : { rawText: reasonCode === null ? RAW : null }) };
    let accepted = false; try { accepted = parseChromeSettlement(message) !== null; } catch {}
    assert.equal(accepted, allowed.includes(`${availabilityStatus}/${executionStatus}`), `${reasonCode}: ${availabilityStatus}/${executionStatus}`);
  }
});
