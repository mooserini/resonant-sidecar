import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { SidecarSession } from '../extension/sidepanel-controller.js';
import { bridgeFixture, NOW, RAW, observations, until, wireBinding } from './fixtures/chrome-bridge.js';
import { ChromeReviewBridge } from '../review/chrome-review-bridge.js';
import { ChromeReviewJournal } from '../bootstrap/chrome-review-journal.js';
import { buildChromeReviewRequest } from '../review/semantic-evidence.js';

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
  closed = false;
  disconnectCalls = 0;

  postMessage(message) {
    if (this.closed) throw new Error('Port is disconnected');
    this.posted.push(message);
  }

  disconnect() {
    this.disconnectCalls++;
    this.closed = true; // Chrome need not emit onDisconnect at this local end.
  }
}

function createStorage(threadId = null) {
  const values = threadId ? { 'threadId:grok': threadId } : {};
  return {
    values,
    async get(query) {
      if (Array.isArray(query)) return Object.fromEntries(query.map(key => [key, values[key]]));
      return { [query]: values[query] };
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
  port.onDisconnect.emit(); assert.equal(session.reviewState, 'idle');
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

async function renderedPanel({ languageModel } = {}) {
  const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const elements = new Map();
  const document = { activeElement: null, querySelector: selector => elements.get(selector.slice(1)), getElementById: id => elements.get(id), createElement: () => element('') };
  function element(id) {
    let disabled = false, hidden = false;
    return { id, textContent: '', value: '', dataset: {}, children: [], listeners: {},
      get disabled() { return disabled; },
      set disabled(value) { disabled = value; if (value && document.activeElement === this) document.activeElement = document.body; },
      get hidden() { return hidden; },
      set hidden(value) { hidden = value; if (value && (document.activeElement === this || this.contains(document.activeElement))) document.activeElement = document.body; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      click(isTrusted = true) { if (!this.disabled && !this.hidden) this.listeners.click?.({ isTrusted }); },
      focus() { if (!this.disabled && !this.hidden) document.activeElement = this; },
      contains(other) { return this.id === 'review-card' && ['review-title', 'start-review', 'accept-review', 'reject-review', 'open-report', 'open-desktop', 'dismiss-review', 'prepare-chrome-review', 'run-chrome-review', 'cancel-chrome-review'].includes(other?.id); },
      append(...children) { this.children.push(...children); }, scrollIntoView() {},
    };
  }
  document.body = element('body'); document.activeElement = document.body;
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const node = element(match[1]); node.hidden = /\bhidden\b/.test(match[0]); node.disabled = /\bdisabled\b/.test(match[0]); elements.set(node.id, node);
  }
  const port = new FakePort(), storage = createStorage(), windowEvents = {};
  await vm.runInNewContext(`(async () => { ${script.replace(/^import .*;\n/, '')} })()`, { SidecarSession, LanguageModel: languageModel, document, window: { addEventListener(name, listener) { windowEvents[name] = listener; } }, chrome: { runtime: { connectNative: () => port }, storage: { session: storage } } });
  const node = id => elements.get(id);
  return { node, document, port, elements, windowEvents };
}

for (const origin of ['remote', 'local']) test(`${origin} disconnect restores focus from a review control without retaining review authority`, async () => {
  const { node, document, port, windowEvents } = await renderedPanel();
  port.onMessage.emit({ type: 'update.available', ...reviewBinding }); node('start-review').click();
  port.onMessage.emit({ type: 'review.started', ...reviewBinding }); port.onMessage.emit(eligible);
  port.onMessage.emit({ type: 'turn.started', turnId: 'active' }); node('accept-review').focus();
  if (origin === 'remote') port.onDisconnect.emit(); else windowEvents.pagehide();
  assert.equal(document.activeElement, node('turn-text'));
  assert.equal(node('review-card').hidden, true); assert.equal(node('connection-status').textContent, 'Disconnected');
  assert.equal(node('stop-button').disabled, true);
  const count = port.posted.length;
  // Even a retained old DOM handler must not be able to submit an old grant.
  node('accept-review').listeners.click();
  port.onMessage.emit(eligible);
  assert.equal(port.posted.length, count); assert.equal(node('review-card').hidden, true);
});

test('rendered failure has only fixed navigation, keeps Stop live, and never renders diagnostic payloads', async () => {
  const { node, document, port, elements } = await renderedPanel();
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

for (const action of ['accept', 'reject', 'failure', 'dismiss']) test(`focus survives Chromium blur when ${action} hides or disables the focused control`, async () => {
  const { node, document, port } = await renderedPanel();
  port.onMessage.emit({ type: 'update.available', ...reviewBinding }); node('start-review').click();
  port.onMessage.emit({ type: 'review.started', ...reviewBinding }); port.onMessage.emit(eligible);
  if (action === 'accept') { node('accept-review').focus(); node('accept-review').click(); assert.equal(document.activeElement, node('review-title')); }
  if (action === 'reject') { node('reject-review').focus(); node('reject-review').click(); assert.equal(document.activeElement, node('turn-text')); }
  if (action === 'failure') { node('accept-review').focus(); port.onMessage.emit({ type: 'review.failed', ...reviewBinding }); assert.equal(document.activeElement, node('review-title')); }
  if (action === 'dismiss') { port.onMessage.emit({ type: 'review.failed', ...reviewBinding }); node('dismiss-review').focus(); node('dismiss-review').click(); assert.equal(document.activeElement, node('turn-text')); }
});

for (const origin of ['local', 'remote', 'reentrant-local']) test(`${origin} disconnect clears authority synchronously, once, and cannot poison reconnect`, async () => {
  const ports = [new FakePort(), new FakePort()]; let connections = 0, closed = 0;
  const session = new SidecarSession({ connectNative: () => ports[connections++], storage: createStorage(), onEvent: e => {
    if (e.type === 'connection.closed') { closed++; assert.equal(session.port, null); assert.equal(session.reviewState, 'idle'); assert.equal(session.turnActive, false); assert.throws(() => session.acceptReview()); if (origin === 'reentrant-local') session.disconnect(); }
  } });
  await session.connect(); session.requestUpdateStatus(); ports[0].onMessage.emit({ type: 'update.available', ...reviewBinding }); session.startReview(); ports[0].onMessage.emit({ type: 'review.started', ...reviewBinding }); ports[0].onMessage.emit(eligible); ports[0].onMessage.emit({ type: 'turn.started' });
  if (origin === 'remote') ports[0].onDisconnect.emit(); else session.disconnect();
  assert.equal(closed, 1); assert.equal(session.port, null); assert.equal(session.canNavigateReview, false);
  session.disconnect(); assert.equal(closed, 1);
  await session.connect(); assert.equal(connections, 2); assert.deepEqual(ports[1].posted, [{ type: 'session.open', threadId: null, agent: 'grok' }]);
  for (const message of [eligible, { type: 'session.ready', threadId: 'stale' }, { type: 'turn.started' }]) ports[0].onMessage.emit(message);
  ports[0].onDisconnect.emit(); assert.equal(session.port, ports[1]); assert.equal(session.turnActive, false); assert.equal(session.reviewState, 'idle'); assert.equal(closed, 1);
  assert.equal(ports[0].disconnectCalls, origin === 'remote' ? 0 : 1);
});

test('disconnect cancels an unresolved connection before native connection creation and permits a fresh attempt', async t => {
  let release, connections = 0, reads = 0, closed = 0;
  const gate = new Promise(r => { release = r; }); const port = new FakePort();
  t.after(() => release());
  const session = new SidecarSession({ connectNative: () => { connections++; return port; }, storage: { get: async () => { if (++reads === 1) await gate; return {}; } }, onEvent: e => { if (e.type === 'connection.closed') closed++; } });
  const first = session.connect(); session.disconnect(); assert.equal(closed, 1); await session.connect();
  assert.equal(connections, 1); release(); await first;
  assert.equal(connections, 1); assert.equal(closed, 1); assert.equal(session.port, port);
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

  assert.deepEqual(port.posted, [{ type: 'session.open', threadId: 'thread-existing', agent: 'grok' }]);
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

  assert.equal(storage.values['threadId:grok'], 'thread-new');
  assert.deepEqual(Object.keys(storage.values), ['threadId:grok']);
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

const CHROME_NOTICE = 'Local analysis uses a Chrome-managed on-device model that may already be stored or updated on this device.';
const PREPARE_NOTICE = 'Chrome may download and store an on-device model. Preparation does not run analysis.';
function fakeModel(availability = 'available', pending = false) {
  const calls = [], sessions = [];
  const languageModel = {
    async availability() { calls.push('availability'); return availability; },
    create(options) {
      calls.push('create');
      const session = { options, destroyed: 0,
        prompt() { calls.push('prompt'); return pending ? new Promise(() => {}) : Promise.resolve(RAW); },
        destroy() { this.destroyed++; },
      }; sessions.push(session); return Promise.resolve(session);
    },
  };
  return { calls, sessions, languageModel };
}
function startBoundReview(session, port, binding) {
  session.requestUpdateStatus(); port.onMessage.emit({ type: 'update.available', reviewId: binding.reviewId, candidateDigest: binding.candidateDigest }); session.startReview();
  port.onMessage.emit({ type: 'review.started', reviewId: binding.reviewId, candidateDigest: binding.candidateDigest });
}

test('install, startup, panel opening and update discovery make zero LanguageModel calls', async () => {
  const model = fakeModel(); const hooks = {}, opens = [];
  const worker = await readFile(new URL('../extension/service-worker.js', import.meta.url), 'utf8');
  vm.runInNewContext(worker, { LanguageModel: model.languageModel, chrome: { runtime: {
    onInstalled: { addListener: callback => { hooks.install = callback; } }, onStartup: { addListener: callback => { hooks.start = callback; } },
  }, sidePanel: { setPanelBehavior: options => opens.push(options) } } });
  await hooks.install(); await hooks.start(); const { port } = await renderedPanel(model);
  port.onMessage.emit({ type: 'update.available', ...reviewBinding });
  assert.deepEqual(model.calls, []); assert.equal(opens.length, 2); assert.equal(opens.every(options => options.openPanelOnActionClick === true), true);
});

for (const availability of ['available', 'downloadable', 'downloading']) test(`visible ${availability} controls require disclosures and real direct clicks`, async t => {
  const f = await bridgeFixture(t), model = fakeModel(availability), h = await renderedPanel(model);
  t.after(() => h.windowEvents.pagehide());
  const binding = { reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest };
  // Rebuild the ready deadline from current time, retaining a correctly bound packet.
  const request = buildChromeReviewRequest({ evidence: f.packet.evidence, evidenceDigest: f.packet.evidenceDigest, invocationId: f.binding.invocationId,
    runtimeGeneration: 3, adapterDigest: f.binding.adapterDigest, deadline: new Date(Date.now() + 60000).toISOString() });
  h.port.onMessage.emit({ type: 'update.available', ...binding }); h.node('start-review').click(); h.port.onMessage.emit({ type: 'review.started', ...binding });
  h.port.onMessage.emit({ type: 'review.chromeReady', ...wireBinding(request), packet: request.packet });
  await until(() => model.calls.includes('availability'));
  await until(() => h.node(availability === 'available' ? 'run-chrome-review' : 'prepare-chrome-review')?.disabled === false);
  assert.equal(h.node('chrome-review-notice').hidden, false); assert.equal(h.node('chrome-review-notice').textContent, CHROME_NOTICE);
  if (availability !== 'available') {
    assert.equal(h.node('chrome-preparation-notice').hidden, false); assert.equal(h.node('chrome-preparation-notice').textContent, PREPARE_NOTICE);
    h.node('prepare-chrome-review').click(false); assert.deepEqual(model.calls, ['availability']);
    h.node('chrome-preparation-notice').hidden = true; h.node('prepare-chrome-review').click(); assert.deepEqual(model.calls, ['availability']);
    h.node('chrome-preparation-notice').hidden = false; h.node('prepare-chrome-review').focus(); h.node('prepare-chrome-review').click();
    assert.equal(model.calls.at(-1), 'create'); await until(() => h.node('run-chrome-review').disabled === false);
    assert.equal(model.sessions[0].destroyed, 1); assert.equal(model.calls.includes('prompt'), false);
    assert.equal(h.document.activeElement.id, 'review-title');
  }
  h.node('run-chrome-review').click(false); assert.equal(model.calls.includes('prompt'), false);
  h.node('chrome-review-notice').hidden = true; h.node('run-chrome-review').click(); assert.equal(model.calls.includes('prompt'), false);
  h.node('chrome-review-notice').hidden = false; h.node('run-chrome-review').click(); assert.equal(model.calls.at(-1), 'create');
  await until(() => h.port.posted.some(message => message.type === 'review.chromeResult'));
  assert.equal(model.calls.filter(call => call === 'availability').length, 1); assert.equal(model.calls.filter(call => call === 'prompt').length, 1);
  assert.equal([...h.elements.values()].some(node => node.textContent.includes('No blocking concern.')), false);
  const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /id="chrome-preparation-notice"[^>]*>[^<]*<\/p>\s*<button id="prepare-chrome-review"/);
});

for (const invalidation of ['pagehide', 'native disconnect', 'runtime readiness', 'generation change', 'cross-channel', 'cross-restart']) test(`${invalidation} aborts review custody and cannot reuse its ready packet`, async t => {
  const f = await bridgeFixture(t), model = fakeModel('available', true), port = new FakePort();
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage(), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  t.after(() => session.disconnect()); await session.connect(); startBoundReview(session, port, f.binding);
  const ready = { type: 'review.chromeReady', ...f.binding, packet: f.packet }; port.onMessage.emit(ready);
  await until(() => session.chromeReviewState?.state === 'ready'); const work = session.runChromeReview(); await until(() => model.calls.includes('prompt'));
  if (invalidation === 'pagehide') session.disconnect();
  else if (invalidation === 'native disconnect') port.onDisconnect.emit();
  else if (invalidation === 'runtime readiness') port.onMessage.emit({ type: 'session.ready', threadId: 'same' });
  else port.onMessage.emit({ ...ready, [invalidation === 'generation change' ? 'runtimeGeneration' : invalidation === 'cross-channel' ? 'channelId' : 'restartId']: invalidation === 'generation change' ? 4 : '33333333-3333-4333-8333-333333333333' });
  await work; assert.equal(model.sessions[0].options.signal.aborted, true); assert.equal(model.sessions[0].destroyed, 1);
  port.onMessage.emit(ready); assert.equal(await session.runChromeReview(), false); assert.equal(model.calls.filter(call => call === 'availability').length, 1);
});

test('unsolicited and cross-review ready cannot create controls or call the model', async t => {
  const f = await bridgeFixture(t), model = fakeModel(), port = new FakePort();
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage(), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  t.after(() => session.disconnect()); await session.connect();
  const ready = { type: 'review.chromeReady', ...f.binding, packet: f.packet };
  port.onMessage.emit(ready); startBoundReview(session, port, f.binding); port.onMessage.emit({ ...ready, reviewId: 'other' });
  assert.deepEqual(model.calls, []); assert.equal(await session.runChromeReview(), false);
});

test('emergency Stop synchronously cancels through exact Port to durable journal then interrupts the conversation', async t => {
  const f = await bridgeFixture(t), model = fakeModel('available', true), port = new FakePort(), events = [];
  const journal = new ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: f.binding.restartId }); await journal.recover();
  const bridge = new ChromeReviewBridge({ journal, send: message => port.onMessage.emit(message), currentChannel: () => f.current, clock: () => NOW, ...observations });
  t.after(() => bridge.close('connection-loss'));
  const nativePost = port.postMessage.bind(port);
  port.postMessage = message => { nativePost(message); if (message.type === 'review.chromeCancel') { assert.equal(model.sessions[0].options.signal.aborted, true); assert.equal(bridge.handleSettlement(message), true); } };
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage(), onEvent: event => events.push(event), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  t.after(() => session.disconnect()); await session.connect(); startBoundReview(session, port, f.binding);
  const result = bridge.request({ binding: f.binding, packet: f.packet, deadline: f.deadline });
  await until(() => session.chromeReviewState?.state === 'ready'); const work = session.runChromeReview(); await until(() => model.calls.includes('prompt'));
  port.onMessage.emit({ type: 'turn.started' }); const before = port.posted.length;
  session.emergencyStop();
  assert.deepEqual(port.posted.slice(before).map(message => message.type), ['review.chromeCancel', 'turn.interrupt']);
  assert.equal(port.posted[before].reasonCode, 'emergency-stop'); assert.equal(events.at(-1).type, 'emergency.stopped');
  await work; assert.equal((await result).reasonCode, 'emergency-stop'); assert.equal(journal.recoveryState(), 'terminal-unreceipted');
  assert.equal(journal.snapshot().receiptCommitted, false, 'permanent coordinator reconciliation is Task 8, never fabricated by the panel');
  assert.equal(model.sessions[0].destroyed, 1);
});

test('review production surface has no added browser, transport or alternate-model capability', async () => {
  for (const file of ['chrome-review-adapter.js', 'sidepanel-controller.js', 'sidepanel.js', 'service-worker.js']) {
    const source = await readFile(new URL('../extension/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|localhost|9931|llama|gpt-oss|Eloquent|Gemma|https?:\/\/|\b(?:WebSocket|XMLHttpRequest|EventSource)\b|chrome\.(?:tabs|cookies|history|debugger|scripting)\b/);
  }
});

for (const phase of ['pending', 'cancelled']) test(`native eligibility cannot overtake a ${phase} Chrome invocation`, async t => {
  const f = await bridgeFixture(t), model = fakeModel(), port = new FakePort();
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage(), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  t.after(() => session.disconnect()); await session.connect(); startBoundReview(session, port, f.binding);
  port.onMessage.emit({ type: 'review.chromeReady', ...f.binding, packet: f.packet }); await until(() => session.chromeReviewState?.state === 'ready');
  if (phase === 'cancelled') session.cancelChromeReview();
  port.onMessage.emit({ ...eligible, reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest, policyDigest: f.binding.policyDigest });
  assert.throws(() => session.acceptReview()); assert.throws(() => session.rejectReview());
});

test('reconnected Port rejects a retained old ready callback and late model completion', async t => {
  const f = await bridgeFixture(t), oldPort = new FakePort(), freshPort = new FakePort(); let resolveModel, connections = 0;
  const model = fakeModel(); model.languageModel.create = options => Promise.resolve({
    prompt() { model.calls.push('prompt'); return new Promise(resolve => { resolveModel = resolve; }); }, destroy() {},
  });
  const session = new SidecarSession({ connectNative: () => ++connections === 1 ? oldPort : freshPort, storage: createStorage(), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  t.after(() => session.disconnect()); await session.connect(); startBoundReview(session, oldPort, f.binding);
  const ready = { type: 'review.chromeReady', ...f.binding, packet: f.packet };
  oldPort.onMessage.emit(ready); await until(() => session.chromeReviewState?.state === 'ready'); const work = session.runChromeReview(); await until(() => model.calls.includes('prompt'));
  session.disconnect(); await work; await session.connect(); oldPort.onMessage.emit(ready); resolveModel(RAW);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(freshPort.posted, [{ type: 'session.open', threadId: null, agent: 'grok' }]); assert.equal(model.calls.filter(call => call === 'availability').length, 1);
  assert.equal(await session.runChromeReview(), false);
});

test('emergency Stop still interrupts when bound cancel cannot be delivered', async t => {
  const f = await bridgeFixture(t), model = fakeModel('available', true), port = new FakePort();
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage(), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  t.after(() => session.disconnect()); await session.connect(); startBoundReview(session, port, f.binding);
  port.onMessage.emit({ type: 'review.chromeReady', ...f.binding, packet: f.packet }); await until(() => session.chromeReviewState?.state === 'ready');
  const work = session.runChromeReview(); await until(() => model.calls.includes('prompt')); port.onMessage.emit({ type: 'turn.started' });
  const original = port.postMessage.bind(port); port.postMessage = message => { if (message.type === 'review.chromeCancel') throw new Error('closed'); original(message); };
  session.emergencyStop(); assert.equal(port.posted.at(-1).type, 'turn.interrupt'); assert.equal(model.sessions[0].options.signal.aborted, true); await work;
});

test('completed Chrome review accepts only a current matching policy grant', async t => {
  const f = await bridgeFixture(t), model = fakeModel(), port = new FakePort();
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage(), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  t.after(() => session.disconnect()); await session.connect(); startBoundReview(session, port, f.binding);
  port.onMessage.emit({ type: 'review.chromeReady', ...f.binding, packet: f.packet }); await until(() => session.chromeReviewState?.state === 'ready');
  await session.runChromeReview();
  port.onMessage.emit({ ...eligible, reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest });
  assert.throws(() => session.acceptReview());
  port.onMessage.emit({ ...eligible, reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest, policyDigest: f.binding.policyDigest });
  session.acceptReview(); assert.equal(port.posted.at(-1).type, 'review.accept');
});

for (const action of ['Stop', 'Cancel analysis', 'pagehide']) test(`rendered ${action} aborts the active model and preserves the conversation/evidence boundary`, async t => {
  const f = await bridgeFixture(t), model = fakeModel('available', true), h = await renderedPanel(model);
  t.after(() => h.windowEvents.pagehide());
  const request = buildChromeReviewRequest({ evidence: f.packet.evidence, evidenceDigest: f.packet.evidenceDigest, invocationId: f.binding.invocationId,
    runtimeGeneration: 3, adapterDigest: f.binding.adapterDigest, deadline: new Date(Date.now() + 60000).toISOString() });
  const binding = { reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest };
  h.port.onMessage.emit({ type: 'update.available', ...binding }); h.node('start-review').click(); h.port.onMessage.emit({ type: 'review.started', ...binding });
  h.port.onMessage.emit({ type: 'review.chromeReady', ...wireBinding(request), packet: request.packet });
  await until(() => h.node('run-chrome-review')?.disabled === false);
  assert.equal(h.node('stop-button').disabled, false, 'review Stop is available even without a conversation turn');
  h.node('run-chrome-review').click(); await until(() => model.calls.includes('prompt'));
  h.port.onMessage.emit({ type: 'turn.started' }); h.port.onMessage.emit({ type: 'assistant.delta', text: 'Prior conversation evidence' });
  const transcriptCount = h.node('transcript').children.length, before = h.port.posted.length;
  if (action === 'pagehide') h.windowEvents.pagehide();
  else h.node(action === 'Stop' ? 'stop-button' : 'cancel-chrome-review').click();
  const messages = h.port.posted.slice(before);
  assert.equal(messages[0].type, 'review.chromeCancel');
  assert.equal(messages[0].reasonCode, action === 'Stop' ? 'emergency-stop' : action === 'pagehide' ? 'panel-closure' : 'cancellation');
  assert.equal(model.sessions[0].options.signal.aborted, true); assert.equal(model.sessions[0].destroyed, 1);
  assert.equal(messages.some(message => message.type === 'turn.interrupt'), action === 'Stop');
  assert.equal(h.node('transcript').children.length, transcriptCount);
  if (action === 'Stop') assert.equal(h.node('connection-status').textContent, 'Stopped');
  if (action === 'Cancel analysis') { assert.equal(h.node('stop-button').disabled, false); assert.equal(h.port.closed, false); }
});

for (const invalidation of ['emergency Stop', 'session.ready']) for (const action of ['accept', 'reject']) test(`${action} after finalized eligibility and ${invalidation} cannot reuse a decision`, async t => {
  const f = await bridgeFixture(t), model = fakeModel(), port = new FakePort();
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage(), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  t.after(() => session.disconnect()); await session.connect(); startBoundReview(session, port, f.binding);
  port.onMessage.emit({ type: 'review.chromeReady', ...f.binding, packet: f.packet }); await until(() => session.chromeReviewState?.state === 'ready');
  await session.runChromeReview();
  const grant = { ...eligible, reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest, policyDigest: f.binding.policyDigest };
  port.onMessage.emit(grant); assert.equal(session.reviewState, 'eligible'); const before = port.posted.length;
  if (invalidation === 'emergency Stop') session.emergencyStop(); else port.onMessage.emit({ type: 'session.ready', threadId: 'same' });
  assert.notEqual(session.reviewState, 'eligible'); assert.throws(() => session[action + 'Review']());
  port.onMessage.emit(grant); assert.throws(() => session.acceptReview()); assert.throws(() => session.rejectReview());
  assert.equal(port.posted.length, before, 'finalized native work must not receive redundant cancellation');
});

for (const action of ['accept', 'reject']) test(`${action} rechecks actual Port after a finalized Chrome grant`, async t => {
  const f = await bridgeFixture(t), model = fakeModel(), port = new FakePort(), replacement = new FakePort();
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage(), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  t.after(() => session.disconnect()); await session.connect(); startBoundReview(session, port, f.binding);
  port.onMessage.emit({ type: 'review.chromeReady', ...f.binding, packet: f.packet }); await until(() => session.chromeReviewState?.state === 'ready'); await session.runChromeReview();
  port.onMessage.emit({ ...eligible, reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest, policyDigest: f.binding.policyDigest });
  session.port = replacement;
  assert.throws(() => session[action + 'Review']()); assert.deepEqual(replacement.posted, []);
});

for (const invalidation of ['Stop', 'session.ready']) test(`rendered result-sent stays cancelable and ${invalidation} retires finalized decision buttons`, async t => {
  const f = await bridgeFixture(t), model = fakeModel(), h = await renderedPanel(model);
  t.after(() => h.windowEvents.pagehide());
  const request = buildChromeReviewRequest({ evidence: f.packet.evidence, evidenceDigest: f.packet.evidenceDigest, invocationId: f.binding.invocationId,
    runtimeGeneration: 3, adapterDigest: f.binding.adapterDigest, deadline: new Date(Date.now() + 60000).toISOString() });
  const binding = { reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest };
  h.port.onMessage.emit({ type: 'update.available', ...binding }); h.node('start-review').click(); h.port.onMessage.emit({ type: 'review.started', ...binding });
  h.port.onMessage.emit({ type: 'review.chromeReady', ...wireBinding(request), packet: request.packet }); await until(() => h.node('run-chrome-review')?.disabled === false);
  h.node('run-chrome-review').click(); await until(() => h.port.posted.some(message => message.type === 'review.chromeResult'));
  assert.equal(h.node('cancel-chrome-review').hidden, false); assert.equal(h.node('cancel-chrome-review').disabled, false); assert.equal(h.node('stop-button').disabled, false);
  assert.equal(h.node('run-chrome-review').hidden, true);
  h.port.onMessage.emit({ ...eligible, ...binding, policyDigest: f.binding.policyDigest });
  assert.equal(h.node('accept-review').disabled, false); assert.equal(h.node('reject-review').hidden, false);
  assert.equal(h.node('cancel-chrome-review').hidden, true); assert.equal(h.node('stop-button').disabled, true);
  h.port.onMessage.emit({ type: 'turn.started' });
  if (invalidation === 'Stop') h.node('stop-button').click(); else h.port.onMessage.emit({ type: 'session.ready', threadId: 'same' });
  assert.equal(h.node('accept-review').hidden || h.node('accept-review').disabled, true);
  assert.equal(h.node('reject-review').hidden || h.node('reject-review').disabled, true);
  const before = h.port.posted.length; h.node('accept-review').listeners.click(); h.node('reject-review').listeners.click();
  assert.equal(h.port.posted.length, before); assert.equal(h.port.posted.some(message => message.type === 'review.chromeCancel'), false);
});

for (const invalidation of ['emergency Stop', 'pagehide', 'disconnect']) test(`delayed real journal result loses to ${invalidation} before native finalization`, async t => {
  const f = await bridgeFixture(t), model = fakeModel(), port = new FakePort();
  const journal = new ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: f.binding.restartId }); await journal.recover();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const originalFinish = journal.finish.bind(journal);
  journal.finish = async (binding, reason) => { if (reason === 'completed') { entered(); await gate; } return originalFinish(binding, reason); };
  const bridge = new ChromeReviewBridge({ journal, send: message => port.onMessage.emit(message), currentChannel: () => f.current, clock: () => NOW, ...observations });
  const post = port.postMessage.bind(port), settlements = [];
  port.postMessage = message => { post(message); if (['review.chromeResult', 'review.chromeCancel'].includes(message.type)) settlements.push(bridge.handleSettlement(message)); };
  const session = new SidecarSession({ connectNative: () => port, storage: createStorage(), languageModel: model.languageModel, chromeReviewOptions: { clock: () => NOW } });
  let result, closed;
  try {
    await session.connect(); startBoundReview(session, port, f.binding);
    result = bridge.request({ binding: f.binding, packet: f.packet, deadline: f.deadline });
    await until(() => session.chromeReviewState?.state === 'ready'); await session.runChromeReview(); await started;
    assert.equal(journal.recoveryState(), 'pending'); const before = port.posted.length;
    if (invalidation === 'emergency Stop') session.emergencyStop();
    else if (invalidation === 'pagehide') session.disconnect();
    else { port.closed = true; port.onDisconnect.emit(); closed = bridge.close('connection-loss'); }
    if (invalidation !== 'disconnect') {
      assert.equal(port.posted.length, before + 1); assert.equal(port.posted.at(-1).type, 'review.chromeCancel');
      assert.equal(port.posted.at(-1).reasonCode, invalidation === 'emergency Stop' ? 'emergency-stop' : 'panel-closure');
      assert.deepEqual(settlements, [true, true]);
    }
    release();
    assert.equal((await result).reasonCode, invalidation === 'emergency Stop' ? 'emergency-stop' : invalidation === 'pagehide' ? 'panel-closure' : 'connection-loss');
    await closed;
    assert.equal(journal.recoveryState(), 'terminal-unreceipted'); assert.equal(journal.snapshot().receiptCommitted, false);
    assert.equal(model.sessions[0].destroyed, 1); assert.equal(port.posted.filter(message => message.type === 'review.chromeResult').length, 1);
    port.onMessage.emit({ ...eligible, reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest, policyDigest: f.binding.policyDigest });
    assert.throws(() => session.acceptReview()); assert.throws(() => session.rejectReview());
  } finally {
    release(); await bridge.close('connection-loss'); await result; await closed; session.disconnect();
  }
});
