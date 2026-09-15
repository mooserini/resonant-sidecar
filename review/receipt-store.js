import { lstatSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { mkdir, readdir, lstat, open, rename, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, sha256Bytes, sha256Json } from './canonical-json.js';
import { sanitizeEvidence, SanitizationError } from './redaction.js';
import { assertSupportedReviewPolicy, loadReviewPolicy, reviewPolicyDigest } from './policy-registry.js';
import { receiptLayoutFor, SEMANTIC_REVIEW_FILE } from './receipt-layout.js';

const V1_POLICY = loadReviewPolicy(1);
const V2_POLICY_HASH = reviewPolicyDigest(2);
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const PROJECT_FILES = { activeVersion: 'active-version.json', candidateVersion: 'candidate-version.json', sourceHashes: 'source-hashes.json', dependencyLock: 'dependency-lock.json', testResults: 'test-results.json' };
const PHASES = ['before', 'verification', 'after'];
const INPUT_FIELDS = ['reviewId', 'eventType', 'outcome', 'verifierIdentities', 'activeBundleDigest', 'candidateBundleDigest', 'projectEvidence', 'osEvidence', 'attestation', 'humanDecisionRef'];
const FIXED_FAILURE = { reviewId: 'sanitization-failure', eventType: 'review-failed', outcome: 'sanitization-failed', verifierIdentities: [{ name: 'sanitizer', version: '1' }], activeBundleDigest: null, candidateBundleDigest: null, projectEvidence: { activeVersion: {}, candidateVersion: {}, sourceHashes: {}, dependencyLock: {}, testResults: {} }, osEvidence: { before: {}, verification: {}, after: {} } };

export class CustodyError extends Error {
  constructor(reason = 'history verification failed') { super(`Custody broken: ${reason}`); this.name = 'CustodyError'; }
}
export class CompletionCancelledError extends Error {
  constructor() { super('Owning runtime cancelled activation commit'); this.name = 'CompletionCancelledError'; }
}
class LedgerBusyError extends Error {}

function schema(condition) { if (!condition) throw new TypeError('Receipt schema validation failed'); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function exact(value, keys) { schema(plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')); }
function validDigest(value) { return value === null || (typeof value === 'string' && SHA256.test(value)); }
function assertIdentity(value) {
  schema(Array.isArray(value) && value.length <= 20);
  for (const identity of value) {
    exact(identity, ['name', 'version']);
    schema(typeof identity.name === 'string' && ID.test(identity.name));
    schema(typeof identity.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(identity.version));
  }
}
function assertAttestation(value) {
  if (value === null) return;
  exact(value, ['schemaVersion', 'verdict', 'summary', 'behavioralDifferences', 'dependencyChanges', 'unexplainedFiles', 'policyConcerns']);
  schema(value.schemaVersion === 1 && ['favorable', 'unfavorable'].includes(value.verdict));
  schema(typeof value.summary === 'string' && value.summary.length <= 2000);
  for (const field of ['behavioralDifferences', 'dependencyChanges', 'unexplainedFiles', 'policyConcerns']) schema(Array.isArray(value[field]) && value[field].length <= 100 && value[field].every(item => typeof item === 'string' && item.length <= 1000));
}
function assertCore(value, policy) {
  schema(typeof value.reviewId === 'string' && ID.test(value.reviewId));
  schema(typeof value.eventType === 'string' && Object.hasOwn(policy.stateTransitions, value.eventType));
  schema(typeof value.outcome === 'string' && [...Object.keys(policy.stateTransitions), 'passed', 'failed', 'sanitization-failed'].includes(value.outcome));
  schema(validDigest(value.activeBundleDigest) && validDigest(value.candidateBundleDigest));
  assertIdentity(value.verifierIdentities);
  if (Object.hasOwn(value, 'humanDecisionRef')) schema(typeof value.humanDecisionRef === 'string' && SHA256.test(value.humanDecisionRef));
}
function assertInput(value, policy) {
  schema(plain(value) && Object.keys(value).every(key => INPUT_FIELDS.includes(key) || (policy.schemaVersion === 2 && key === 'semanticReview')));
  assertCore(value, policy);
  exact(value.projectEvidence, Object.keys(PROJECT_FILES));
  exact(value.osEvidence, PHASES);
  for (const item of [...Object.values(value.projectEvidence), ...Object.values(value.osEvidence)]) schema(plain(item));
  assertAttestation(value.attestation ?? null);
}
function assertReceipt(value, policy) {
  return receiptLayoutFor(policy, value);
}

function assertSemanticHistory(receipts) {
  let upgraded = false;
  const reviews = new Map();
  for (const receipt of receipts) {
    const v2 = receipt.policySnapshotHash === V2_POLICY_HASH;
    schema(v2 || !upgraded); upgraded ||= v2;
    const prior = reviews.get(receipt.reviewId);
    if (prior) schema(prior.policySnapshotHash === receipt.policySnapshotHash);
    if (v2) {
      if (prior?.semanticReviewsHash) {
        schema(receipt.semanticReviewsHash === prior.semanticReviewsHash);
        schema(canonicalJson(receipt.semanticReview) === canonicalJson(prior.semanticReview));
      } else if (receipt.semanticReviewsHash !== null) {
        schema(['eligible', 'review-failed'].includes(receipt.eventType));
        const artifact = receipt.semanticReview;
        const incomplete = prior?.eventType === 'deterministic-review' && receipt.eventType === 'review-failed' &&
          artifact.coverageStatus === 'incomplete-input' && artifact.executionStatus === 'not-run' &&
          artifact.reasonCode === 'incomplete-input' && artifact.eligibilityEffect === 'candidate-withheld';
        schema(prior?.eventType === 'chrome-semantic-review' || incomplete);
      } else if (prior?.eventType === 'chrome-semantic-review') {
        schema(!['eligible', 'review-failed'].includes(receipt.eventType));
      }
    }
    reviews.set(receipt.reviewId, receipt);
  }
}
function directoryName(receipt) { return `${receipt.createdAt.replaceAll(':', '-')}_${receipt.reviewId}`; }
function report(value) { return `# Local review receipt\n\nReview: ${value.reviewId}\n\nEvent: ${value.eventType}\n\nOutcome: ${value.outcome}\n\nCreated: ${value.createdAt}\n`; }
function hashFiles(files, prefix) {
  const hashes = {};
  for (const [name, bytes] of Object.entries(files)) if (prefix === 'project' ? name.startsWith('project/') || name === 'report.md' || name === 'attestation.json' : name.startsWith('os/')) hashes[name] = sha256Bytes(bytes);
  return sha256Json(hashes);
}
async function info(file) { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function readRegular(file) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4 * 1024 * 1024) throw new CustodyError('nonregular evidence');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    schema(opened.isFile() && opened.nlink === 1 && opened.dev === metadata.dev && opened.ino === metadata.ino);
    return await handle.readFile();
  } finally { await handle.close(); }
}
function decodeUtf8(bytes) { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
async function writeExclusive(file, bytes) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory) { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CustodyError('invalid directory');
}
async function immutableFlag(directory) {
  if (process.platform === 'darwin') await promisify(execFile)('/usr/bin/chflags', ['-R', '-P', 'uchg', directory], { timeout: 10000 });
}

async function openSealHandles(directory, files, directories) {
  const entries = [];
  // Hold each original inode across rename. Later fchmod never resolves a path.
  try {
    for (const name of [...directories, ...files]) {
      const target = path.join(directory, name);
      const isDirectory = directories.includes(name);
      const metadata = await lstat(target);
      schema(!metadata.isSymbolicLink() && (isDirectory ? metadata.isDirectory() : metadata.isFile() && metadata.nlink === 1));
      // Recheck every held ancestor before opening a child; never traverse a link.
      for (const entry of entries.filter(entry => entry.isDirectory && (entry.name === '' || name.startsWith(`${entry.name}/`)))) {
        const current = await lstat(path.join(directory, entry.name));
        schema(current.isDirectory() && !current.isSymbolicLink() && current.dev === entry.metadata.dev && current.ino === entry.metadata.ino);
      }
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | (isDirectory ? constants.O_DIRECTORY : constants.O_NONBLOCK));
      entries.push({ name, handle, metadata, isDirectory });
      const opened = await handle.stat();
      schema(opened.dev === metadata.dev && opened.ino === metadata.ino && (isDirectory ? opened.isDirectory() : opened.isFile() && opened.nlink === 1));
    }
    return entries;
  } catch (error) {
    await Promise.all(entries.map(entry => entry.handle.close()));
    throw error;
  }
}

async function sealHeldReceipt(directory, entries) {
  // Detect swaps before sealing, then operate exclusively on held handles.
  for (const entry of entries) {
    const current = await lstat(path.join(directory, entry.name));
    schema(!current.isSymbolicLink() && current.dev === entry.metadata.dev && current.ino === entry.metadata.ino);
  }
  for (const entry of [...entries].reverse()) {
    await entry.handle.chmod(entry.isDirectory ? 0o555 : 0o444);
    await entry.handle.sync();
  }
}
async function walk(directory, directories, relative = '', sealed = false) {
  if (!directories.includes(relative)) throw new CustodyError('unexpected evidence directory');
  const files = [];
  const metadata = await lstat(path.join(directory, relative));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CustodyError('nonregular evidence directory');
  if (sealed) schema((metadata.mode & 0o777) === 0o555);
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(directory, directories, name, sealed));
    else if (entry.isFile()) files.push(name);
    else throw new CustodyError('nonregular evidence');
  }
  return files;
}

