import { assertBundleManifest } from './bundle-manifest.js';
import { canonicalJson, sha256Bytes, sha256Json } from './canonical-json.js';
import { assertSupportedReviewPolicy } from './policy-registry.js';
import { sanitizeEvidence } from './redaction.js';
import { changedManifestFiles, omittedSourceFiles } from './source-diff.js';
import {
  assertCompleteEvidenceShape, buildChromeReviewPrompt, canonicalReviewJson,
  CHROME_REVIEW_PROMPT_ID, CHROME_REVIEW_SCHEMA_ID, CHROME_REVIEW_SCHEMA,
  exactReviewKeys, freezeReviewValue, MAX_EVIDENCE_PACKET_BYTES,
} from './chrome-review-contract.js';

function requireValue(condition) {
  if (!condition) throw new TypeError('Complete verified semantic evidence input required');
}

function snapshot(value) {
  return JSON.parse(canonicalReviewJson(value));
}

function validateEvidence(evidence) {
  assertCompleteEvidenceShape(evidence);
  const policy = assertSupportedReviewPolicy(evidence.policy);
  requireValue(policy.schemaVersion === 2 && sha256Json(policy) === evidence.policyDigest);
  const active = assertBundleManifest(evidence.activeManifest);
  const candidate = assertBundleManifest(evidence.candidateManifest);
  requireValue(active.bundleDigest === evidence.activeBundleDigest && candidate.bundleDigest === evidence.candidateBundleDigest);
  requireValue(active.schemaVersion === 1 && candidate.schemaVersion === 1);
  const approved = new Set(policy.approvedBundlePaths);
  requireValue([...active.files, ...candidate.files].every(file => approved.has(file.path)));
  const diff = evidence.sourceDiff;
  const expected = changedManifestFiles(active, candidate);
  requireValue(diff.changedFiles.length === expected.length);
  for (let i = 0; i < expected.length; i++) {
    const file = diff.changedFiles[i];
    const entry = expected[i];
    requireValue(file.path === entry.path && file.change === entry.change);
    for (const side of ['before', 'after']) {
      const manifest = entry[side];
      if (manifest !== null) {
        requireValue(file[side + 'Bytes'] === manifest.bytes && file[side + 'Sha256'] === manifest.sha256 && sha256Bytes(file[side + 'Text']) === manifest.sha256);
      }
    }
  }
  const { encodedBytes, ...body } = diff;
  requireValue(Buffer.byteLength(canonicalJson(body)) === encodedBytes);
  // Exclude reviewer output even when it is in the general receipt sanitizer's
  // vocabulary. Only deterministic producer fields belong in common evidence.
  const deterministic = evidence.deterministic;
  const allowed = new Set(['passed', 'checks', 'verifierIdentities', 'activeBundleDigest', 'candidateBundleDigest', 'policySnapshotHash']);
  requireValue(deterministic && typeof deterministic === 'object' && Object.keys(deterministic).every(key => allowed.has(key)));
  requireValue(typeof deterministic.passed === 'boolean' && Array.isArray(deterministic.checks));
  if (Object.hasOwn(deterministic, 'verifierIdentities')) {
    requireValue(Array.isArray(deterministic.verifierIdentities));
    for (const identity of deterministic.verifierIdentities) {
      exactReviewKeys(identity, ['name', 'sha256']);
      requireValue(typeof identity.name === 'string' && typeof identity.sha256 === 'string' && /^[a-f0-9]{64}$/.test(identity.sha256));
    }
  }
  requireValue(deterministic.activeBundleDigest === active.bundleDigest && deterministic.candidateBundleDigest === candidate.bundleDigest && deterministic.policySnapshotHash === evidence.policyDigest);
  requireValue(canonicalJson(sanitizeEvidence(deterministic, policy)) === canonicalJson(deterministic));
  return evidence;
}

/** Build the sole common source-evidence body. It has no reviewer result,
 * invocation details or self-referential digest fields. */
