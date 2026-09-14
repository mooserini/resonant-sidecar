import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Bytes, sha256Json } from '../review/canonical-json.js';

test('canonicalizes supported JSON values with recursively sorted object keys', () => {
  const value = {
    z: [true, null, 'line\nbreak'],
    a: { zebra: -0, apple: 1.5 },
  };

  assert.equal(
    canonicalJson(value),
    '{"a":{"apple":1.5,"zebra":0},"z":[true,null,"line\\nbreak"]}',
  );
});

test('hashes bytes and canonical JSON with stable SHA-256 literals', () => {
  assert.equal(
    sha256Bytes(Buffer.from('hello', 'utf8')),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  assert.equal(
    sha256Json({ b: 2, a: 1 }),
    '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
  );
});

test('rejects values outside the supported JSON subset', () => {
  assert.throws(() => canonicalJson({ missing: undefined }), /unsupported JSON value/i);
  assert.throws(() => canonicalJson([Number.NaN]), /finite number/i);
  assert.throws(() => canonicalJson(new Date()), /plain object/i);
});

test('rejects sparse arrays rather than colliding with shorter arrays', () => {
  assert.throws(() => canonicalJson(Array(1)), /sparse array/i);
  assert.throws(() => canonicalJson([1, , 3]), /sparse array/i);
});
