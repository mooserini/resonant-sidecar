import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { bridgeFixture, NOW, RAW, observations, until } from './fixtures/chrome-bridge.js';
import { ChromeReviewBridge, parseChromeSettlement } from '../review/chrome-review-bridge.js';
import { ChromeReviewJournal } from './fixtures/runtime-components.js';
import { buildChromeReviewPrompt, CHROME_REVIEW_PROMPT, CHROME_REVIEW_SCHEMA } from '../extension/chrome-review-contract.js';
import { sha256Json, sha256Bytes } from '../review/canonical-json.js';
import { createChromeReviewAdapter } from '../extension/chrome-review-adapter.js';

const NOTICE = 'Local analysis uses a Chrome-managed on-device model that may already be stored or updated on this device.';
const PREPARE_NOTICE = 'Chrome may download and store an on-device model. Preparation does not run analysis.';
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function harness(t, { availability = 'available', create, prompt, destroy, absent = false } = {}) {
  const fixture = await bridgeFixture(t), calls = [], states = [], results = [], cancels = [], sessions = [], timers = new Map();
  let now = NOW, timerId = 0;
  const languageModel = absent ? undefined : {
    availability(options) { calls.push(['availability', options]); return typeof availability === 'function' ? availability() : Promise.resolve(availability); },
    create(options) {
      calls.push(['create', options]);
      const session = { destroyCalls: 0,
        prompt(input, options) { calls.push(['prompt', input, options]); return prompt ? prompt(input, options) : Promise.resolve(RAW); },
        destroy() { this.destroyCalls++; calls.push(['destroy']); return destroy?.(); },
      };
      sessions.push(session);
      return create ? create(session, options) : Promise.resolve(session);
    },
  };
  const adapter = createChromeReviewAdapter({ languageModel, sendResult: message => { parseChromeSettlement(message); results.push(message); },
    sendCancel: message => { parseChromeSettlement(message); cancels.push(message); }, onState: state => states.push(state),
    clock: () => now, setTimer: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, clearTimer: id => timers.delete(id),
  });
  t.after(() => adapter.destroy('panel-closure'));
  return { ...fixture, adapter, calls, states, results, cancels, sessions, timers, ready: { type: 'review.chromeReady', ...fixture.binding, packet: fixture.packet },
    advance(ms) { now += ms; for (const timer of [...timers.values()]) timer.callback(); },
  };
}

test('construction and unrequested actions make no model calls; one verified ready permits only availability', async t => {
  const h = await harness(t);
  assert.equal(await h.adapter.prepare(), false); assert.equal(await h.adapter.run(), false);
  assert.deepEqual(h.calls, []);
  assert.equal(await h.adapter.inspect(h.ready), true);
  assert.deepEqual(h.calls, [['availability', { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] }]]);
  assert.equal(h.states.at(-1).state, 'ready'); assert.equal(h.states.at(-1).notice, NOTICE);
  assert.equal(await h.adapter.inspect(h.ready), false); assert.equal(h.calls.length, 1);
});

for (const availability of ['downloadable', 'downloading']) test(`${availability} requires disclosed preparation and a separate fresh analysis session`, async t => {
  const h = await harness(t, { availability }); await h.adapter.inspect(h.ready);
  assert.equal(h.states.at(-1).state, 'preparation-required');
  assert.equal(h.states.at(-1).notice, NOTICE); assert.equal(h.states.at(-1).preparationNotice, PREPARE_NOTICE);
  assert.equal(await h.adapter.run(), false); assert.equal(h.calls.length, 1);
  const preparation = h.adapter.prepare();
  assert.equal(h.calls.filter(c => c[0] === 'create').length, 1, 'create occurs synchronously within the direct action');
  assert.equal(await h.adapter.prepare(), false, 'double clicks cannot acquire a second session');
  await preparation;
  assert.equal(h.sessions[0].destroyCalls, 1); assert.equal(h.calls.some(c => c[0] === 'prompt'), false);
  assert.equal(h.states.at(-1).state, 'ready'); assert.equal(h.states.at(-1).notice, NOTICE);
  const run = h.adapter.run(); assert.equal(h.calls.filter(c => c[0] === 'create').length, 2);
  await run;
  assert.equal(h.sessions[1].destroyCalls, 1); assert.equal(h.results.length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'availability').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'prompt').length, 1);
});