export class ReceiptStore {
  #root; #policy; #clock; #randomUUID; #rename; #immutable;
  #commitScope = new AsyncLocalStorage();
  constructor({ root, policy = V1_POLICY, clock = () => new Date(), randomUUID: uuid = randomUUID, rename: renameAdapter = rename, immutable = immutableFlag } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.basename(root) !== 'review-receipts' || path.normalize(root) !== root) throw new TypeError('An explicit project-local review-receipts root is required');
    const snapshot = assertSupportedReviewPolicy(policy);
    this.#root = root; this.#policy = snapshot; this.#clock = clock; this.#randomUUID = uuid; this.#rename = renameAdapter; this.#immutable = immutable;
  }
  async #markBroken() {
    // Only a fixed marker is retained; never error text or rejected evidence.
    try { await writeExclusive(path.join(this.#root, '.custody-broken'), 'custody-broken\n'); } catch { /* Existing marker or unavailable storage: still refuse. */ }
  }
  async #readReceipt(directory, pending = false) {
    const directoryInfo = await lstat(directory);
    schema(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink());
    // These two fixed top-level records select the layout. Neither current
    // configuration nor untrusted directory inventory selects a schema.
    const selectors = {};
    for (const name of ['policy-snapshot.json', 'receipt.json']) {
      selectors[name] = await readRegular(path.join(directory, name));
      const parsed = JSON.parse(decodeUtf8(selectors[name]));
      schema(Buffer.from(canonicalJson(parsed), 'utf8').equals(selectors[name]));
    }
    const policy = assertSupportedReviewPolicy(JSON.parse(decodeUtf8(selectors['policy-snapshot.json'])));
    const receipt = JSON.parse(decodeUtf8(selectors['receipt.json']));
    const layout = assertReceipt(receipt, policy);
    const names = await walk(directory, layout.directories, '', !pending);
    schema(names.sort().join(',') === layout.files.join(','));
    const files = {};
    for (const name of names) {
      if (!pending) schema(((await lstat(path.join(directory, name))).mode & 0o777) === 0o444);
      files[name] = await readRegular(path.join(directory, name));
    }
    for (const [name, bytes] of Object.entries(selectors)) schema(bytes.equals(files[name]));
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const parsed = JSON.parse(decodeUtf8(files[name]));
      schema(Buffer.from(canonicalJson(parsed), 'utf8').equals(files[name]));
      if (name !== 'policy-snapshot.json' && name !== SEMANTIC_REVIEW_FILE && parsed !== null) sanitizeEvidence(parsed, policy);
    }
    schema(pending || directoryName(receipt) === path.basename(directory));
    assertAttestation(JSON.parse(decodeUtf8(files['attestation.json'])));
    schema(files['report.md'].equals(Buffer.from(report(receipt), 'utf8')));
    schema(receipt.policySnapshotHash === sha256Bytes(files['policy-snapshot.json']));
    schema(receipt.projectEvidenceHash === hashFiles(files, 'project'));
    schema(receipt.osEvidenceHash === hashFiles(files, 'os'));
    const receiptHash = sha256Bytes(files['receipt.json']);
    schema(files['receipt.sha256'].equals(Buffer.from(`${receiptHash}\n`, 'utf8')));
    const semanticReview = files[SEMANTIC_REVIEW_FILE] ? layout.validateSemanticReview(JSON.parse(decodeUtf8(files[SEMANTIC_REVIEW_FILE]))) : null;
    return { ...receipt, receiptHash, directory, ...(semanticReview ? { semanticReview } : {}) };
  }
  async #chain() {
    const rootInfo = await info(this.#root);
    if (!rootInfo) return { state: 'intact', count: 0, tailHash: null, receipts: [] };
    try {
      schema(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
      if (await info(path.join(this.#root, '.custody-broken'))) throw new CustodyError('recorded history break');
      const ignored = new Set(['README.md', 'runtime-comparisons', 'repository-comparisons', '.pending', '.custody-head', '.append-lock', 'latest-failure.json']);
      const candidates = [];
      for (const entry of await readdir(this.#root, { withFileTypes: true })) {
        if (ignored.has(entry.name) || entry.name.startsWith('.failure-next-')) continue;
        if (entry.name.startsWith('.head-next-')) throw new CustodyError('interrupted checkpoint');
        schema(entry.isDirectory() && /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z_[A-Za-z0-9-]+$/.test(entry.name));
        candidates.push(await this.#readReceipt(path.join(this.#root, entry.name)));
      }
      const pendingInfo = await info(path.join(this.#root, '.pending'));
      if (pendingInfo) {
        schema(pendingInfo.isDirectory() && !pendingInfo.isSymbolicLink());
        schema((await readdir(path.join(this.#root, '.pending'))).length === 0);
      }
      const receipts = [];
      let tailHash = null;
      const ids = new Set();
      while (receipts.length < candidates.length) {
        const next = candidates.filter(item => item.previousReceiptHash === tailHash);
        schema(next.length === 1 && !ids.has(next[0].receiptId));
        ids.add(next[0].receiptId); receipts.push(next[0]); tailHash = next[0].receiptHash;
      }
      assertSemanticHistory(receipts);
      const headInfo = await info(path.join(this.#root, '.custody-head'));
      if (headInfo) {
        const head = JSON.parse(decodeUtf8(await readRegular(path.join(this.#root, '.custody-head'))));
        exact(head, ['count', 'tailHash']);
        schema(head.count === receipts.length && head.tailHash === tailHash);
      } else schema(receipts.length === 0 && !pendingInfo);
      return { state: 'intact', count: receipts.length, tailHash, receipts };
    } catch {
      if (rootInfo.isDirectory() && !rootInfo.isSymbolicLink()) await this.#markBroken();
      return { state: 'custody-broken', reason: 'Canonical history or custody witness is missing, changed, or incomplete' };
    }
  }
  async verifyChain() {
    const metadata = await info(this.#root);
    if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) return this.#chain();
    // Use the same lock as writers: a check-then-read can observe half a commit.
    try { return await this.#locked(() => this.#chain()); }
    catch (error) {
      if (error instanceof LedgerBusyError) return { state: 'busy', reason: 'An append is active or interrupted' };
      throw error;
    }
  }
  async #pointer(chain) {
    const failure = chain.receipts.findLast(item => ['review-failed', 'activation-failed'].includes(item.eventType));
    const temporary = path.join(this.#root, `.failure-next-${this.#safeUUID()}`);
    await writeExclusive(temporary, canonicalJson(failure ? { receiptHash: failure.receiptHash, directory: path.basename(failure.directory) } : null));
    await this.#rename(temporary, path.join(this.#root, 'latest-failure.json'));
    return failure ? path.join(failure.directory, 'report.md') : null;
  }
  #safeUUID() { const id = this.#randomUUID(); schema(typeof id === 'string' && ID.test(id)); return id; }
  async #locked(operation) {
    await ensureDirectory(this.#root);
    const lock = path.join(this.#root, '.append-lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new LedgerBusyError('Custody ledger is busy or has an interrupted append'); throw error; }
    try { return await operation(); } finally { await rmdir(lock); }
  }
  async resolveLatestFailure() {
    return this.#locked(async () => {
      const chain = await this.#chain();
      if (chain.state !== 'intact') throw new CustodyError(chain.reason);
      return this.#pointer(chain);
    });
  }
  async finalizeEvent(input) {
    const commitGuard = this.#commitScope.getStore();
    return this.#locked(async () => {
      const chain = await this.#chain();
      if (chain.state !== 'intact') throw new CustodyError(chain.reason);
      if (this.#policy.schemaVersion === 1 && chain.receipts.some(receipt => receipt.policySnapshotHash === V2_POLICY_HASH)) throw new CustodyError('policy downgrade');
      let sanitized; let rejected = false;
      try { sanitized = sanitizeEvidence(input, this.#policy); }
      catch (error) { if (!(error instanceof SanitizationError)) throw error; sanitized = structuredClone(FIXED_FAILURE); rejected = true; }
      assertInput(sanitized, this.#policy);
      const receiptId = this.#safeUUID();
      if (chain.receipts.some(receipt => receipt.receiptId === receiptId)) throw new TypeError('Duplicate receipt ID');
      const observed = new Date(this.#clock()).getTime();
      schema(Number.isFinite(observed));
      const lastTime = chain.receipts.length ? Date.parse(chain.receipts.at(-1).createdAt) : -Infinity;
      const createdAt = new Date(Math.max(observed, lastTime + 1)).toISOString();
      const prior = chain.receipts.findLast(receipt => receipt.reviewId === sanitized.reviewId);
      let semanticReview = sanitized.semanticReview ?? null;
      if (prior?.semanticReviewsHash) {
        if (Object.hasOwn(sanitized, 'semanticReview')) schema(canonicalJson(semanticReview) === canonicalJson(prior.semanticReview));
        semanticReview = prior.semanticReview;
      }
      const receipt = { receiptId, reviewId: sanitized.reviewId, eventType: sanitized.eventType, outcome: sanitized.outcome, previousReceiptHash: chain.tailHash, projectEvidenceHash: '', osEvidenceHash: '', policySnapshotHash: sha256Json(this.#policy), verifierIdentities: sanitized.verifierIdentities, activeBundleDigest: sanitized.activeBundleDigest, candidateBundleDigest: sanitized.candidateBundleDigest, ...(sanitized.humanDecisionRef ? { humanDecisionRef: sanitized.humanDecisionRef } : {}), createdAt,
        ...(this.#policy.schemaVersion === 2 ? { semanticReviewsHash: semanticReview ? sha256Json(semanticReview) : null } : {}) };
      const files = { 'report.md': report(receipt), 'attestation.json': canonicalJson(sanitized.attestation ?? null), 'policy-snapshot.json': canonicalJson(this.#policy) };
      for (const [key, name] of Object.entries(PROJECT_FILES)) files[`project/${name}`] = canonicalJson(sanitized.projectEvidence[key]);
      for (const phase of PHASES) files[`os/${phase}/evidence.json`] = canonicalJson(sanitized.osEvidence[phase]);
      receipt.projectEvidenceHash = hashFiles(files, 'project'); receipt.osEvidenceHash = hashFiles(files, 'os');
      const layout = assertReceipt(receipt, this.#policy);
      if (semanticReview) { layout.validateSemanticReview(semanticReview); files[SEMANTIC_REVIEW_FILE] = canonicalJson(semanticReview); }
      assertSemanticHistory([...chain.receipts, { ...receipt, ...(semanticReview ? { semanticReview } : {}) }]);
      files['receipt.json'] = canonicalJson(receipt);
      const receiptHash = sha256Bytes(files['receipt.json']);
      files['receipt.sha256'] = `${receiptHash}\n`;
      await ensureDirectory(path.join(this.#root, '.pending'));
      const parents = [this.#root, path.join(this.#root, '.pending')].map(directory => ({ directory, metadata: lstatSync(directory) }));
      const pending = path.join(this.#root, '.pending', receiptId);
      await mkdir(pending, { mode: 0o700 });
      for (const [name, bytes] of Object.entries(files)) {
        await ensureDirectory(path.dirname(path.join(pending, name)));
        await writeExclusive(path.join(pending, name), bytes);
      }
      for (const name of [...layout.directories].reverse()) await syncDirectory(path.join(pending, name));
      await this.#readReceipt(pending, true);
      const sealHandles = await openSealHandles(pending, Object.keys(files), layout.directories);
      let result;
      try {
        const headTemporary = path.join(this.#root, `.head-next-${receiptId}`);
        await writeExclusive(headTemporary, canonicalJson({ count: chain.count + 1, tailHash: receiptHash }));
        const directory = path.join(this.#root, directoryName(receipt));
        if (await info(directory)) throw new CustodyError('receipt target already exists');
        if (commitGuard) {
          // The scope is supplied by VersionStore, not the finalizer adapter or
          // browser. No asynchronous boundary separates live ownership from
          // canonical publication: close either cancels first or follows commit.
          if (commitGuard() !== true) {
            for (const entry of parents) {
              const current = lstatSync(entry.directory);
              schema(current.isDirectory() && !current.isSymbolicLink() && current.dev === entry.metadata.dev && current.ino === entry.metadata.ino);
            }
            for (const entry of sealHandles) {
              const current = lstatSync(path.join(pending, entry.name));
              schema(!current.isSymbolicLink() && current.dev === entry.metadata.dev && current.ino === entry.metadata.ino);
            }
            // Remove only this unpublished, inode-checked preparation. Existing
            // canonical receipts and their head have not changed.
            for (const entry of [...sealHandles].reverse()) {
              const target = path.join(pending, entry.name);
              if (entry.isDirectory) rmdirSync(target); else unlinkSync(target);
            }
            unlinkSync(headTemporary);
            await syncDirectory(path.join(this.#root, '.pending')); await syncDirectory(this.#root);
            throw new CompletionCancelledError();
          }
          renameSync(headTemporary, path.join(this.#root, '.custody-head'));
          renameSync(pending, directory);
        } else {
          await this.#rename(headTemporary, path.join(this.#root, '.custody-head'));
          await syncDirectory(this.#root);
          await this.#rename(pending, directory);
        }
        await this.#readReceipt(directory, true);
        await sealHeldReceipt(directory, sealHandles);
        await this.#readReceipt(directory);
        await syncDirectory(this.#root);
        try { await this.#immutable(directory); } catch { /* Best effort; read-only modes and hash verification remain required. */ }
        result = await this.#readReceipt(directory);
      } catch (error) {
        if (!(error instanceof CompletionCancelledError)) await this.#markBroken();
        throw error;
      } finally {
        await Promise.all(sealHandles.map(entry => entry.handle.close()));
      }
      // This convenience pointer is rebuildable; its failure cannot undo custody.
      try { await this.#pointer({ receipts: [...chain.receipts, result] }); } catch { /* Resolve can rebuild it later. */ }
      if (rejected) throw new SanitizationError();
      return result;
    });
  }
  withCommitGuard(guard, operation) {
    if (typeof guard !== 'function' || typeof operation !== 'function' || this.#commitScope.getStore()) throw new TypeError('Trusted completion scope required');
    return this.#commitScope.run(guard, operation);
  }
}
