import { sha256Json } from '../../review/canonical-json.js';
import { reviewPolicyDigest } from '../../review/policy-registry.js';

export function chromeReceipt(overrides = {}) {
  const analysis = { schemaVersion: 2, outcome: 'no-blocking-concern', summary: 'The supplied change retains the declared boundary.', findings: [] };
  return {
    schemaVersion: 2, reviewerId: 'chrome-language-model', evidenceKind: 'semantic-analysis', reviewerRequirement: 'required',
    provenanceKind: 'observed-local-components', modelIdentityAssurance: 'not-attested', inferenceBinding: 'not-established',
    reviewId: 'review-1', invocationId: 'invocation-1', runtimeGeneration: 3,
    activeBundleDigest: 'a'.repeat(64), candidateBundleDigest: 'a'.repeat(64), policySnapshotHash: reviewPolicyDigest(2),
    inputDigest: 'b'.repeat(64), promptDigest: 'c'.repeat(64), schemaDigest: 'd'.repeat(64), adapterDigest: 'e'.repeat(64),
    coverageStatus: 'complete-input-supplied', availabilityStatus: 'available', executionStatus: 'completed', reasonCode: null,
    startedAt: '2026-09-14T00:00:00.000Z', completedAt: '2026-09-14T00:00:00.001Z',
    browserObservation: { executableSha256: null, version: null, signingIdentity: null, observedAt: '2026-09-14T00:00:00.000Z', unavailableFields: ['executableSha256', 'version', 'signingIdentity'] },
    componentObservation: { status: 'not-collected', metadataSource: null, version: null, artifactSha256: null, observedAt: null },
    analysis, analysisDigest: sha256Json(analysis), eligibilityEffect: 'prerequisite-satisfied', ...overrides,
  };
}