export function buildSemanticEvidence(input) {
  const value = snapshot(input);
  exactReviewKeys(value, ['reviewId', 'activeManifest', 'candidateManifest', 'policy', 'deterministic', 'sourceDiff']);
  const policy = assertSupportedReviewPolicy(value.policy);
  requireValue(policy.schemaVersion === 2);
  const evidence = validateEvidence({
    type: 'CompleteSemanticEvidence', schemaVersion: 2, reviewId: value.reviewId,
    activeBundleDigest: value.activeManifest.bundleDigest, candidateBundleDigest: value.candidateManifest.bundleDigest,
    policyDigest: sha256Json(policy), activeManifest: value.activeManifest, candidateManifest: value.candidateManifest,
    policy, deterministic: sanitizeEvidence(value.deterministic, policy), sourceDiff: value.sourceDiff,
  });
  return freezeReviewValue({ evidence, evidenceDigest: sha256Json(evidence) });
}

/** Also used by the Codex V2 prompt gate. Always returns a detached snapshot. */
export function assertSemanticEvidence(input) {
  const value = snapshot(input);
  exactReviewKeys(value, ['evidence', 'evidenceDigest']);
  validateEvidence(value.evidence);
  requireValue(value.evidenceDigest === sha256Json(value.evidence));
  return freezeReviewValue(value);
}

export function buildChromeReviewRequest(input) {
  const value = snapshot(input);
  exactReviewKeys(value, ['evidence', 'evidenceDigest', 'invocationId', 'runtimeGeneration', 'adapterDigest', 'deadline']);
  const common = assertSemanticEvidence({ evidence: value.evidence, evidenceDigest: value.evidenceDigest });
  requireValue(typeof value.invocationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.invocationId));
  requireValue(Number.isSafeInteger(value.runtimeGeneration) && value.runtimeGeneration >= 0);
  requireValue(typeof value.adapterDigest === 'string' && /^[a-f0-9]{64}$/.test(value.adapterDigest));
  requireValue(typeof value.deadline === 'string' && Number.isFinite(Date.parse(value.deadline)) && new Date(value.deadline).toISOString() === value.deadline);
  const { evidence, evidenceDigest } = common;
  requireValue(evidence.sourceDiff.coverageStatus === 'complete-input-supplied');
  const promptDigest = sha256Bytes(buildChromeReviewPrompt(common));
  const schemaDigest = sha256Json(CHROME_REVIEW_SCHEMA);
  const binding = {
    reviewId: evidence.reviewId, invocationId: value.invocationId,
    activeBundleDigest: evidence.activeBundleDigest, candidateBundleDigest: evidence.candidateBundleDigest,
    policyDigest: evidence.policyDigest, evidenceDigest,
    promptId: CHROME_REVIEW_PROMPT_ID, promptDigest, schemaId: CHROME_REVIEW_SCHEMA_ID, schemaDigest,
    adapterDigest: value.adapterDigest, runtimeGeneration: value.runtimeGeneration, deadline: value.deadline,
  };
  // inputDigest hashes this exact canonical packet, which has no inputDigest.
  // promptDigest hashes the rendered fixed wrapper + schema + common evidence;
  // neither the model body nor those inputs contain any of these digests.
  const packet = { type: 'ChromeReviewPacket', schemaVersion: 2, ...binding, evidence };
  const packetBytes = Buffer.byteLength(canonicalJson(packet));
  const inputDigest = sha256Json(packet);
  if (packetBytes > MAX_EVIDENCE_PACKET_BYTES) {
    return freezeReviewValue({
      type: 'IncompleteChromeReviewRequest', outcome: 'inconclusive', coverageStatus: 'incomplete-input',
      executionStatus: 'not-run', reasonCode: 'incomplete-input',
      inputDigest, evidenceDigest, activeBundleDigest: evidence.activeBundleDigest, candidateBundleDigest: evidence.candidateBundleDigest,
      policyDigest: evidence.policyDigest, packetBytes,
      omittedFiles: omittedSourceFiles(evidence.activeManifest, evidence.candidateManifest),
    });
  }
  return freezeReviewValue({ type: 'ReadyChromeReviewRequest', packet, packetBytes, transportBinding: { ...binding, inputDigest } });
}
