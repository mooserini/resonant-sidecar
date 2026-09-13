import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { NativeMessageDecoder, encodeNativeMessage } from '../native-host/native-framing.js';

const hostPath = fileURLToPath(new URL('../native-host/host.js', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url));

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
