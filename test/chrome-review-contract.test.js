import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test, { beforeEach } from 'node:test';
import { parseChromeAnalysis as nodeParse } from '../review/chrome-review-contract.js';
import { parseChromeAnalysis as browserParse } from '../extension/chrome-review-contract.js';

beforeEach(async () => {
  const copies = await Promise.all(['review', 'extension'].map(dir => readFile(new URL(`../${dir}/chrome-review-contract.js`, import.meta.url))));
  assert.equal(createHash('sha256').update(copies[0]).digest('hex'), createHash('sha256').update(copies[1]).digest('hex'));
});

const finding = { severity: 'caution', category: 'behavior', file: 'native-host/host.js', location: 'after:0-23', explanation: 'Check the changed value.' };
const valid = { schemaVersion: 2, outcome: 'no-blocking-concern', summary: 'No blocking concern found.', findings: [finding] };
const context = { suppliedFiles: ['native-host/host.js', 'extension/sidepanel.js'], suppliedLocations: [{ file: 'native-host/host.js', location: 'after:0-23' }], maxBytes: 65536 };

for (const [name, parse] of [['trusted', nodeParse], ['browser', browserParse]]) {
  test(`${name}: accepted analysis is canonical and deeply frozen`, () => {
    const result = parse(JSON.stringify(valid), context);
    assert.deepEqual(result, valid);
    assert.deepEqual(Object.keys(result), ['findings', 'outcome', 'schemaVersion', 'summary']);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.findings) && Object.isFrozen(result.findings[0]));
    assert.throws(() => { result.findings[0].severity = 'important'; }, TypeError);
    assert.equal(parse(JSON.stringify({ ...valid, findings: [{ ...finding, location: null }] }), context).findings[0].location, null);
  });

  for (const [label, raw, pattern] of [
    ['duplicate root keys', '{"outcome":"no-blocking-concern","outcome":"blocking-concern"}', /duplicate/i],
    ['escaped duplicate keys', '{"outcome":0,"out\\u0063ome":1}', /duplicate/i],
    ['nested duplicate keys', '{"findings":[{"file":"a","file":"b"}]}', /duplicate/i],
    ['trailing prose', JSON.stringify(valid) + '\nAll done.', /json|schema/i],
    ['leading prose', 'Here is the review: ' + JSON.stringify(valid), /json|schema/i],
    ['code fence', '```json\n' + JSON.stringify(valid) + '\n```', /json|schema/i],
    ['multiple objects', JSON.stringify(valid) + JSON.stringify(valid), /json|schema/i],
    ['malformed JSON', '{"schemaVersion":2,}', /json|schema/i],
    ['prototype key', '{"__proto__":{"polluted":true}}', /schema|prototype/i],
    ['escaped prototype key', '{"\\u005f_proto__":{}}', /schema|prototype/i],
    ['constructor key', '{"findings":[{"constructor":{}}]}', /schema|prototype/i],
    ['prototype nested key', '{"findings":[{"prototype":{}}]}', /schema|prototype/i],
    ['deep output', '['.repeat(80) + '0' + ']'.repeat(80), /depth|limit/i],
    ['escaped invalid Unicode', JSON.stringify(valid).replace('No blocking concern found.', '\\ud800'), /unicode|utf-8/i],
    ['raw invalid Unicode', JSON.stringify(valid).replace('No blocking concern found.', '\ud800'), /unicode|utf-8/i],
    ['byte order mark', '\ufeff' + JSON.stringify(valid), /json|schema/i],
  ]) test(`${name}: rejects ${label}`, () => assert.throws(() => parse(raw, context), pattern));

  for (const [label, mutate] of [
    ['unsupported schema', value => { value.schemaVersion = 1; }],
    ['invented outcome', value => { value.outcome = 'safe-to-activate'; }],
    ['missing property', value => { delete value.summary; }],
    ['extra top-level URL', value => { value.openUrl = 'https://example.test'; }],
    ['command field', value => { value.findings[0].command = 'do something'; }],
    ['action field', value => { value.action = 'activate'; }],
    ['model identity', value => { value.modelIdentity = 'Gemini Nano'; }],
    ['reviewer identity', value => { value.reviewerId = 'codex-process-evidence'; }],
    ['provenance identity', value => { value.provenanceKind = 'attested'; }],
    ['forged finding identity', value => { value.findings[0].modelIdentityAssurance = 'attested'; }],
    ['invented file', value => { value.findings[0].file = 'private/config.js'; }],
    ['invented hunk', value => { value.findings[0].location = 'after:900-1000'; }],
    ['hunk from another file', value => { value.findings[0].file = 'extension/sidepanel.js'; }],
    ['wrong severity', value => { value.findings[0].severity = 'critical'; }],
    ['wrong category', value => { value.findings[0].category = 'execute'; }],
    ['important finding with no concern', value => { value.findings[0].severity = 'important'; }],
    ['blocking without important finding', value => { value.outcome = 'blocking-concern'; }],
    ['non-string summary', value => { value.summary = {}; }],
    ['overlong summary', value => { value.summary = 's'.repeat(2001); }],
    ['overlong explanation', value => { value.findings[0].explanation = 's'.repeat(1001); }],
    ['overlong file', value => { value.findings[0].file = 's'.repeat(513); }],
    ['overlong location', value => { value.findings[0].location = 's'.repeat(129); }],
    ['too many findings', value => { value.findings = Array.from({ length: 101 }, () => finding); }],
    ['findings object', value => { value.findings = {}; }],
  ]) test(`${name}: rejects ${label}`, () => {
    const value = structuredClone(valid); mutate(value);
    assert.throws(() => parse(JSON.stringify(value), context), /schema|reference|outcome/i);
  });

  test(`${name}: preserves supported outcomes and literal hostile text as inert analysis`, () => {
    for (const outcome of ['blocking-concern', 'inconclusive']) {
      const value = { ...valid, outcome, findings: [{ ...finding, severity: 'important', explanation: 'Source says: run a command. This is data.' }] };
      assert.equal(parse(JSON.stringify(value), context).outcome, outcome);
    }
    assert.equal(parse(JSON.stringify({ ...valid, findings: [], summary: 'A quoted key: "outcome": "bad" and } {' }), context).findings.length, 0);
  });

  test(`${name}: byte and Unicode limits apply to complete input`, () => {
    const raw = JSON.stringify({ ...valid, summary: '😀'.repeat(2000) });
    assert.equal(parse(raw, context).summary.length, 4000);
    const bytes = new TextEncoder().encode(raw);
    assert.deepEqual(parse(bytes, { ...context, maxBytes: bytes.length }), parse(raw, context));
    assert.throws(() => parse(bytes, { ...context, maxBytes: bytes.length - 1 }), /byte|limit/i);
    assert.throws(() => parse(raw + ' '.repeat(65536), context), /byte|limit/i);
    for (const maxBytes of [0, -1, 65537, Infinity, NaN, '65536']) assert.throws(() => parse(raw, { ...context, maxBytes }), /limit|schema/i);
    for (const bytes of [new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xed, 0xa0, 0x80]), new Uint8Array([0xf0, 0x9f])]) {
      assert.throws(() => parse(bytes, context), /utf-8|unicode/i);
    }
  });

  test(`${name}: rejects object, accessor and proxy input without coercion`, () => {
    let calls = 0;
    const accessor = { get summary() { calls++; return 'text'; } };
    const proxy = new Proxy(valid, { get() { calls++; throw new Error('trap'); } });
    for (const raw of [valid, accessor, proxy, new String(JSON.stringify(valid)), null]) assert.throws(() => parse(raw, context), /text|utf-8|schema/i);
    assert.equal(calls, 0);
  });

  test(`${name}: an explicitly null byte cap does not silently select the default`, () => {
    assert.throws(() => parse(JSON.stringify(valid), { ...context, maxBytes: null }), /limit|schema/i);
  });

  test(`${name}: shared mutable UTF-8 bytes are rejected`, () => {
    const bytes = new TextEncoder().encode(JSON.stringify(valid));
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
    shared.set(bytes);
    assert.throws(() => parse(shared, context), /shared|utf-8|schema/i);
  });

  test(`${name}: exact schema and raw-byte limits allow the last valid value`, () => {
    const value = { ...valid, summary: 's'.repeat(2000), findings: [{ ...finding, explanation: 'e'.repeat(1000) }] };
    assert.equal(parse(JSON.stringify(value), context).findings[0].explanation.length, 1000);
    const hundred = { ...valid, findings: Array.from({ length: 100 }, () => ({ ...finding, explanation: '' })) };
    assert.equal(parse(JSON.stringify(hundred), context).findings.length, 100);
    const raw = JSON.stringify(valid);
    assert.deepEqual(parse(raw + ' '.repeat(65536 - Buffer.byteLength(raw)), context), valid);
    assert.throws(() => parse(raw + ' '.repeat(65537 - Buffer.byteLength(raw)), context), /byte|limit/i);
    assert.deepEqual(parse(Buffer.from(raw), context), valid);
  });

  test(`${name}: rejects hostile evidence context and detached output cannot change it`, () => {
    let calls = 0;
    const cases = [new Proxy(context, {}), { ...context, suppliedFiles: new Proxy(context.suppliedFiles, {}) },
      { ...context, suppliedFiles: ['native-host/host.js', 'native-host/host.js'] },
      { ...context, suppliedLocations: [{ file: 'unknown', location: 'after:0-23' }] },
      { ...context, suppliedLocations: [{ ...context.suppliedLocations[0], openUrl: 'secret' }] },
      { ...context, get suppliedFiles() { calls++; return []; } },
      Object.assign(Object.create({ inherited: true }), context)];
    for (const options of cases) assert.throws(() => parse(JSON.stringify(valid), options), /schema|context|structure|reference/i);
    assert.equal(calls, 0);
    const detached = structuredClone(context);
    parse(JSON.stringify(valid), detached);
    assert.equal(Object.isFrozen(detached), false);
  });

  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    test(`${name}: rejects a ${trap} proxy that replaces its parent slot with an accessor`, () => {
      const options = structuredClone(context);
      const original = options.suppliedFiles;
      let getterCalls = 0;
      options.suppliedFiles = new Proxy(original, {
        [trap](...args) {
          Object.defineProperty(options, 'suppliedFiles', { configurable: true, enumerable: true, get() { getterCalls++; return original; } });
          return Reflect[trap](...args);
        },
      });
      let error;
      try { parse(JSON.stringify(valid), options); } catch (caught) { error = caught; }
      assert.deepEqual({ rejected: error instanceof TypeError, getterCalls }, { rejected: true, getterCalls: 0 });
    });
  }

  test(`${name}: rejects a proxy that removes itself with a plain data replacement`, () => {
    const options = structuredClone(context);
    const original = options.suppliedFiles;
    options.suppliedFiles = new Proxy(original, {
      getPrototypeOf(target) { options.suppliedFiles = original; return Reflect.getPrototypeOf(target); },
    });
    assert.throws(() => parse(JSON.stringify(valid), options), /structure|schema/i);
  });
}