test('Run submits the verified fixed prompt/schema once with no tool/session history and destroys before settlement', async t => {
  const h = await harness(t); await h.adapter.inspect(h.ready);
  const running = h.adapter.run(); assert.equal(h.calls.at(-1)[0], 'create');
  assert.equal(await h.adapter.run(), false); await running;
  const options = h.calls.find(c => c[0] === 'create')[1];
  assert.deepEqual(Object.keys(options).sort(), ['expectedInputs', 'expectedOutputs', 'initialPrompts', 'monitor', 'signal']);
  assert.deepEqual(options.initialPrompts, [{ role: 'system', content: CHROME_REVIEW_PROMPT }]);
  const [, input, promptOptions] = h.calls.find(c => c[0] === 'prompt');
  assert.equal(input, buildChromeReviewPrompt({ evidence: h.packet.evidence, evidenceDigest: h.packet.evidenceDigest }));
  assert.deepEqual(Object.keys(promptOptions).sort(), ['responseConstraint', 'signal']);
  assert.deepEqual(promptOptions.responseConstraint, CHROME_REVIEW_SCHEMA); assert.equal(promptOptions.signal, options.signal);
  assert.equal(h.sessions[0].destroyCalls, 1);
  assert.deepEqual(h.results, [{ type: 'review.chromeResult', ...h.binding, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' }]);
  assert.equal(h.states.at(-1).state, 'completed'); assert.equal(await h.adapter.run(), false);
  assert.equal(JSON.stringify(h.states).includes('No blocking concern.'), false);
});

for (const [availability, absent, reason] of [['unavailable', false, 'unavailable'], ['unknown', false, 'unavailable'], [null, true, 'api-absent']]) {
  test(`preflight ${reason}/${availability} settles without any session`, async t => {
    const h = await harness(t, { availability, absent }); await h.adapter.inspect(h.ready);
    assert.equal(h.calls.some(c => c[0] === 'create'), false);
    assert.equal(h.results[0].reasonCode, reason); assert.equal(h.results[0].availabilityStatus, reason); assert.equal(h.results[0].executionStatus, 'not-run');
    assert.equal(h.states.at(-1).state, 'failed');
  });
}

test('rejected preparation reports setup-declined without prompting or retry', async t => {
  const h = await harness(t, { availability: 'downloadable', create: () => Promise.reject(new Error('PRIVATE')) });
  await h.adapter.inspect(h.ready); await h.adapter.prepare();
  assert.equal(h.results[0].reasonCode, 'setup-declined'); assert.equal(h.results[0].executionStatus, 'not-run');
  assert.equal(await h.adapter.prepare(), false); assert.equal(h.calls.some(c => c[0] === 'prompt'), false);
  assert.equal(JSON.stringify(h.states).includes('PRIVATE'), false);
});

for (const stage of ['create', 'prompt']) test(`QuotaExceededError during ${stage} fails closed without retry`, async t => {
  const fail = () => Promise.reject(Object.assign(new Error('PRIVATE QUOTA'), { name: 'QuotaExceededError' }));
  const h = await harness(t, stage === 'create' ? { create: fail } : { prompt: fail });
  await h.adapter.inspect(h.ready); await h.adapter.run();
  assert.equal(h.results.length, 1); assert.equal(h.results[0].reasonCode, stage === 'create' ? 'unavailable' : 'custody-failure');
  assert.equal(h.results[0].executionStatus, stage === 'create' ? 'not-run' : 'failed');
  if (stage === 'prompt') assert.equal(h.sessions[0].destroyCalls, 1);
  assert.equal(await h.adapter.run(), false);
});

for (const raw of ['{}', RAW + ' PRIVATE', '{"schemaVersion":2,"schemaVersion":2}', RAW.replace('"findings":[]', '"findings":[],"command":"PRIVATE"'), '\ud800', 'x'.repeat(65537)]) test(`malformed output ${raw.length} is withheld and never rendered`, async t => {
  const h = await harness(t, { prompt: () => Promise.resolve(raw) }); await h.adapter.inspect(h.ready); await h.adapter.run();
  assert.equal(h.results[0].reasonCode, 'malformed-output'); assert.equal(h.results[0].rawText, null); assert.equal(h.sessions[0].destroyCalls, 1);
  assert.equal(JSON.stringify(h.states).includes('PRIVATE'), false);
});

for (const stage of ['availability', 'create', 'prompt']) test(`timeout during ${stage} settles promptly and disposes a late session/result`, async t => {
  const gate = defer(); let returnedSession;
  const h = await harness(t, stage === 'availability' ? { availability: () => gate.promise } : stage === 'create' ? { create: session => { returnedSession = session; return gate.promise; } } : { prompt: () => gate.promise });
  let work = h.adapter.inspect(h.ready);
  if (stage !== 'availability') { await work; work = h.adapter.run(); await until(() => h.calls.some(c => c[0] === stage)); }
  else await until(() => h.calls.some(c => c[0] === 'availability'));
  h.advance(60000); await work;
  assert.equal(h.results.length, 1); assert.equal(h.results[0].reasonCode, 'timeout');
  gate.resolve(stage === 'create' ? returnedSession : stage === 'availability' ? 'available' : RAW);
  if (stage !== 'availability') await until(() => h.sessions[0].destroyCalls === 1);
  assert.equal(h.results.length, 1); assert.equal(h.states.at(-1).state, 'failed');
});

for (const stage of ['create', 'prompt']) for (const reason of ['cancellation', 'panel-closure', 'emergency-stop', 'connection-loss', 'provenance-drift']) test(`${reason} during ${stage} aborts immediately and discards late completion`, async t => {
  const gate = defer(); let returnedSession;
  const h = await harness(t, stage === 'create' ? { create: session => { returnedSession = session; return gate.promise; } } : { prompt: () => gate.promise });
  await h.adapter.inspect(h.ready); const work = h.adapter.run(); await until(() => h.calls.some(c => c[0] === stage));
  h.adapter.cancel(reason);
  assert.equal(h.calls.find(c => c[0] === 'create')[1].signal.aborted, true);
  const messages = ['cancellation', 'panel-closure', 'emergency-stop'].includes(reason) ? h.cancels : h.results;
  assert.equal(messages.length, 1); assert.equal(messages[0].reasonCode, reason);
  await work; h.adapter.cancel(reason); assert.equal(messages.length, 1);
  gate.resolve(stage === 'create' ? returnedSession : RAW); await until(() => h.sessions[0].destroyCalls === 1);
  assert.equal(h.results.some(result => result.rawText !== null), false);
});

test('destruction failure withholds a favorable callback', async t => {
  const h = await harness(t, { destroy: () => { throw new Error('PRIVATE cleanup'); } }); await h.adapter.inspect(h.ready); await h.adapter.run();
  assert.equal(h.sessions[0].destroyCalls, 1); assert.equal(h.results[0].reasonCode, 'custody-failure'); assert.equal(h.results[0].rawText, null);
});

for (const field of ['activeDigest', 'candidateDigest', 'policyDigest', 'reviewId', 'invocationId', 'runtimeGeneration', 'inputDigest', 'evidenceDigest', 'promptDigest', 'schemaDigest', 'adapterDigest', 'deadline']) test(`changed outer ${field} never reaches availability or review controls`, async t => {
  const h = await harness(t); const bad = structuredClone(h.ready);
  bad[field] = field === 'runtimeGeneration' ? 4 : field === 'deadline' ? new Date(NOW + 50000).toISOString() : field.endsWith('Digest') ? 'f'.repeat(64) : 'other';
  assert.equal(await h.adapter.inspect(bad), false); assert.deepEqual(h.calls, []);
  assert.equal(h.states.some(state => ['ready', 'preparation-required'].includes(state.state)), false);
});

for (const change of ['source', 'prompt', 'schema', 'extra', 'incomplete', 'policy', 'expired', 'excess-deadline']) test(`packet ${change} is cryptographically or structurally rejected before feature detection`, async t => {
  const h = await harness(t); const bad = structuredClone(h.ready);
  if (change === 'source') bad.packet.evidence.sourceDiff.changedFiles[0].afterText = 'export const value = 9;\n';
  if (change === 'prompt') bad.packet.promptId = 'untrusted';
  if (change === 'schema') bad.packet.schemaId = 'untrusted';
  if (change === 'extra') bad.packet.command = 'PRIVATE';
  if (change === 'incomplete') bad.packet.evidence.sourceDiff.coverageStatus = 'incomplete-input';
  if (change === 'policy') bad.packet.evidence.policy.schemaVersion = 1;
  if (change.endsWith('deadline') || change === 'expired') bad.deadline = bad.packet.deadline = new Date(NOW + (change === 'expired' ? 0 : 600001)).toISOString();
  // Rehash the envelope: nested hashes and fixed prompt/schema must still be checked.
  bad.inputDigest = sha256Json(bad.packet);
  assert.equal(await h.adapter.inspect(bad), false); assert.deepEqual(h.calls, []);
});

test('caller mutation during WebCrypto checks cannot replace the retained input', async t => {
  const h = await harness(t); const mutable = structuredClone(h.ready); const checking = h.adapter.inspect(mutable);
  mutable.packet.evidence.sourceDiff.changedFiles[0].afterText = 'PRIVATE'; mutable.candidateDigest = 'f'.repeat(64);
  assert.equal(await checking, true); await h.adapter.run(); assert.equal(h.results[0].candidateDigest, h.binding.candidateDigest);
  assert.equal(h.calls.find(c => c[0] === 'prompt')[1].includes('PRIVATE'), false);
});

test('fake model cancellation reaches the real durable bridge/journal with no favorable resurrection', async t => {
  const h = await harness(t, { prompt: () => new Promise(() => {}) });
  const journal = new ChromeReviewJournal({ projectRoot: h.projectRoot, restartId: h.binding.restartId }); await journal.recover();
  const bridge = new ChromeReviewBridge({ journal, send: message => h.adapter.inspect(message), currentChannel: () => h.current, clock: () => NOW, ...observations });
  t.after(() => bridge.close('connection-loss'));
  const result = bridge.request({ binding: h.binding, packet: h.packet, deadline: h.deadline });
  await until(() => h.states.at(-1)?.state === 'ready'); const running = h.adapter.run(); await until(() => h.calls.some(c => c[0] === 'prompt'));
  h.adapter.cancel('emergency-stop'); assert.equal(bridge.handleSettlement(h.cancels[0]), true);
  await running;
  assert.equal((await result).reasonCode, 'emergency-stop'); assert.equal(journal.recoveryState(), 'terminal-unreceipted');
  const persisted = JSON.parse(await readFile(h.projectRoot + '/runtime/chrome-review-pending.json', 'utf8'));
  assert.equal(persisted.reasonCode, 'emergency-stop'); assert.equal(persisted.receiptCommitted, false);
  assert.equal(bridge.handleSettlement({ type: 'review.chromeResult', ...h.binding, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' }), false);
});

test('cancellation reentered by destroy still destroys its session exactly once', async t => {
  let h;
  h = await harness(t, { destroy: () => h.adapter.cancel('emergency-stop') });
  await h.adapter.inspect(h.ready); await h.adapter.run();
  assert.equal(h.sessions[0].destroyCalls, 1);
  assert.equal(h.cancels.length, 1); assert.equal(h.results.length, 0);
});

test('cancellation during asynchronous destruction cannot publish a favorable result', async t => {
  const gate = defer(), h = await harness(t, { destroy: () => gate.promise });
  await h.adapter.inspect(h.ready); const work = h.adapter.run(); await until(() => h.sessions[0]?.destroyCalls === 1);
  h.adapter.cancel('emergency-stop'); await work;
  assert.equal(h.cancels.length, 1); assert.equal(h.results.length, 0);
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sessions[0].destroyCalls, 1); assert.equal(h.results.length, 0);
});

test('source digest is checked even if attacker recomputes packet, evidence and prompt hashes', async t => {
  const h = await harness(t), bad = structuredClone(h.ready);
  bad.packet.evidence.sourceDiff.changedFiles[0].afterText = 'export const value = 9;\n';
  bad.evidenceDigest = bad.packet.evidenceDigest = sha256Json(bad.packet.evidence);
  bad.promptDigest = bad.packet.promptDigest = sha256Bytes(buildChromeReviewPrompt({ evidence: bad.packet.evidence, evidenceDigest: bad.evidenceDigest }));
  bad.inputDigest = sha256Json(bad.packet);
  assert.equal(await h.adapter.inspect(bad), false); assert.deepEqual(h.calls, []);
});

test('ready timeout remains bounded while waiting for a click and rejects an overdue click before create', async t => {
  const h = await harness(t); await h.adapter.inspect(h.ready);
  assert.equal([...h.timers.values()][0].ms, 60000);
  h.advance(60000); assert.equal(await h.adapter.run(), false);
  assert.equal(h.results[0].reasonCode, 'timeout'); assert.equal(h.results[0].executionStatus, 'not-run');
  assert.equal(h.calls.some(call => call[0] === 'create'), false);
});

test('sent result remains cancelable until native finalization without a second destroy or result', async t => {
  const h = await harness(t); await h.adapter.inspect(h.ready); await h.adapter.run();
  assert.equal(h.results.length, 1); assert.equal(h.sessions[0].destroyCalls, 1);
  assert.equal(h.adapter.cancel('emergency-stop'), true);
  assert.equal(h.cancels.length, 1); assert.equal(h.cancels[0].reasonCode, 'emergency-stop');
  assert.equal(h.results.length, 1); assert.equal(h.sessions[0].destroyCalls, 1);
  assert.equal(h.adapter.cancel('emergency-stop'), false);
});

test('native finalization retires a sent result silently and prevents later cancellation or timer output', async t => {
  const h = await harness(t); await h.adapter.inspect(h.ready); await h.adapter.run();
  h.adapter.finalize(); h.adapter.destroy('panel-closure'); h.advance(600000);
  assert.equal(h.cancels.length, 0); assert.equal(h.results.length, 1); assert.equal(h.sessions[0].destroyCalls, 1);
});

for (const reason of ['provenance-drift', 'connection-loss', 'timeout']) test(`post-result ${reason} cannot send a second chromeResult`, async t => {
  const h = await harness(t); await h.adapter.inspect(h.ready); await h.adapter.run();
  h.adapter.cancel(reason);
  assert.equal(h.results.length, 1);
  assert.equal(h.cancels.length, reason === 'provenance-drift' ? 1 : 0);
  if (reason === 'provenance-drift') assert.equal(h.cancels[0].reasonCode, 'cancellation');
  assert.equal(h.sessions[0].destroyCalls, 1);
});
