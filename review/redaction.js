import { canonicalJson } from './canonical-json.js';

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

export function sanitizeEvidence(value, policy) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(item, depth = 0, key = '') {
    if (++nodes > 20000 || depth > 24) throw new SanitizationError();
    if (key !== 'checkRecord') assertContext(item, key);
    if (key === 'checkRecord' && (item === null || typeof item !== 'object' || Array.isArray(item))) throw new SanitizationError();
    if (key === 'checks' && !Array.isArray(item)) throw new SanitizationError();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      if (item.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item) || PROHIBITED_VALUE.test(item)) throw new SanitizationError();
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
        if (!FIELDS.has(name) || PROHIBITED_KEY.test(name)) throw new SanitizationError();
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
