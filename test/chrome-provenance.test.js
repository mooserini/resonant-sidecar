import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test, { beforeEach } from 'node:test';
import { buildChromeProvenance } from '../review/chrome-provenance.js';

beforeEach(async () => {
  const copies = await Promise.all(['review', 'extension'].map(dir => readFile(new URL(`../${dir}/chrome-review-contract.js`, import.meta.url))));
  assert.equal(createHash('sha256').update(copies[0]).digest('hex'), createHash('sha256').update(copies[1]).digest('hex'));
});

const browserObservation = { executableSha256: 'a'.repeat(64), version: '155.0.8048.0', signingIdentity: 'Developer ID Application: Google LLC (EQHXZ8M8AV)', observedAt: '2026-09-14T12:00:00.000Z', unavailableFields: [] };
const componentObservation = { status: 'observed', metadataSource: 'chrome-component-metadata', version: '2026.9.14.1', artifactSha256: 'b'.repeat(64), observedAt: '2026-09-14T12:00:00.000Z' };

test('observations remain observations without a model identity or fake PID', () => {
  const browser = structuredClone(browserObservation);
  const component = structuredClone(componentObservation);
  const result = buildChromeProvenance({ browserObservation: browser, componentObservation: component });
  assert.deepEqual(result, { reviewerId: 'chrome-language-model', provenanceKind: 'observed-local-components', modelIdentityAssurance: 'not-attested', inferenceBinding: 'not-established', browserObservation, componentObservation });
  browser.version = '999.0'; component.version = '999.0';
  assert.equal(result.browserObservation.version, '155.0.8048.0');
  assert.equal(result.componentObservation.version, '2026.9.14.1');
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.browserObservation.unavailableFields));
  assert.ok(Object.isFrozen(result.componentObservation));
  assert.equal(Object.hasOwn(result, 'pid'), false);
});

test('unavailable browser and component metadata stays explicitly unavailable', () => {
  const browser = { executableSha256: null, version: null, signingIdentity: null, observedAt: '2026-09-14T12:00:00.000Z', unavailableFields: ['executableSha256', 'version', 'signingIdentity'] };
  for (const status of ['not-exposed', 'not-collected']) {
    const component = { status, metadataSource: status === 'not-exposed' ? 'chrome-language-model-api' : null, version: null, artifactSha256: null, observedAt: status === 'not-exposed' ? '2026-09-14T12:00:00.000Z' : null };
    assert.equal(buildChromeProvenance({ browserObservation: browser, componentObservation: component }).componentObservation.status, status);
  }
});

for (const [label, mutate] of [
  ['model identity injection', input => { input.modelIdentityAssurance = 'attested'; }],
  ['fake PID', input => { input.browserObservation.pid = 123; }],
  ['profile path', input => { input.browserObservation.profilePath = '/Users/private'; }],
  ['raw prompt', input => { input.componentObservation.prompt = 'secret'; }],
  ['raw exception', input => { input.componentObservation.exception = 'secret'; }],
  ['invalid digest', input => { input.browserObservation.executableSha256 = 'abc'; }],
  ['invalid time', input => { input.browserObservation.observedAt = 'yesterday'; }],
  ['version URL', input => { input.browserObservation.version = 'https://secret.test'; }],
  ['signing path', input => { input.browserObservation.signingIdentity = '/Users/secret'; }],
  ['unknown metadata source', input => { input.componentObservation.metadataSource = '/Users/secret'; }],
  ['unmeasured component identity', input => { input.componentObservation.status = 'not-exposed'; }],
  ['missing unavailable marker', input => { input.browserObservation.version = null; }],
  ['false unavailable marker', input => { input.browserObservation.unavailableFields = ['version']; }],
  ['duplicate unavailable marker', input => { input.browserObservation.version = null; input.browserObservation.unavailableFields = ['version', 'version']; }],
  ['empty measured observation', input => { input.componentObservation.version = null; input.componentObservation.artifactSha256 = null; }],
]) test(`provenance rejects ${label}`, () => {
  const input = structuredClone({ browserObservation, componentObservation }); mutate(input);
  assert.throws(() => buildChromeProvenance(input), /schema|provenance|observation/i);
});

test('provenance rejects proxies, getters and hidden identity fields', () => {
  let reads = 0;
  const hidden = { ...browserObservation };
  Object.defineProperty(hidden, 'pid', { value: 123 });
  for (const browser of [new Proxy(browserObservation, {}), { ...browserObservation, get version() { reads++; return '1.0'; } }, hidden]) {
    assert.throws(() => buildChromeProvenance({ browserObservation: browser, componentObservation }), /schema|structure|provenance/i);
  }
  assert.equal(reads, 0);
});

for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
  test(`provenance rejects a ${trap} proxy that replaces its parent slot with an accessor`, () => {
    const browser = structuredClone(browserObservation);
    const original = browser.unavailableFields;
    let getterCalls = 0;
    browser.unavailableFields = new Proxy(original, {
      [trap](...args) {
        Object.defineProperty(browser, 'unavailableFields', { configurable: true, enumerable: true, get() { getterCalls++; return original; } });
        return Reflect[trap](...args);
      },
    });
    let error;
    try { buildChromeProvenance({ browserObservation: browser, componentObservation }); } catch (caught) { error = caught; }
    assert.deepEqual({ rejected: error instanceof TypeError, getterCalls }, { rejected: true, getterCalls: 0 });
  });
}

test('provenance rejects a proxy that removes itself with a plain data replacement', () => {
  const browser = structuredClone(browserObservation);
  const original = browser.unavailableFields;
  browser.unavailableFields = new Proxy(original, {
    getPrototypeOf(target) { browser.unavailableFields = original; return Reflect.getPrototypeOf(target); },
  });
  assert.throws(() => buildChromeProvenance({ browserObservation: browser, componentObservation }), /structure|schema/i);
});
