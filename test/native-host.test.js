import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runBootstrap, parseBootstrapMessage } from '../bootstrap/host.js';
import { QUEUE_LIMIT } from '../bootstrap/native-proxy.js';
import { createLifecycleRouter, parseLifecycleEvent } from '../native-host/sidecar-protocol.js';

import { NativeMessageDecoder, encodeNativeMessage } from '../native-host/native-framing.js';

const hostPath = fileURLToPath(new URL('../native-host/host.js', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url));

for (const mode of ['write-throw', 'overflow']) test(`legacy failure fallback ${mode} completes delayed reap and recovery under strict unhandled-rejection semantics`, async t => {
  const script = `
    import { runBootstrap } from ${JSON.stringify(new URL('../bootstrap/host.js', import.meta.url).href)};
    import { QUEUE_LIMIT } from ${JSON.stringify(new URL('../bootstrap/native-proxy.js', import.meta.url).href)};
    import { encodeNativeMessage } from ${JSON.stringify(new URL('../native-host/native-framing.js', import.meta.url).href)};
    import { PassThrough } from 'node:stream';
    import { EventEmitter } from 'node:events';
    const input = new PassThrough(), output = new PassThrough();
    const log = value => process.stdout.write(JSON.stringify(value) + '\\n');
    let ready, closes = 0, recoveries = 0;
    const started = new Promise(resolve => { ready = resolve; });
    const runtime = await runBootstrap({ input, output, signals: new EventEmitter(),
      store: { bindRuntimeGuard() {}, async recover() { recoveries++; log('recovered'); }, async resolveActiveHost() { return { digest: 'a'.repeat(64), reviewId: 'old' }; } },
      coordinator: { async handle() { throw new Error('PRIVATE coordinator detail'); } },
      proxyFactory: () => ({ pid: 123, send() { ready(); }, async close() { closes++; log('reap-start'); await new Promise(resolve => setTimeout(resolve, 40)); log('reap-finished'); } }),
    });
    input.write(encodeNativeMessage({ type: 'turn.start', text: 'healthy A' })); await started;
    if (${JSON.stringify(mode)} === 'overflow') Object.defineProperty(output, 'writableLength', { value: QUEUE_LIMIT });
    else output.write = () => { throw new Error('PRIVATE output detail'); };
    input.write(encodeNativeMessage({ type: 'review.start' }));
    await runtime.closed; await runtime.close();
    log({ closes, recoveries, inputListeners: input.listenerCount('data') });
  `;
  const child = spawn(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', script], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Legacy shutdown timed out')); }, 4000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(result.code, 0, `child failed before shutdown completed: ${stdout}\n${stderr}`);
  assert.equal(result.signal, null); assert.equal(stderr, '');
  assert.deepEqual(stdout.trim().split('\n').map(JSON.parse), ['recovered', 'reap-start', 'reap-finished', 'recovered', { closes: 1, recoveries: 2, inputListeners: 0 }]);
});

