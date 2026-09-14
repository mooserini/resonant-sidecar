import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { SidecarSession } from '../extension/sidepanel-controller.js';

class FakeEvent {
  listeners = [];

  addListener(listener) {
    this.listeners.push(listener);
  }

  emit(value) {
    for (const listener of this.listeners) listener(value);
  }
}

class FakePort {
  onDisconnect = new FakeEvent();
  onMessage = new FakeEvent();
  posted = [];

  postMessage(message) {
    this.posted.push(message);
  }

  disconnect() {
    this.onDisconnect.emit();
  }
}

function createStorage(threadId = null) {
  const values = threadId ? { codexThreadId: threadId } : {};
  return {
    values,
    async get(key) {
      return { [key]: values[key] };
    },
    async set(update) {
      Object.assign(values, update);
    },
  };
}

const reviewBinding = { reviewId: 'review-1', candidateDigest: 'a'.repeat(64) };
const eligible = { type: 'review.eligible', ...reviewBinding, policyDigest: 'b'.repeat(64), nonce: 'n'.repeat(43), rejectNonce: 'r'.repeat(43) };
async function panel() {
  const port = new FakePort(), storage = createStorage(), events = [];
  const session = new SidecarSession({ connectNative: () => port, storage, onEvent: e => events.push(e) });
  await session.connect(); return { session, port, storage, events };
}
test('availability requires an explicit review, blocks early acceptance and preserves emergency Stop', async () => {
  const { session, port } = await panel();
  session.requestUpdateStatus();
  port.onMessage.emit({ type: 'update.available', ...reviewBinding });
  assert.equal(port.posted.at(-1).type, 'update.status');
  assert.throws(() => session.acceptReview());
  session.startReview(); assert.deepEqual(port.posted.at(-1), { type: 'review.start', ...reviewBinding });
  assert.throws(() => session.startReview()); assert.throws(() => session.acceptReview());
  port.onMessage.emit({ type: 'review.started', ...reviewBinding });
  port.onMessage.emit({ type: 'turn.started', turnId: 'turn-1' });
  session.interrupt(); assert.deepEqual(port.posted.at(-1), { type: 'turn.interrupt' });
});
test('accept and reject consume separate exact grants locally before postMessage and never persist them', async () => {
  for (const action of ['accept', 'reject']) {
    const { session, port, storage } = await panel();
    session.requestUpdateStatus(); port.onMessage.emit({ type: 'update.available', ...reviewBinding }); session.startReview();
    port.onMessage.emit({ type: 'review.started', ...reviewBinding }); port.onMessage.emit(eligible);
    session[action + 'Review']();
    assert.deepEqual(port.posted.at(-1), { type: 'review.' + action, ...reviewBinding, policyDigest: eligible.policyDigest, nonce: action === 'accept' ? eligible.nonce : eligible.rejectNonce });
    assert.throws(() => session.acceptReview()); assert.throws(() => session.rejectReview());
    assert.deepEqual(storage.values, {});
  }
});
test('stale, duplicate, cross-review and malformed lifecycle events never unlock acceptance', async () => {
  const { session, port, events } = await panel();
  port.onMessage.emit(eligible); assert.throws(() => session.acceptReview());
  session.requestUpdateStatus(); port.onMessage.emit({ type: 'update.available', ...reviewBinding }); session.startReview();
  port.onMessage.emit(eligible); assert.throws(() => session.acceptReview());
  port.onMessage.emit({ type: 'review.started', ...reviewBinding });
  for (const bad of [{ ...eligible, reviewId: 'other' }, { ...eligible, reason: 'private' }, new Proxy(eligible, {}), { ...eligible, nonce: eligible.nonce + '\n' }]) port.onMessage.emit(bad);
  assert.throws(() => session.acceptReview());
  port.onMessage.emit(eligible); const count = events.length; port.onMessage.emit(eligible); assert.equal(events.length, count);
  session.acceptReview(); port.onMessage.emit({ type: 'activation.completed', ...reviewBinding });
  assert.notEqual(session.reviewState, 'completed');
  port.onMessage.emit({ type: 'activation.started', ...reviewBinding }); port.onMessage.emit({ type: 'activation.completed', ...reviewBinding });
  assert.equal(session.reviewState, 'completed'); port.onMessage.emit(eligible); assert.throws(() => session.acceptReview());
});
test('failure navigation uses current binding only and disconnect destroys approval state', async () => {
  const { session, port } = await panel();
  session.requestUpdateStatus(); port.onMessage.emit({ type: 'update.available', ...reviewBinding }); session.startReview();
  port.onMessage.emit({ type: 'review.started', ...reviewBinding }); port.onMessage.emit({ type: 'review.failed', ...reviewBinding });
  assert.equal(session.canNavigateReview, true);
  session.openReport(); assert.deepEqual(port.posted.at(-1), { type: 'review.openReport', ...reviewBinding });
  session.openDesktop(); assert.deepEqual(port.posted.at(-1), { type: 'review.openDesktop', ...reviewBinding });
  session.dismissReview(); assert.throws(() => session.openReport());
  port.disconnect(); assert.equal(session.reviewState, 'idle');
  port.onMessage.emit(eligible); assert.throws(() => session.acceptReview());
});

