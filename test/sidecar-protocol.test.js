import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_TURN_TEXT_BYTES, parseBrowserMessage } from '../native-host/sidecar-protocol.js';
import * as protocol from '../native-host/sidecar-protocol.js';

const binding = { reviewId: 'review-1', candidateDigest: 'a'.repeat(64) };
const decision = { ...binding, policyDigest: 'b'.repeat(64), nonce: 'n'.repeat(43) };

test('lifecycle commands preserve exact bounded bindings and exclude all extra authority', () => {
  const commands = [{ type: 'update.status' }, ...['review.start', 'review.openReport', 'review.openDesktop'].map(type => ({ type, ...binding })), ...['review.accept', 'review.reject'].map(type => ({ type, ...decision }))];
  for (const command of commands) {
    assert.deepEqual(parseBrowserMessage(command), command);
    for (const field of ['path', 'project', 'text', 'verdict', 'command', 'action', 'override', 'report']) assert.throws(() => parseBrowserMessage({ ...command, [field]: 'untrusted' }));
    for (const key of Object.keys(command)) { const missing = { ...command }; delete missing[key]; assert.throws(() => parseBrowserMessage(missing)); }
  }
  for (const patch of [{ reviewId: '../x' }, { reviewId: 'x'.repeat(65) }, { reviewId: 'review-1\n' }, { candidateDigest: 'a'.repeat(64) + '\n' }, { policyDigest: 'b'.repeat(64) + '\n' }, { nonce: 'n'.repeat(43) + '\n' }, { candidateDigest: 'A'.repeat(64) }, { policyDigest: 'b'.repeat(63) }, { nonce: 'n'.repeat(44) }, { nonce: '!'.repeat(43) }]) assert.throws(() => parseBrowserMessage({ type: 'review.accept', ...decision, ...patch }));
});

test('lifecycle snapshots refuse proxies, getters, symbols, nonenumerable and prototype fields', () => {
  const command = { type: 'review.accept', ...decision };
  let reads = 0;
  const getter = { ...command }; Object.defineProperty(getter, 'nonce', { enumerable: true, get() { reads++; return decision.nonce; } });
  const hidden = { ...command }; Object.defineProperty(hidden, 'hidden', { value: true });
  for (const value of [new Proxy(command, {}), getter, hidden, { ...command, [Symbol('extra')]: true }, Object.assign(Object.create({ inherited: true }), command)]) assert.throws(() => parseBrowserMessage(value));
  assert.equal(reads, 0);
  const parsed = parseBrowserMessage(command); command.nonce = 'z'.repeat(43); assert.equal(parsed.nonce, decision.nonce);
});

test('neither a type accessor nor an object-valued binding executes a getter', () => {
  let reads = 0;
  const type = { get type() { reads++; return 'review.accept'; }, ...decision };
  const nested = { type: 'review.accept', ...decision, nonce: { get secret() { reads++; return 'private'; } } };
  assert.throws(() => parseBrowserMessage(type)); assert.throws(() => parseBrowserMessage(nested)); assert.equal(reads, 0);
});

test('host lifecycle event parser closes states and excludes diagnostic text and paths', () => {
  assert.equal(typeof protocol.parseLifecycleEvent, 'function');
  const events = ['update.available', 'review.started', 'review.failed', 'activation.started', 'activation.completed', 'activation.rolledBack'].map(type => ({ type, ...binding }));
  events.push({ type: 'review.eligible', ...decision, rejectNonce: 'r'.repeat(43) });
  events.push({ type: 'review.failed', reviewId: null, candidateDigest: null });
  for (const event of events) {
    assert.deepEqual(protocol.parseLifecycleEvent(event), event);
    for (const key of ['message', 'reason', 'state', 'stack', 'path', 'report', 'project']) assert.throws(() => protocol.parseLifecycleEvent({ ...event, [key]: '<private>' }));
  }
  assert.throws(() => protocol.parseLifecycleEvent({ type: 'review.eligible', ...decision, rejectNonce: decision.nonce }));
  assert.throws(() => protocol.parseLifecycleEvent({ type: 'review.failed', reviewId: null, candidateDigest: binding.candidateDigest }));
});

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
