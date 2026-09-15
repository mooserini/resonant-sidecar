import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalJson, sha256Bytes, sha256Json } from '../review/canonical-json.js';
import { buildSourceDiff } from '../review/source-diff.js';
import { buildSemanticEvidence, buildChromeReviewRequest } from '../review/semantic-evidence.js';
import { buildCodexReviewPrompt } from '../review/codex-prompt.js';
import { buildChromeReviewPrompt, CHROME_REVIEW_PROMPT, CHROME_REVIEW_SCHEMA } from '../review/chrome-review-contract.js';
import { loadReviewPolicy } from '../review/policy-registry.js';
import { AFTER, SOURCE_PATH, sourceFixture } from './fixtures/semantic-source.js';

async function evidenceInput(t, after) {
  const files = await sourceFixture(t, undefined, after);
  const policy = loadReviewPolicy(2);
  return { reviewId: 'review-123', activeManifest: files.activeManifest, candidateManifest: files.candidateManifest, policy,
    deterministic: { passed: true, checks: [{ name: 'schema', passed: true }], policySnapshotHash: sha256Json(policy),
      activeBundleDigest: files.activeManifest.bundleDigest, candidateBundleDigest: files.candidateManifest.bundleDigest },
    sourceDiff: await buildSourceDiff(files) };
}

const invocation = { invocationId: 'invocation-123', runtimeGeneration: 7, adapterDigest: 'a'.repeat(64), deadline: '2026-09-14T12:00:00.000Z' };

test('both independent prompts contain the identical canonical evidence and fixed schemas', async t => {
  const input = await evidenceInput(t);
  const result = buildSemanticEvidence(input);
  assert.equal(result.evidence.sourceDiff.changedFiles[0].afterText, AFTER);
  assert.equal(result.evidenceDigest, sha256Json(result.evidence));
  const chrome = buildChromeReviewRequest({ ...result, ...invocation });
  assert.equal(chrome.type, 'ReadyChromeReviewRequest');
  assert.deepEqual(chrome.packet.evidence, result.evidence);
  for (const prompt of [buildCodexReviewPrompt(result), buildChromeReviewPrompt(result)]) {
    assert.ok(prompt.includes(canonicalJson(result.evidence)));
    assert.equal(prompt.includes('Committed local bundle; canonical manifests and deterministic checks are authoritative.'), false);
  }
  assert.equal(chrome.transportBinding.inputDigest, sha256Json(chrome.packet));
  assert.equal(chrome.transportBinding.promptDigest, sha256Bytes(buildChromeReviewPrompt(result)));
  assert.equal(chrome.transportBinding.schemaDigest, sha256Json(CHROME_REVIEW_SCHEMA));
  for (const key of ['reviewId', 'invocationId', 'runtimeGeneration', 'adapterDigest', 'deadline', 'activeBundleDigest', 'candidateBundleDigest', 'policyDigest']) {
    assert.deepEqual(chrome.transportBinding[key], chrome.packet[key]);
  }
  assert.match(CHROME_REVIEW_PROMPT, /untrusted/i);
});

test('trusted evidence snapshots resist later caller mutation', async t => {
  const input = await evidenceInput(t);
  const result = buildSemanticEvidence(input);
  input.sourceDiff.changedFiles[0].afterText = 'mutated';
  input.policy.schemaVersion = 999;
  assert.equal(result.evidence.sourceDiff.changedFiles[0].afterText, AFTER);
  assert.equal(result.evidence.policy.schemaVersion, 2);
  assert.throws(() => { result.evidence.sourceDiff.changedFiles[0].afterText = 'mutated'; }, TypeError);
});

test('rejects mismatched bindings, forged coverage, unsupported policy and prior reviewer results', async t => {
  const original = await evidenceInput(t);
  for (const mutate of [
    input => { input.deterministic.candidateBundleDigest = 'f'.repeat(64); },
    input => { input.sourceDiff.changedFiles[0].afterText = 'forged'; },
    input => { input.sourceDiff.coverage[0].after.ranges = [[0, 1]]; },
    input => { input.sourceDiff.changedFiles = []; input.sourceDiff.coverage = []; },
    input => { input.policy.applicationLimits.maxEvidencePacketBytes = 99999999; },
    input => { input.codexResult = { verdict: 'favorable' }; },
    input => { input.deterministic.attestation = { verdict: 'favorable' }; },
    input => { input.deterministic.verifierIdentities = [{ name: 'codex', attestation: { verdict: 'favorable' } }]; },
    input => { input.deterministic.stdout = 'secret output'; },
  ]) {
    const input = structuredClone(original); mutate(input);
    assert.throws(() => buildSemanticEvidence(input));
  }
  const result = buildSemanticEvidence(original);
  assert.throws(() => buildCodexReviewPrompt({ ...result, evidenceDigest: 'f'.repeat(64) }));
  assert.throws(() => buildChromeReviewRequest({ ...result, ...invocation, evidenceDigest: 'f'.repeat(64) }));
  assert.throws(() => buildCodexReviewPrompt({ ...result, chromeResult: {} }));
  assert.throws(() => buildChromeReviewRequest({ ...result, ...invocation, codexResult: {} }));
});

