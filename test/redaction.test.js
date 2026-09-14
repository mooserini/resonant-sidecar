import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sanitizeEvidence } from '../review/redaction.js';

const policy = JSON.parse(await readFile(new URL('../policy/review-policy.v1.json', import.meta.url)));

test('returns a detached structured allowlisted value', () => {
  const input = { checks: [{ name: 'syntax', passed: true, exitCode: 0 }], argv: ['node', '--check', 'native-host/host.js'] };
  const result = sanitizeEvidence(input, policy);
  assert.deepEqual(result, input);
  result.checks[0].passed = false;
  assert.equal(input.checks[0].passed, true);
});

for (const value of [
  { env: { HOME: '/home/person' } }, { authorization: 'Basic abc' },
  { cookie: 'session=abc' }, { token: 'abc' }, { pageText: 'private page' },
  { conversation: 'private words' }, { stdout: 'raw diagnostics' },
  { summary: 'Bearer abcdef' }, { summary: 'postgres://alice:password@localhost/db' },
  { summary: 'sk-proj-12345678901234567890' }, { summary: 'ghp_123456789012345678901234567890123456' },
  { summary: 'AWS_SECRET_ACCESS_KEY=abc' }, { summary: 'Cookie: session=abc' },
  { path: '/Users/another/Documents/private.txt' }, { cwd: '~/private' },
  { argv: ['node', '--token', 'something'] }, { argv: ['node', '--check', 'untrusted.js'] },
  { unknown: 'cannot be retained' },
]) {
  test(`rejects prohibited evidence shape ${JSON.stringify(value).slice(0, 70)}`, () => {
    assert.throws(() => sanitizeEvidence(value, policy), error => {
      assert.equal(error.name, 'SanitizationError');
      assert.equal(error.message, 'Evidence rejected by sanitization policy');
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

test('rejects accessors without executing them and rejects cyclic/non-JSON evidence', () => {
  let invoked = false;
  const input = Object.defineProperty({}, 'summary', { enumerable: true, get() { invoked = true; return 'x'; } });
  assert.throws(() => sanitizeEvidence(input, policy), /sanitization/);
  assert.equal(invoked, false);
  const cyclic = {}; cyclic.checks = cyclic;
  for (const value of [cyclic, { checks: [undefined] }, { checks: new Date() }, { exitCode: Infinity }]) {
    assert.throws(() => sanitizeEvidence(value, policy), /sanitization/);
  }
});

test('rejects environment and secret names in nested named-value evidence records', () => {
  for (const name of ['AWS_SECRET_ACCESS_KEY', 'HOME', 'PATH', 'authorization', 'api-key', 'session_cookie', 'connectionString']) {
    assert.throws(() => sanitizeEvidence({ checks: [{ name, actual: 'SYNTHETIC-CUSTODY-PROBE' }] }, policy), /sanitization/i);
  }
});

test('check records validate contextual types instead of accepting generic nested values', () => {
  for (const check of [
    { name: 'syntax', actual: { summary: 'arbitrary nested payload' } },
    { name: 'syntax', passed: 'yes' },
    { name: 'syntax', exitCode: 'zero' },
    { name: 'syntax', version: 'unexpected field in check' },
  ]) assert.throws(() => sanitizeEvidence({ checks: [check] }, policy), /sanitization/i);
  assert.deepEqual(sanitizeEvidence({ checks: [{ name: 'syntax', actual: 0, expected: 0, passed: true }] }, policy), { checks: [{ name: 'syntax', actual: 0, expected: 0, passed: true }] });
});

test('every check array member must be a structured record', () => {
  for (const check of [null, true, 'syntax', ['syntax']]) assert.throws(() => sanitizeEvidence({ checks: [check] }, policy), /sanitization/i);
});