function createHost() {
  return spawn(process.execPath, [hostPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RESONANT_CODEX_COMMAND: process.execPath,
      RESONANT_CODEX_ARGS: JSON.stringify([fixturePath]),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function observeMessages(child) {
  const queued = [];
  const waiters = [];
  const decoder = new NativeMessageDecoder(message => {
    const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
    } else {
      queued.push(message);
    }
  });
  child.stdout.on('data', chunk => decoder.push(chunk));

  return predicate => {
    const queuedIndex = queued.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for native host message')), 2000);
      waiters.push({
        predicate,
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  };
}

function send(child, message) {
  child.stdin.write(encodeNativeMessage(message));
}

test('bridges a Chrome session and exact text turn to app-server', async t => {
  const child = createHost();
  t.after(() => child.kill('SIGTERM'));
  const next = observeMessages(child);

  send(child, { type: 'session.open', threadId: null });
  const session = await next(message => message.type === 'session.ready');
  send(child, { type: 'turn.start', text: '/literal from Chrome λ' });
  const delta = await next(message => message.type === 'assistant.delta');
  const completed = await next(message => message.type === 'turn.completed');

  assert.equal(session.threadId, 'thread-test');
  assert.equal(delta.text, 'echo:/literal from Chrome λ');
  assert.equal(completed.status, 'completed');
});

test('bridges the emergency interrupt to the active turn', async t => {
  const child = createHost();
  t.after(() => child.kill('SIGTERM'));
  const next = observeMessages(child);

  send(child, { type: 'session.open', threadId: null });
  await next(message => message.type === 'session.ready');
  send(child, { type: 'turn.start', text: '__hold__' });
  await next(message => message.type === 'turn.started');
  send(child, { type: 'turn.interrupt' });
  const completed = await next(message => message.type === 'turn.completed');

  assert.equal(completed.status, 'interrupted');
});

test('returns a safe error for unsupported browser messages', async t => {
  const child = createHost();
  t.after(() => child.kill('SIGTERM'));
  const next = observeMessages(child);

  send(child, { type: 'run.command', command: 'echo nope' });
  const error = await next(message => message.type === 'error');

  assert.match(error.message, /unsupported browser message type/i);
  assert.doesNotMatch(error.message, /echo nope/);
});

const lifecycleBinding = { reviewId: 'review-1', candidateDigest: 'a'.repeat(64) };
const humanDecision = { ...lifecycleBinding, policyDigest: 'b'.repeat(64), action: 'accept', nonce: 'n'.repeat(43) };
async function lifecycleHost(t, overrides = {}, presentationOverrides = {}) {
  const input = new PassThrough(), output = new PassThrough(), messages = [], conversation = [], calls = [];
  const effects = { closes: 0, recoveries: 0 };
  const decoder = new NativeMessageDecoder(m => messages.push(m)); output.on('data', b => decoder.push(b));
  const coordinator = {
    checkAvailability: async () => ({ state: 'available', ...lifecycleBinding }),
    startReview: async () => ({ state: 'eligible', ...lifecycleBinding, decision: humanDecision, rejection: { ...humanDecision, action: 'reject', nonce: 'r'.repeat(43) } }),
    acceptReview: async d => { calls.push(d); return { state: 'activated', ...lifecycleBinding }; },
    rejectReview: async d => { calls.push(d); return { state: 'rejected', ...lifecycleBinding }; }, ...overrides,
  };
  const runtime = await runBootstrap({ input, output, signals: new EventEmitter(), coordinator,
    receiptStore: { verifyChain: async () => ({ state: 'intact', receipts: [{ reviewId: 'review-1', candidateBundleDigest: 'a'.repeat(64), policySnapshotHash: 'b'.repeat(64), eventType: 'review-failed', directory: '/trusted/review-receipts/final' }] }) },
    presentation: { openReviewReport: async p => { calls.push(p); return { status: 'opened' }; }, openChromeDeveloperProject: async () => { calls.push('desktop'); return { status: 'opened', project: { id: 'metadata-only' } }; }, ...presentationOverrides },
    store: { recover: async () => { effects.recoveries++; }, bindRuntimeGuard() {}, resolveActiveHost: async () => ({ digest: 'c'.repeat(64), reviewId: 'old' }) },
    proxyFactory: () => ({ pid: 123, send: m => conversation.push(m), close: async () => { effects.closes++; } }),
  });
  t.after(() => runtime.close());
  const sendMessage = m => input.write(encodeNativeMessage(m));
  const settle = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('Lifecycle did not settle'); };
  return { messages, conversation, calls, sendMessage, settle, input, output, runtime, effects };
}

for (const event of ['update.available', 'review.started', 'review.eligible', 'review.failed', 'activation.started', 'activation.completed', 'activation.rolledBack']) {
  for (const mode of ['overflow', 'write-throw']) test(`${mode} while emitting ${event} closes the transport and reaps the runtime once`, async t => {
    let starts = 0;
    const h = await lifecycleHost(t, {
      startReview: async () => {
        starts++;
        if (event === 'review.failed') throw new Error('PRIVATE coordinator diagnostic');
        return { state: 'eligible', ...lifecycleBinding, decision: humanDecision, rejection: { ...humanDecision, action: 'reject', nonce: 'r'.repeat(43) } };
      },
      acceptReview: async () => ({ state: event === 'activation.rolledBack' ? 'rolled-back' : 'activated', ...lifecycleBinding }),
    });
    h.sendMessage({ type: 'turn.start', text: 'healthy A' }); await h.settle(() => h.conversation.length === 1);
    let attempted = false;
    if (mode === 'write-throw') {
      const write = h.output.write.bind(h.output);
      h.output.write = bytes => {
        const message = JSON.parse(bytes.subarray(4));
        if (message.type === event) { attempted = true; throw new Error('PRIVATE transport diagnostic'); }
        return write(bytes);
      };
    } else {
      let preceding = event === 'update.available' ? null : event === 'review.started' ? 'update.available' : ['review.eligible', 'review.failed'].includes(event) ? 'review.started' : event === 'activation.started' ? 'review.eligible' : 'activation.started';
      const overflow = () => { attempted = true; Object.defineProperty(h.output, 'writableLength', { configurable: true, value: QUEUE_LIMIT }); };
      if (!preceding) overflow();
      else h.output.on('data', bytes => { if (JSON.parse(bytes.subarray(4)).type === preceding) overflow(); });
    }
    h.sendMessage({ type: 'update.status' });
    if (event !== 'update.available') {
      await h.settle(() => h.messages.some(m => m.type === 'update.available'));
      h.sendMessage({ type: 'review.start', ...lifecycleBinding });
    }
    if (event.startsWith('activation.')) {
      await h.settle(() => h.messages.some(m => m.type === 'review.eligible'));
      const { action, ...decision } = humanDecision; h.sendMessage({ type: 'review.accept', ...decision });
    }
    await h.settle(() => attempted);
    await h.settle(() => h.effects.closes === 1);
    await h.runtime.closed;
    assert.equal(h.effects.recoveries, 2); assert.equal(h.input.listenerCount('data'), 0);
    assert.equal(h.messages.some(m => JSON.stringify(m).includes('PRIVATE')), false);
    if (['update.available', 'review.started'].includes(event)) assert.equal(starts, 0);
    await h.runtime.close(); assert.equal(h.effects.closes, 1);
  });
}

for (const source of ['coordinator', 'custody', 'presentation']) test(`${source} failure retains healthy A when the output transport works`, async t => {
  const error = new Error('PRIVATE diagnostic'); if (source === 'custody') error.name = 'CustodyError';
  const h = await lifecycleHost(t,
    { startReview: async () => { if (source !== 'presentation') throw error; return { state: 'review-failed', ...lifecycleBinding }; } },
    { openReviewReport: async () => { throw error; } });
  h.sendMessage({ type: 'turn.start', text: 'healthy A' }); await h.settle(() => h.conversation.length === 1);
  h.sendMessage({ type: 'update.status' }); await h.settle(() => h.messages.length === 1);
  h.sendMessage({ type: 'review.start', ...lifecycleBinding }); await h.settle(() => h.messages.some(m => m.type === 'review.failed'));
  if (source === 'presentation') { h.sendMessage({ type: 'review.openReport', ...lifecycleBinding }); await h.settle(() => h.messages.filter(m => m.type === 'review.failed').length === 2); }
  h.sendMessage({ type: 'turn.interrupt' }); await h.settle(() => h.conversation.length === 2);
  assert.equal(h.effects.closes, 0); assert.equal(h.effects.recoveries, 1); assert.equal(h.input.listenerCount('data'), 1);
  assert.deepEqual(h.messages.at(-1), { type: 'review.failed', ...lifecycleBinding });
});
test('all new lifecycle commands route exclusively through the trusted bootstrap', () => {
  for (const m of [{ type: 'update.status' }, { type: 'review.start', ...lifecycleBinding }, ...['review.accept', 'review.reject'].map(type => { const { action, ...d } = humanDecision; return { type, ...d }; }), ...['review.openReport', 'review.openDesktop'].map(type => ({ type, ...lifecycleBinding }))]) assert.equal(parseBootstrapMessage(m).channel, 'lifecycle');
});

test('legacy channel selection rejects accessor, proxy, hidden and prototype authority', () => {
  let reads = 0;
  const accessor = { get type() { reads++; return 'review.start'; } };
  const hidden = { type: 'review.start' }; Object.defineProperty(hidden, 'nonce', { value: 'hidden' });
  for (const value of [accessor, hidden, new Proxy({ type: 'review.start' }, {}), Object.assign(Object.create({ nonce: 'hidden' }), { type: 'review.start' })]) assert.throws(() => parseBootstrapMessage(value));
  assert.equal(reads, 0);
});

test('partial visible-lifecycle wiring fails startup before runtime recovery or launch', async () => {
  let effects = 0;
  await assert.rejects(runBootstrap({ store: { recover() { effects++; } }, coordinator: {}, presentation: {} }), /Trusted lifecycle dependencies/);
  assert.equal(effects, 0);
});

test('malformed legacy action and flooding cannot leak legacy state events into modern lifecycle', async t => {
  const h = await lifecycleHost(t);
  h.sendMessage({ type: 'review.start' });
  for (let i = 0; i < 12; i++) h.sendMessage({ type: 'update.status' });
  await h.settle(() => h.messages.some(m => m.type === 'update.available'));
  assert.equal(h.messages.length, 1); h.messages.forEach(parseLifecycleEvent);
});

test('native protocol errors do not expose parser diagnostic text to Chrome', async t => {
  const child = createHost(); t.after(() => child.kill('SIGTERM')); const next = observeMessages(child);
  send(child, { type: 'session.open', threadId: null }); await next(m => m.type === 'session.ready');
  send(child, { type: 'turn.start', text: '__malformed__' }); const message = await next(m => m.type === 'protocol.error');
  assert.deepEqual(message, { type: 'protocol.error', message: 'Native runtime unavailable' });
});
test('availability never starts review, long review never blocks conversation, and consent is exact and one-shot', async t => {
  let release, entered = false;
  const gate = new Promise(r => { release = r; });
  const h = await lifecycleHost(t, { startReview: async () => { entered = true; await gate; return { state: 'eligible', ...lifecycleBinding, decision: humanDecision, rejection: { ...humanDecision, action: 'reject', nonce: 'r'.repeat(43) } }; } });
  h.sendMessage({ type: 'update.status' }); await h.settle(() => h.messages.length === 1); assert.equal(entered, false); assert.equal(h.messages[0].type, 'update.available');
  h.sendMessage({ type: 'review.start', ...lifecycleBinding }); await h.settle(() => entered);
  h.sendMessage({ type: 'turn.start', text: '/during review λ' }); h.sendMessage({ type: 'turn.interrupt' }); await h.settle(() => h.conversation.length === 2);
  assert.deepEqual(h.conversation, [{ type: 'turn.start', text: '/during review λ' }, { type: 'turn.interrupt' }]);
  release(); await h.settle(() => h.messages.some(m => m.type === 'review.eligible'));
  const { action, ...decision } = humanDecision;
  h.sendMessage({ type: 'review.accept', ...decision }); h.sendMessage({ type: 'review.accept', ...decision });
  await h.settle(() => h.messages.some(m => m.type === 'activation.completed'));
  assert.deepEqual(h.calls, [humanDecision]); assert.equal(h.messages.some(m => JSON.stringify(m).includes('action')), false);
});
test('review failure contains only trusted navigation binding and report opening resolves retained custody', async t => {
  const h = await lifecycleHost(t, { startReview: async () => ({ state: 'review-failed', ...lifecycleBinding }) });
  h.sendMessage({ type: 'update.status' }); await h.settle(() => h.messages.length === 1);
  h.sendMessage({ type: 'review.start', ...lifecycleBinding }); await h.settle(() => h.messages.some(m => m.type === 'review.failed'));
  assert.deepEqual(h.messages.at(-1), { type: 'review.failed', ...lifecycleBinding });
  h.sendMessage({ type: 'review.openReport', ...lifecycleBinding }); await h.settle(() => h.calls.length === 1);
  assert.equal(h.calls[0], '/trusted/review-receipts/final/report.md');
  h.sendMessage({ type: 'review.openDesktop', ...lifecycleBinding }); await h.settle(() => h.calls.length === 2); assert.equal(h.calls[1], 'desktop');
  h.sendMessage({ type: 'review.openReport', ...lifecycleBinding, reviewId: 'other' }); await new Promise(r => setTimeout(r, 25)); assert.equal(h.calls.length, 2);
});

test('native conversation child rejects every lifecycle input without exposing injected diagnostic text', async t => {
  const child = createHost(); t.after(() => child.kill('SIGTERM')); const next = observeMessages(child);
  for (const type of ['update.status', 'review.start', 'review.accept', 'review.reject', 'review.openReport', 'review.openDesktop', 'PRIVATE-DIAGNOSTIC']) {
    send(child, { type }); const result = await next(m => m.type === 'error'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('trusted router snapshots decisions, refuses replay and rejects incomplete startup wiring', async () => {
  assert.throws(() => createLifecycleRouter({ coordinator: {} }));
  const messages = [], calls = [];
  const router = createLifecycleRouter({ send: m => messages.push(m), receiptStore: { verifyChain: async () => ({ state: 'intact', receipts: [] }) }, presentation: { openReviewReport() { assert.fail(); }, openChromeDeveloperProject() { assert.fail(); } }, coordinator: {
    checkAvailability: async () => ({ state: 'available', ...lifecycleBinding }),
    startReview: async () => ({ state: 'eligible', ...lifecycleBinding, decision: humanDecision, rejection: { ...humanDecision, action: 'reject', nonce: 'r'.repeat(43) } }),
    acceptReview: async d => { await Promise.resolve(); calls.push(d); return { state: 'rolled-back', ...lifecycleBinding }; },
    rejectReview: async () => assert.fail(),
  } });
  await router.handle({ type: 'update.status' });
  const { action, ...d } = humanDecision;
  await router.handle({ type: 'review.accept', ...d }); assert.equal(calls.length, 0);
  await router.handle({ type: 'review.start', ...lifecycleBinding });
  await router.handle({ type: 'review.accept', ...d, nonce: 'x'.repeat(43) }); assert.equal(calls.length, 0);
  const message = { type: 'review.accept', ...d }, pending = router.handle(message); message.nonce = 'x'.repeat(43);
  await pending; await router.handle({ type: 'review.accept', ...d }); assert.deepEqual(calls, [humanDecision]);
  assert.deepEqual(messages.at(-1), { type: 'activation.rolledBack', ...lifecycleBinding });
  router.close(); await router.handle({ type: 'update.status' }); assert.equal(messages.length, 5);
});

test('custody failure after report open produces no presentation success or private diagnostic event', async () => {
  let custody = 'intact', opened = 0; const messages = [];
  const router = createLifecycleRouter({ send: m => messages.push(m), receiptStore: { verifyChain: async () => ({ state: custody, receipts: [{ reviewId: lifecycleBinding.reviewId, candidateBundleDigest: lifecycleBinding.candidateDigest, eventType: 'review-failed', directory: '/trusted/review-receipts/final' }] }) }, presentation: { openReviewReport: async () => { opened++; custody = 'custody-broken'; throw new Error('PRIVATE STACK'); }, openChromeDeveloperProject: async () => { opened++; } }, coordinator: {
    checkAvailability: async () => ({ state: 'available', ...lifecycleBinding }), startReview: async () => ({ state: 'review-failed', ...lifecycleBinding }), acceptReview() { assert.fail(); }, rejectReview() { assert.fail(); },
  } });
  await router.handle({ type: 'update.status' }); await router.handle({ type: 'review.start', ...lifecycleBinding });
  await router.handle({ type: 'review.openReport', ...lifecycleBinding }); await router.handle({ type: 'review.openDesktop', ...lifecycleBinding });
  assert.equal(opened, 1); assert.deepEqual(messages.at(-1), { type: 'review.failed', ...lifecycleBinding }); assert.equal(JSON.stringify(messages).includes('PRIVATE'), false);
});
