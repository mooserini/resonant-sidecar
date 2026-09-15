import { canonicalJson, sha256Json } from './canonical-json.js';
import { assertSupportedReviewPolicy } from './policy-registry.js';
import { snapshotChromeReviewValue } from './chrome-review-contract.js';
import { sanitizeEvidence, sanitizeSemanticReview } from './redaction.js';

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const BASE_FILES = ['report.md', 'receipt.json', 'attestation.json', 'policy-snapshot.json', 'receipt.sha256',
  ...['active-version', 'candidate-version', 'source-hashes', 'dependency-lock', 'test-results'].map(name => `project/${name}.json`),
  ...['before', 'verification', 'after'].map(phase => `os/${phase}/evidence.json`)];
const BASE_DIRECTORIES = ['', 'project', 'os', 'os/before', 'os/verification', 'os/after'];
export const SEMANTIC_REVIEW_FILE = 'semantic-reviews/chrome-language-model.json';
const PRE_CHROME = ['available', 'staged', 'deterministic-review', 'codex-review', 'chrome-semantic-review'];
const MAY_BE_UNBOUND = [...PRE_CHROME, 'review-failed', 'custody-broken'];
function schema(condition) { if (!condition) throw new TypeError('Receipt schema validation failed'); }
function digest(value) { return typeof value === 'string' && SHA256.test(value); }

function validateRecord(value, policy) {
  const fields = [...policy.receiptFields, ...(policy.schemaVersion === 2 ? ['semanticReviewsHash'] : [])].filter(key => key !== 'humanDecisionRef' || Object.hasOwn(value, key));
  schema(Object.keys(value).sort().join(',') === fields.sort().join(','));
  schema(ID.test(value.reviewId) && typeof value.reviewId === 'string' && ID.test(value.receiptId) && typeof value.receiptId === 'string');
  schema(typeof value.eventType === 'string' && Object.hasOwn(policy.stateTransitions, value.eventType));
  schema([...Object.keys(policy.stateTransitions), 'passed', 'failed', 'sanitization-failed'].includes(value.outcome));
  for (const key of ['previousReceiptHash', 'activeBundleDigest', 'candidateBundleDigest']) schema(value[key] === null || digest(value[key]));
  for (const key of ['projectEvidenceHash', 'osEvidenceHash', 'policySnapshotHash']) schema(digest(value[key]));
  schema(value.policySnapshotHash === sha256Json(policy));
  if (Object.hasOwn(value, 'humanDecisionRef')) schema(digest(value.humanDecisionRef));
  schema(Array.isArray(value.verifierIdentities) && value.verifierIdentities.length <= 20);
  for (const identity of value.verifierIdentities) {
    schema(identity !== null && typeof identity === 'object' && Object.keys(identity).sort().join(',') === 'name,version');
    schema(typeof identity.name === 'string' && ID.test(identity.name));
    schema(typeof identity.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(identity.version));
  }
  schema(typeof value.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) && Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt);
  if (policy.schemaVersion === 2) {
    schema(value.semanticReviewsHash === null || digest(value.semanticReviewsHash));
    if (PRE_CHROME.includes(value.eventType)) schema(value.semanticReviewsHash === null);
    if (!MAY_BE_UNBOUND.includes(value.eventType)) schema(digest(value.semanticReviewsHash));
  }
  sanitizeEvidence(value, policy);
}

/** Select only after validating the recorded snapshot and fixed-shape event.
 * The version-selected field extension leaves the approved policy bytes intact. */
export function receiptLayoutFor(policySnapshot, eventRecord) {
  const policy = assertSupportedReviewPolicy(snapshotChromeReviewValue(policySnapshot));
  const record = snapshotChromeReviewValue(eventRecord);
  schema(record !== null && typeof record === 'object' && !Array.isArray(record));
  validateRecord(record, policy);
  const bound = policy.schemaVersion === 2 && record.semanticReviewsHash !== null;
  return Object.freeze({
    version: policy.schemaVersion,
    files: Object.freeze([...BASE_FILES, ...(bound ? [SEMANTIC_REVIEW_FILE] : [])].sort()),
    directories: Object.freeze([...BASE_DIRECTORIES, ...(bound ? ['semantic-reviews'] : [])]),
    validateReceipt: value => {
      const snapshot = snapshotChromeReviewValue(value);
      validateRecord(snapshot, policy);
      schema(canonicalJson(snapshot) === canonicalJson(record));
    },
    validateSemanticReview: value => {
      schema(bound);
      const artifact = sanitizeSemanticReview(value, policy);
      for (const key of ['reviewId', 'activeBundleDigest', 'candidateBundleDigest', 'policySnapshotHash']) schema(artifact[key] === record[key]);
      schema(Date.parse(artifact.completedAt) <= Date.parse(record.createdAt));
      schema(sha256Json(artifact) === record.semanticReviewsHash);
      if (record.eventType === 'eligible') schema(artifact.eligibilityEffect === 'prerequisite-satisfied');
      if (record.eventType === 'review-failed') schema(artifact.eligibilityEffect === 'candidate-withheld');
      return artifact;
    },
  });
}
