import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedDecoder, FRAME_LIMIT, QUEUE_LIMIT } from '../bootstrap/native-proxy.js';

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

function boundedFrame(body) {
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

for (const [name, bytes] of [
  ['invalid leading byte', [0xff]], ['isolated continuation', [0x80]],
  ['invalid continuation', [0xc2, 0x41]], ['overlong sequence', [0xc0, 0xaf]],
  ['surrogate sequence', [0xed, 0xa0, 0x80]], ['out-of-range scalar', [0xf4, 0x90, 0x80, 0x80]],
  ['truncated two-byte sequence', [0xc2]], ['truncated three-byte sequence', [0xe2, 0x82]],
]) test(`trusted bounded decoder rejects ${name} before any repaired or following message is delivered`, () => {
  const body = Buffer.concat([Buffer.from('{"text":"'), Buffer.from(bytes), Buffer.from('"}')]);
  const decoded = []; const decoder = new BoundedDecoder(value => decoded.push(value));
  assert.throws(() => decoder.push(Buffer.concat([boundedFrame(body), encodeNativeMessage({ text: 'following' })])), /utf-8/i);
  assert.deepEqual(decoded, []);
});

test('trusted bounded decoder preserves valid split multibyte scalars and literal replacement characters', () => {
  const message = { text: 'hello λ 🦌 �' }; const frames = Buffer.concat([encodeNativeMessage(message), encodeNativeMessage({ sequence: 2 })]);
  const decoded = []; const decoder = new BoundedDecoder(value => decoded.push(value));
  for (const byte of frames) decoder.push(Buffer.from([byte]));
  assert.deepEqual(decoded, [message, { sequence: 2 }]);
});

test('trusted bounded decoder continues rejecting a JSON BOM rather than silently stripping it', () => {
  const decoded = []; const decoder = new BoundedDecoder(value => decoded.push(value));
  assert.throws(() => decoder.push(boundedFrame(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')]))), SyntaxError);
  assert.deepEqual(decoded, []);
});

test('trusted bounded decoder keeps zero-size, frame-size and buffered-byte limits', () => {
  for (const length of [0, FRAME_LIMIT + 1]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(length);
    assert.throws(() => new BoundedDecoder(() => assert.fail('Unexpected callback')).push(header), /Frame size exceeded/);
  }
  assert.throws(() => new BoundedDecoder(() => assert.fail('Unexpected callback')).push(Buffer.alloc(QUEUE_LIMIT + 1)), /Frame buffer exceeded/);
});
