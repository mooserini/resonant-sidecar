import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_INBOUND_BYTES,
  NativeMessageDecoder,
  encodeNativeMessage,
} from '../native-host/native-framing.js';

test('decodes a split UTF-8 Chrome frame', () => {
  const frame = encodeNativeMessage({ text: 'hello λ' });
  const decoded = [];
  const decoder = new NativeMessageDecoder(value => decoded.push(value));

  decoder.push(frame.subarray(0, 5));
  decoder.push(frame.subarray(5));

  assert.deepEqual(decoded, [{ text: 'hello λ' }]);
});

test('decodes consecutive frames delivered in one chunk', () => {
  const decoded = [];
  const decoder = new NativeMessageDecoder(value => decoded.push(value));
  const frames = Buffer.concat([
    encodeNativeMessage({ sequence: 1 }),
    encodeNativeMessage({ sequence: 2 }),
  ]);

  decoder.push(frames);

  assert.deepEqual(decoded, [{ sequence: 1 }, { sequence: 2 }]);
});

test('rejects an inbound frame larger than Chrome permits', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_INBOUND_BYTES + 1, 0);
  const decoder = new NativeMessageDecoder(() => {});

  assert.throws(() => decoder.push(header), /exceeds.*limit/i);
});

test('rejects malformed JSON without emitting a value', () => {
  const body = Buffer.from('{bad json', 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  const decoded = [];
  const decoder = new NativeMessageDecoder(value => decoded.push(value));

  assert.throws(() => decoder.push(Buffer.concat([header, body])), /invalid JSON/i);
  assert.deepEqual(decoded, []);
});