test('a status failure without a trusted review context cannot enable report or desktop navigation', async () => {
  const { session, port } = await panel(); session.requestUpdateStatus();
  port.onMessage.emit({ type: 'review.failed', reviewId: null, candidateDigest: null });
  assert.equal(session.reviewState, 'failed'); assert.equal(session.canNavigateReview, false);
  assert.throws(() => session.openReport()); assert.throws(() => session.openDesktop());
});

test('review card offers semantic controls, understandable disabled acceptance and visible focus without script injection', async () => {
  const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  assert.match(html, /<h2[^>]*id="review-title"/);
  assert.match(html, /id="accept-review"[^>]*disabled[^>]*aria-describedby="review-status"/);
  for (const label of ['Review and Refresh', 'Open review report', 'Continue in Codex', 'Dismiss']) assert.ok(html.includes(label));
  assert.equal((html.match(/aria-live="polite"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /tabindex="[1-9]|\sonclick=|<script(?![^>]*src=)[^>]*>/);
  assert.match(css, /:focus-visible/); assert.match(css, /flex-wrap:\s*wrap/);
});

test('rendered failure has only fixed navigation, keeps Stop live, and never renders diagnostic payloads', async () => {
  const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const elements = new Map();
  const document = { activeElement: null, querySelector: selector => elements.get(selector.slice(1)), getElementById: id => elements.get(id), createElement: () => element('') };
  function element(id) {
    return { id, textContent: '', value: '', disabled: false, hidden: false, dataset: {}, children: [], listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      click() { if (!this.disabled && !this.hidden) this.listeners.click?.(); },
      focus() { document.activeElement = this; },
      contains(other) { return this.id === 'review-card' && ['review-title', 'start-review', 'accept-review', 'reject-review', 'open-report', 'open-desktop', 'dismiss-review'].includes(other?.id); },
      append(...children) { this.children.push(...children); }, scrollIntoView() {},
    };
  }
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const node = element(match[1]); node.hidden = /\bhidden\b/.test(match[0]); node.disabled = /\bdisabled\b/.test(match[0]); elements.set(node.id, node);
  }
  const port = new FakePort(), storage = createStorage();
  await vm.runInNewContext(`(async () => { ${script.replace(/^import .*;\n/, '')} })()`, { SidecarSession, document, window: { addEventListener() {} }, chrome: { runtime: { connectNative: () => port }, storage: { session: storage } } });
  const node = id => elements.get(id);
  port.onMessage.emit({ type: 'update.available', ...reviewBinding });
  assert.equal(node('review-card').hidden, false); assert.equal(node('accept-review').disabled, true);
  node('accept-review').click(); assert.equal(port.posted.at(-1).type, 'update.status');
  node('start-review').focus(); node('start-review').click();
  assert.equal(document.activeElement.id, 'review-title');
  port.onMessage.emit({ type: 'review.started', ...reviewBinding });
  port.onMessage.emit({ type: 'turn.started', turnId: 'active' });
  port.onMessage.emit({ type: 'policy.violation', message: 'PRIVATE POLICY DETAIL' });
  assert.equal(node('error-message').hidden, true, 'a denied tool request uses polite status, not a critical alert');
  port.onMessage.emit({ type: 'error', message: 'PRIVATE OS STACK /secret' });
  assert.equal(node('stop-button').disabled, false, 'an unrelated error cannot remove emergency Stop from a live turn');
  port.onMessage.emit({ type: 'review.failed', ...reviewBinding, message: 'PRIVATE CANDIDATE' });
  assert.notEqual(node('review-title').textContent, 'Review failed');
  port.onMessage.emit({ type: 'review.failed', ...reviewBinding });
  assert.equal(node('review-title').textContent, 'Review failed'); assert.equal(node('review-status').hidden, true);
  assert.deepEqual(['start-review', 'accept-review', 'reject-review', 'open-report', 'open-desktop', 'dismiss-review'].filter(id => !node(id).hidden), ['open-report', 'open-desktop', 'dismiss-review']);
  assert.equal([...elements.values()].some(n => n.textContent.includes('PRIVATE')), false);
  node('stop-button').click(); assert.equal(port.posted.at(-1).type, 'turn.interrupt');
  node('dismiss-review').focus(); node('dismiss-review').click(); assert.equal(node('review-card').hidden, true); assert.equal(document.activeElement.id, 'stop-button');
  port.onMessage.emit({ type: 'session.ready', threadId: 'same-thread' });
  assert.equal(node('send-button').disabled, false, 'refreshed runtime readiness must release the old turn composer');
  assert.equal(node('stop-button').disabled, true);
});

test('runtime session readiness resets the prior turn after a refresh without starting a new turn', async () => {
  const { session, port } = await panel();
  port.onMessage.emit({ type: 'turn.started', turnId: 'old-turn' });
  port.onMessage.emit({ type: 'session.ready', threadId: 'same-thread' });
  assert.equal(session.turnActive, false); assert.throws(() => session.interrupt());
  assert.equal(port.posted.some(m => m.type === 'turn.start'), false);
});

test('reconnecting ignores the prior port and begins without eligibility or approval data', async () => {
  const oldPort = new FakePort(), newPort = new FakePort(); let calls = 0;
  const storage = createStorage(); const session = new SidecarSession({ connectNative: () => calls++ === 0 ? oldPort : newPort, storage });
  await Promise.all([session.connect(), session.connect()]); assert.equal(calls, 1);
  session.requestUpdateStatus(); oldPort.onMessage.emit({ type: 'update.available', ...reviewBinding }); session.startReview(); oldPort.onMessage.emit({ type: 'review.started', ...reviewBinding }); oldPort.onMessage.emit(eligible);
  session.disconnect(); await session.connect(); assert.equal(session.reviewState, 'idle');
  oldPort.onMessage.emit(eligible); oldPort.onDisconnect.emit(); assert.equal(session.port, newPort); assert.throws(() => session.acceptReview()); assert.deepEqual(storage.values, {});
});

test('manifest grants only native messaging, side panel, and session storage', async () => {
  const raw = await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(raw);

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ['nativeMessaging', 'sidePanel', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.action, {});
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
});

test('opens the stored Codex thread over the named native host', async () => {
  const port = new FakePort();
  const storage = createStorage('thread-existing');
  const session = new SidecarSession({
    connectNative: name => {
      assert.equal(name, 'com.resonantmirror.sidecar');
      return port;
    },
    storage,
  });

  await session.connect();

  assert.deepEqual(port.posted, [{ type: 'session.open', threadId: 'thread-existing' }]);
});

test('stores only the ready thread id and forwards exact turn text', async () => {
  const port = new FakePort();
  const storage = createStorage();
  const events = [];
  const session = new SidecarSession({
    connectNative: () => port,
    storage,
    onEvent: event => events.push(event),
  });
  await session.connect();
  port.onMessage.emit({ type: 'session.ready', threadId: 'thread-new' });
  await session.whenSettled();

  session.sendTurn('/literal λ text');

  assert.equal(storage.values.codexThreadId, 'thread-new');
  assert.deepEqual(Object.keys(storage.values), ['codexThreadId']);
  assert.deepEqual(port.posted.at(-1), { type: 'turn.start', text: '/literal λ text' });
  assert.ok(events.some(event => event.type === 'session.ready'));
});

test('exposes interrupt only while a turn is active', async () => {
  const port = new FakePort();
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage() });
  await session.connect();
  assert.throws(() => session.interrupt(), /no active turn/i);

  port.onMessage.emit({ type: 'turn.started', turnId: 'turn-1' });
  session.interrupt();
  port.onMessage.emit({ type: 'turn.completed', turnId: 'turn-1', status: 'interrupted' });

  assert.deepEqual(port.posted.at(-1), { type: 'turn.interrupt' });
  assert.equal(session.turnActive, false);
});
