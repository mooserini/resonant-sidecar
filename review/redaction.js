import { canonicalJson, sha256Json } from './canonical-json.js';
import { assertSupportedReviewPolicy } from './policy-registry.js';
import { buildChromeProvenance } from './chrome-provenance.js';
import { parseChromeAnalysis, snapshotChromeReviewValue } from './chrome-review-contract.js';

export class SanitizationError extends Error {
  constructor() {
    super('Evidence rejected by sanitization policy');
    this.name = 'SanitizationError';
  }
}

// Producers must reduce diagnostics to this vocabulary before crossing custody.
// No raw output, arbitrary maps, environment, page or conversation fields.
const FIELDS = new Set(`
  receiptId reviewId eventType outcome previousReceiptHash projectEvidenceHash
  osEvidenceHash policySnapshotHash verifierIdentities activeBundleDigest
  candidateBundleDigest humanDecisionRef createdAt projectEvidence osEvidence
  activeVersion candidateVersion sourceHashes dependencyLock testResults
  before verification after attestation schemaVersion verdict summary
  behavioralDifferences dependencyChanges unexplainedFiles policyConcerns
  bundleDigest sourceCommit files capabilities dependencies path sha256 bytes mode
  chromePermissions hostPermissions listeners lifecycleScripts lockfiles
  packageManager runtime name specifier version checks passed exitCode outputDigest
  command argv status reasonCode pid ppid pgid startTime elapsedTime executable
  executablePath executableDigest cwd signing identifier authority teamId cdHash
  processes descriptors fd type target endpoints transport address port protocol
  macOSVersion architecture bootSessionUUID sessionFileIdentity sampleDigest
  present matches expected actual nonceDigest action expiresAt decision
`.trim().split(/\s+/));

const PROHIBITED_KEY = /(?:environment|^env$|authorization|cookie|token|password|secret|connectionstring|transcript|conversation|pagetext|pagecontent|clipboard|stdout|stderr|history|serialnumber)/i;
const ENVIRONMENT_NAME = /^(?:home|path|user|logname|shell|pwd|oldpwd|lang|term|tmpdir|display|ssh_auth_sock)$/i;
const CHECK_FIELDS = new Set(['name', 'passed', 'exitCode', 'outputDigest', 'command', 'argv', 'status', 'reasonCode', 'actual', 'expected', 'matches', 'present']);

function assertContext(value, context) {
  if (context === 'name') {
    if (typeof value !== 'string' || value.length > 100 || PROHIBITED_KEY.test(value.replaceAll(/[-_ ]/g, '')) || /api[-_ ]?key/i.test(value) || ENVIRONMENT_NAME.test(value) || /^[A-Z][A-Z0-9_]*$/.test(value)) throw new SanitizationError();
  }
  if (context === 'actual' || context === 'expected') {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new SanitizationError();
  }
  if (context === 'checkRecord') {
    if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.name !== 'string' || Object.keys(value).some(key => !CHECK_FIELDS.has(key))) throw new SanitizationError();
    for (const key of ['passed', 'matches', 'present']) if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') throw new SanitizationError();
    if (Object.hasOwn(value, 'exitCode') && !Number.isSafeInteger(value.exitCode)) throw new SanitizationError();
    if (Object.hasOwn(value, 'outputDigest') && !/^[a-f0-9]{64}$/.test(value.outputDigest)) throw new SanitizationError();
    for (const key of ['status', 'reasonCode']) if (Object.hasOwn(value, key) && (typeof value[key] !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(value[key]))) throw new SanitizationError();
  }
}
const PROHIBITED_VALUE = /(?:\b(?:bearer|basic)\s+\S+|(?:authorization|cookie|set-cookie)\s*:|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/|\b[a-z][a-z0-9+.-]*:\/\/[^\s/]+:[^\s/]+@|\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]+)|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b[A-Z_][A-Z0-9_]*\s*=|(?:api[-_ ]?key|password|passwd|secret|access[-_]?token)\s*[:=]|\/(?:Users|home)\/|~\/)/i;