test('oversized complete packet becomes structurally non-promptable with exact omitted ranges', async t => {
  const text = 'x'.repeat(131072);
  const result = buildSemanticEvidence(await evidenceInput(t, { [SOURCE_PATH]: text }));
  const request = buildChromeReviewRequest({ ...result, ...invocation });
  assert.equal(request.type, 'IncompleteChromeReviewRequest');
  assert.equal(Object.hasOwn(request, 'packet'), false);
  assert.equal(Object.hasOwn(request, 'evidence'), false);
  assert.equal(request.outcome, 'inconclusive');
  assert.equal(request.coverageStatus, 'incomplete-input');
  assert.equal(request.executionStatus, 'not-run');
  assert.equal(request.reasonCode, 'incomplete-input');
  assert.ok(request.packetBytes > 131072);
  assert.deepEqual(request.omittedFiles[0].after, { sha256: sha256Bytes(text), byteLength: 131072, ranges: [], omittedRanges: [[0, 131072]] });
  for (const builder of [buildCodexReviewPrompt, buildChromeReviewPrompt]) {
    assert.throws(() => builder(request), /complete|evidence|input/i);
    assert.throws(() => builder({ evidence: request, evidenceDigest: sha256Json(request) }), /complete|evidence|input/i);
  }
});

test('incomplete source is rejected before either prompt builder', async t => {
  const input = await evidenceInput(t);
  input.sourceDiff = { type: 'IncompleteSourceDiff', coverageStatus: 'incomplete-input', omittedFiles: [] };
  assert.throws(() => buildSemanticEvidence(input), /complete|input/i);
  for (const builder of [buildCodexReviewPrompt, buildChromeReviewPrompt]) {
    assert.throws(() => builder({ evidence: input.sourceDiff, evidenceDigest: sha256Json(input.sourceDiff) }), /complete|evidence|input/i);
  }
});

test('Chrome caps the canonical envelope at exactly 131072 encoded bytes', async t => {
  const baselineLength = 120000;
  const baseline = buildChromeReviewRequest({ ...buildSemanticEvidence(await evidenceInput(t, { [SOURCE_PATH]: 'x'.repeat(baselineLength) })), ...invocation });
  const sourceLength = baselineLength + 131072 - baseline.packetBytes;
  const exact = buildChromeReviewRequest({ ...buildSemanticEvidence(await evidenceInput(t, { [SOURCE_PATH]: 'x'.repeat(sourceLength) })), ...invocation });
  assert.equal(exact.type, 'ReadyChromeReviewRequest');
  assert.equal(exact.packetBytes, 131072);
  const over = buildChromeReviewRequest({ ...buildSemanticEvidence(await evidenceInput(t, { [SOURCE_PATH]: 'x'.repeat(sourceLength + 1) })), ...invocation });
  assert.equal(over.packetBytes, 131073);
  assert.equal(over.type, 'IncompleteChromeReviewRequest');
  assert.equal(Object.hasOwn(over, 'packet'), false);
});

test('Node and browser contracts match one literal fixture and shared digest', async () => {
  const { CONTRACT_SOURCE } = await import('./fixtures/chrome-review-contract-source.js');
  const node = await readFile(new URL('../review/chrome-review-contract.js', import.meta.url));
  const browser = await readFile(new URL('../extension/chrome-review-contract.js', import.meta.url));
  assert.deepEqual(node, browser);
  assert.equal(node.toString(), CONTRACT_SOURCE);
  assert.equal(sha256Bytes(node), sha256Bytes(CONTRACT_SOURCE));
  const extensionContract = await import('../extension/chrome-review-contract.js');
  assert.equal(extensionContract.CHROME_REVIEW_PROMPT, CHROME_REVIEW_PROMPT);
  assert.deepEqual(CHROME_REVIEW_SCHEMA, JSON.parse(await readFile(new URL('../policy/chrome-language-model.v2.schema.json', import.meta.url))));
});
