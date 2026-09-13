import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_TURN_TEXT_BYTES, parseBrowserMessage } from '../native-host/sidecar-protocol.js';

test('preserves leading slash and Unicode in turn text', () => {
  const message = { type: 'turn.start', text: '/literal λ command' };

  assert.deepEqual(parseBrowserMessage(message), message);
});

test('accepts a nullable thread id when opening a session', () => {
  assert.deepEqual(parseBrowserMessage({ type: 'session.open', threadId: null }), {
    type: 'session.open',
    threadId: null,
  });
});

test('accepts a specific thread id when reopening a session', () => {
  assert.deepEqual(parseBrowserMessage({ type: 'session.open', threadId: 'thread-123' }), {
    type: 'session.open',
    threadId: 'thread-123',
  });
});

test('accepts the interrupt control without extra authority', () => {
  assert.deepEqual(parseBrowserMessage({ type: 'turn.interrupt' }), {
    type: 'turn.interrupt',
  });
});

test('rejects empty, oversized, and unknown messages', () => {
  assert.throws(
    () => parseBrowserMessage({ type: 'turn.start', text: '   ' }),
    /non-empty/i,
  );
  assert.throws(
    () => parseBrowserMessage({ type: 'turn.start', text: 'x'.repeat(MAX_TURN_TEXT_BYTES + 1) }),
    /too large/i,
  );
  assert.throws(() => parseBrowserMessage({ type: 'run.command' }), /unsupported/i);
});