const CHROME_FIELDS = `schemaVersion reviewerId evidenceKind reviewerRequirement provenanceKind modelIdentityAssurance inferenceBinding reviewId invocationId runtimeGeneration activeBundleDigest candidateBundleDigest policySnapshotHash inputDigest promptDigest schemaDigest adapterDigest coverageStatus availabilityStatus executionStatus reasonCode startedAt completedAt browserObservation componentObservation analysis analysisDigest eligibilityEffect`.split(' ');
const CHROME_FAILURES = new Set(['api-absent', 'setup-required', 'setup-declined', 'unavailable', 'timeout', 'cancellation', 'panel-closure', 'browser-restart', 'connection-loss', 'incomplete-input', 'malformed-output', 'unfavorable-analysis', 'inconclusive-analysis', 'provenance-drift', 'sanitization-failure', 'custody-failure', 'terminal-receipt-interrupted']);
const PREPARATION_FAILURES = new Set(['api-absent', 'setup-required', 'setup-declined', 'unavailable']);
const INTERRUPTED_FAILURES = new Set(['timeout', 'cancellation', 'panel-closure', 'browser-restart', 'connection-loss', 'provenance-drift', 'sanitization-failure', 'custody-failure']);
const FORBIDDEN_CLAIM = /(?:Gemini-attested|verified Gemini weights|cryptographic model attestation|independent proof|safe to activate)/i;
// Bounded recognizable data/command forms, not a claim to detect arbitrary prose
// copied from source or a prompt. Producers must never submit those raw inputs.
const CHROME_UNSAFE_TEXT = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|file|javascript|data):|(?:^|[\s"'(])\/[A-Za-z0-9_.-]+\/|[A-Za-z]:\\|```|`|\$\(|\b(?:rm|curl|wget|sudo|chmod|chown|bash|sh|node|npm|npx|python|osascript)\s+(?:--?\S|\/[\w.]|[\w.-]+\.(?:js|sh|py))|\b(?:const|let|var|function|import|export)\s+[\w{*]+\s*[=(;]|\b(?:SYSTEM|USER|ASSISTANT)\s*:)/i;
const CHROME_DIAGNOSTIC_OR_COMMAND = /(?:\b[A-Za-z]*(?:Error|Exception)\s*:|(?:^|[;\n]|\b(?:run|execute)\s+)(?:rm|curl|wget|sudo|chmod|chown|bash|sh|npm|npx|osascript|touch|echo|printf|cat|whoami)\b)/i;

function semanticSchema(condition) { if (!condition) throw new SanitizationError(); }
function semanticTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }

function assertSemanticStatus(value) {
  const { reasonCode, executionStatus, availabilityStatus, coverageStatus, analysis, eligibilityEffect } = value;
  if (executionStatus === 'completed') {
    semanticSchema(availabilityStatus === 'available' && coverageStatus === 'complete-input-supplied' && analysis !== null);
    const expectedReason = { 'no-blocking-concern': null, 'blocking-concern': 'unfavorable-analysis', inconclusive: 'inconclusive-analysis' }[analysis.outcome];
    semanticSchema(reasonCode === expectedReason && eligibilityEffect === (reasonCode === null ? 'prerequisite-satisfied' : 'candidate-withheld'));
    return;
  }
  // No validated terminal inference exists in any non-completed failure. A
  // failed callback, cleanup, binding or receipt cannot retain a favorable body.
  semanticSchema(analysis === null && value.analysisDigest === null && eligibilityEffect === 'candidate-withheld');
  if (reasonCode === 'incomplete-input') {
    semanticSchema(coverageStatus === 'incomplete-input' && executionStatus === 'not-run' && availabilityStatus === 'not-checked');
    return;
  }
  semanticSchema(coverageStatus === 'complete-input-supplied');
  if (PREPARATION_FAILURES.has(reasonCode)) {
    semanticSchema(availabilityStatus === reasonCode && executionStatus === 'not-run');
  } else if (reasonCode === 'malformed-output') {
    semanticSchema(availabilityStatus === 'available' && executionStatus === 'failed');
  } else if (reasonCode === 'terminal-receipt-interrupted') {
    semanticSchema(['available', 'not-checked'].includes(availabilityStatus) && executionStatus === 'failed');
  } else {
    // Before inference, cancellation/expiry can occur at any known availability
    // state. An attempted inference requires the recorded available state.
    semanticSchema(INTERRUPTED_FAILURES.has(reasonCode));
    semanticSchema(executionStatus === 'not-run' || (executionStatus === 'failed' && availabilityStatus === 'available'));
  }
}

/** Only trusted lifecycle code constructs this envelope; only analysis is model
 * output. The result binder checks supplied source membership; the lifecycle
 * owner checks channel custody. Neither proves exact inference provenance. */
export function sanitizeSemanticReview(input, policySnapshot) {
  try {
    const policy = assertSupportedReviewPolicy(snapshotChromeReviewValue(policySnapshot));
    semanticSchema(policy.schemaVersion === 2);
    const value = snapshotChromeReviewValue(input);
    semanticSchema(value !== null && typeof value === 'object' && !Array.isArray(value));
    semanticSchema(Object.keys(value).length === CHROME_FIELDS.length && Object.keys(value).every(key => CHROME_FIELDS.includes(key)));
    function scan(item) {
      if (typeof item === 'string') semanticSchema(!PROHIBITED_VALUE.test(item) && !FORBIDDEN_CLAIM.test(item) && !CHROME_UNSAFE_TEXT.test(item) && !CHROME_DIAGNOSTIC_OR_COMMAND.test(item) && !/[\u0000-\u001f\u007f]/.test(item));
      else if (item !== null && typeof item === 'object') for (const child of Object.values(item)) scan(child);
    }
    scan(value);
    semanticSchema(value.schemaVersion === 2 && value.reviewerId === 'chrome-language-model' && value.evidenceKind === 'semantic-analysis' && value.reviewerRequirement === 'required');
    semanticSchema(value.provenanceKind === 'observed-local-components' && value.modelIdentityAssurance === 'not-attested' && value.inferenceBinding === 'not-established');
    semanticSchema(typeof value.reviewId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(value.reviewId));
    semanticSchema(typeof value.invocationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.invocationId));
    semanticSchema(Number.isSafeInteger(value.runtimeGeneration) && value.runtimeGeneration >= 0);
    for (const key of ['activeBundleDigest', 'candidateBundleDigest', 'policySnapshotHash', 'inputDigest', 'promptDigest', 'schemaDigest', 'adapterDigest']) semanticSchema(typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]));
    semanticSchema(value.policySnapshotHash === sha256Json(policy));
    semanticSchema(['complete-input-supplied', 'incomplete-input'].includes(value.coverageStatus));
    semanticSchema(['available', 'api-absent', 'setup-required', 'setup-declined', 'unavailable', 'not-checked'].includes(value.availabilityStatus));
    semanticSchema(['completed', 'failed', 'not-run'].includes(value.executionStatus));
    semanticSchema(value.reasonCode === null || CHROME_FAILURES.has(value.reasonCode));
    semanticSchema(semanticTimestamp(value.startedAt) && semanticTimestamp(value.completedAt) && Date.parse(value.startedAt) <= Date.parse(value.completedAt));
    const provenance = buildChromeProvenance({ browserObservation: value.browserObservation, componentObservation: value.componentObservation });
    for (const observed of [provenance.browserObservation.observedAt, provenance.componentObservation.observedAt]) semanticSchema(observed === null || Date.parse(observed) <= Date.parse(value.completedAt));
    if (value.analysis === null) semanticSchema(value.analysisDigest === null && value.executionStatus !== 'completed');
    else {
      semanticSchema(value.executionStatus !== 'not-run' && Array.isArray(value.analysis?.findings));
      // The full supplied evidence is intentionally not retained in receipts.
      // Recheck the exact analysis schema; trusted binder owns file/hunk membership.
      const suppliedFiles = [...new Set(value.analysis.findings.map(item => item.file))];
      const suppliedLocations = [...new Map(value.analysis.findings.filter(item => item.location !== null).map(item => [JSON.stringify([item.file, item.location]), { file: item.file, location: item.location }])).values()];
      const analysis = parseChromeAnalysis(canonicalJson(value.analysis), { suppliedFiles, suppliedLocations });
      semanticSchema(value.analysisDigest === sha256Json(analysis));
    }
    assertSemanticStatus(value);
    return value;
  } catch { throw new SanitizationError(); }
}

