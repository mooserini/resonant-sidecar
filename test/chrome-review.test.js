import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test, { beforeEach } from 'node:test';
import { bindChromeReviewResult } from '../review/chrome-review.js';
import { buildSemanticEvidence, buildChromeReviewRequest } from '../review/semantic-evidence.js';
import { buildSourceDiff } from '../review/source-diff.js';
import { loadReviewPolicy } from '../review/policy-registry.js';
import { sha256Json } from '../review/canonical-json.js';
import { sourceFixture } from './fixtures/semantic-source.js';

beforeEach(async () => {
  const copies = await Promise.all(['review', 'extension'].map(dir => readFile(new URL(`../${dir}/chrome-review-contract.js`, import.meta.url))));
  assert.equal(createHash('sha256').update(copies[0]).digest('hex'), createHash('sha256').update(copies[1]).digest('hex'));
});

const analysis = { schemaVersion: 2, outcome: 'no-blocking-concern', summary: 'No blocking concern.', findings: [] };
async function fixture(t) {
  const files = await sourceFixture(t);
  const policy = loadReviewPolicy(2);
  const common = buildSemanticEvidence({ reviewId: 'review-task4', activeManifest: files.activeManifest, candidateManifest: files.candidateManifest, policy,
    deterministic: { passed: true, checks: [{ name: 'schema', passed: true }], policySnapshotHash: sha256Json(policy), activeBundleDigest: files.activeManifest.bundleDigest, candidateBundleDigest: files.candidateManifest.bundleDigest },
    sourceDiff: await buildSourceDiff(files) });
  const request = buildChromeReviewRequest({ ...common, invocationId: 'invocation-task4', runtimeGeneration: 3, adapterDigest: 'a'.repeat(64), deadline: '2026-09-14T12:01:00.000Z' });
  return { request, rawText: JSON.stringify(analysis), completedAt: '2026-09-14T12:00:30.000Z',
    browserObservation: { executableSha256: null, version: '155.0.8048.0', signingIdentity: null, observedAt: '2026-09-14T12:00:00.000Z', unavailableFields: ['executableSha256', 'signingIdentity'] },
    componentObservation: { status: 'not-collected', metadataSource: null, version: null, artifactSha256: null, observedAt: null } };
}

test('trusted binder verifies request, binds canonical analysis and records unattested provenance', async t => {
  const input = await fixture(t);
  const result = bindChromeReviewResult(input);
  assert.equal(result.type, 'ChromeReviewResult');
  assert.deepEqual(result.transportBinding, input.request.transportBinding);
  assert.deepEqual(result.analysis, analysis);
  assert.equal(result.analysisDigest, sha256Json(analysis));
  assert.equal(result.completedAt, input.completedAt);
  assert.equal(result.modelIdentityAssurance, 'not-attested');
  assert.equal(result.inferenceBinding, 'not-established');
  assert.equal(result.provenanceKind, 'observed-local-components');
  assert.equal(Object.hasOwn(result, 'startedAt'), false);
  assert.equal(Object.hasOwn(result, 'verifierIdentities'), false);
  assert.equal(Object.hasOwn(result, 'passed'), false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.transportBinding) && Object.isFrozen(result.analysis.findings));
  input.browserObservation.version = '999.0';
  assert.equal(result.browserObservation.version, '155.0.8048.0');
});

test('trusted binder repeats output validation after the native boundary', async t => {
  const input = await fixture(t);
  for (const rawText of [JSON.stringify({ ...analysis, reviewerId: 'codex-process-evidence' }), JSON.stringify({ ...analysis, findings: [{ severity: 'important', category: 'behavior', file: 'invented.js', location: null, explanation: 'No.' }] }), '{"schemaVersion":2,"schemaVersion":2}', new Uint8Array([0xff])]) {
    assert.throws(() => bindChromeReviewResult({ ...input, rawText }), /schema|duplicate|reference|utf-8/i);
  }
  assert.throws(() => bindChromeReviewResult({ ...input, analysis }), /schema|structure/i);
});

test('trusted binder accepts only locations backed by that file and source side', async t => {
  const input = await fixture(t);
  const finding = { severity: 'important', category: 'behavior', file: 'native-host/host.js', location: 'after:0-24', explanation: 'Changed value.' };
  const raw = location => JSON.stringify({ ...analysis, outcome: 'blocking-concern', findings: [{ ...finding, location }] });
  assert.equal(bindChromeReviewResult({ ...input, rawText: raw('after:0-24') }).analysis.findings[0].location, 'after:0-24');
  assert.equal(bindChromeReviewResult({ ...input, rawText: raw('before:0-24') }).analysis.outcome, 'blocking-concern');
  assert.throws(() => bindChromeReviewResult({ ...input, rawText: raw('after:0-25') }), /reference/i);
});

for (const [label, mutate] of [
  ['input digest', input => { input.request.transportBinding.inputDigest = 'f'.repeat(64); }],
  ['adapter binding', input => { input.request.transportBinding.adapterDigest = 'f'.repeat(64); }],
  ['runtime generation', input => { input.request.transportBinding.runtimeGeneration++; }],
  ['packet bytes', input => { input.request.packetBytes--; }],
  ['evidence bytes', input => { input.request.packet.evidence.sourceDiff.changedFiles[0].afterText = 'forged'; }],
  ['schema digest', input => { input.request.packet.schemaDigest = 'f'.repeat(64); }],
  ['unsupported request', input => { input.request.type = 'IncompleteChromeReviewRequest'; }],
  ['forged transport fields', input => { input.request.transportBinding.accept = true; }],
  ['expired output', input => { input.completedAt = '2026-09-14T12:01:00.001Z'; }],
  ['noncanonical completion time', input => { input.completedAt = '2026-09-14T12:00:30Z'; }],
  ['future observation', input => { input.browserObservation.observedAt = '2026-09-14T12:00:31.000Z'; }],
]) test(`trusted binder rejects ${label}`, async t => {
  const input = structuredClone(await fixture(t)); mutate(input);
  assert.throws(() => bindChromeReviewResult(input), /schema|binding|evidence|input|time|observation/i);
});

test('trusted binder rejects proxy and accessor envelopes without accepting cached parsed results', async t => {
  const input = await fixture(t);
  let reads = 0;
  for (const value of [new Proxy(input, {}), { ...input, request: new Proxy(input.request, {}) }, { ...input, get rawText() { reads++; return JSON.stringify(analysis); } }]) {
    assert.throws(() => bindChromeReviewResult(value), /schema|structure/i);
  }
  assert.equal(reads, 0);
});
