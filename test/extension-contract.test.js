import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