export function sanitizeEvidence(value, policy) {
  if (policy?.schemaVersion === 2) {
    try { value = snapshotChromeReviewValue(value); } catch { throw new SanitizationError(); }
  }
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth = 0, key = '') {
    if (++nodes > 20000 || depth > 24) throw new SanitizationError();
    if (key === 'semanticReview') {
      if (depth !== 1 || policy?.schemaVersion !== 2) throw new SanitizationError();
      return item === null ? null : sanitizeSemanticReview(item, policy);
    }
    if (key !== 'checkRecord') assertContext(item, key);
    if (key === 'checkRecord' && (item === null || typeof item !== 'object' || Array.isArray(item))) throw new SanitizationError();
    if (key === 'checks' && !Array.isArray(item)) throw new SanitizationError();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      if (item.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item) || PROHIBITED_VALUE.test(item) || (policy?.schemaVersion === 2 && FORBIDDEN_CLAIM.test(item))) throw new SanitizationError();
      return item;
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new SanitizationError();
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new SanitizationError();
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(item).some(name => typeof name !== 'string')) throw new SanitizationError();
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (name === 'length' && Array.isArray(item)) continue;
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new SanitizationError();
      }
      if (Array.isArray(item)) {
        if (item.length > 2000 || Object.keys(item).length !== item.length) throw new SanitizationError();
        const result = Array.from({ length: item.length }, (_, i) => visit(descriptors[i]?.value, depth + 1, key === 'checks' ? 'checkRecord' : ''));
        if (key === 'argv' || key === 'command') {
          if (!policy?.trustedTestCommands?.some(command => canonicalJson(command) === canonicalJson(result))) throw new SanitizationError();
        }
        return result;
      }
      const result = {};
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if ((!FIELDS.has(name) && !(policy?.schemaVersion === 2 && depth === 0 && ['semanticReview', 'semanticReviewsHash'].includes(name))) || PROHIBITED_KEY.test(name)) throw new SanitizationError();
        if ((name === 'argv' || name === 'command') && !Array.isArray(descriptor.value)) throw new SanitizationError();
        result[name] = visit(descriptor.value, depth + 1, name);
      }
      assertContext(result, key);
      return result;
    } finally {
      ancestors.delete(item);
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SanitizationError();
  return visit(value);
}
