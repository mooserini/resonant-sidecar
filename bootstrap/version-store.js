import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertBundleManifest, buildBundleManifest } from '../review/bundle-manifest.js';
import { canonicalJson, sha256Bytes, sha256Json } from '../review/canonical-json.js';
import { assertPin, snapshotDecision, snapshotRecoveryBinding, recoverInterruptedActivation, samePin } from './recovery-state.js';
import { withRuntimeLock } from './runtime-lock.js';
import { verifyOwnershipTopology } from '../review/process-ownership.js';
import { sanitizeEvidence } from '../review/redaction.js';

const MAX_FILE = 8 * 1024 * 1024;
const MAX_BUNDLE = 32 * 1024 * 1024;
const fail = message => { throw new Error(message); };
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

// Every path component is checked, including ancestors above runtime. Custody
// protects against accidental paths and untrusted bundles, not a malicious uid
// that can replace this trusted bootstrap and all of its local state.
function concrete(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.normalize(p) !== p || /[\x00-\x1f]/.test(p)) fail('Invalid concrete path');
  let current = path.parse(p).root;
  for (const part of p.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('Symbolic link in custody path');
  }
  return p;
}
function privatePath(p, directory, device) {
  concrete(p); const info = fs.lstatSync(p);
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid() || (info.mode & 0o077) || (device !== undefined && info.dev !== device) || (!directory && info.nlink !== 1)) fail('Invalid runtime custody');
  return info;
}
function syncDir(p) { const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function readPrivate(p, device) {
  const before = privatePath(p, false, device);
  if (before.size > MAX_FILE) fail('File exceeds runtime bound');
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const held = fs.fstatSync(fd);
    if (held.ino !== before.ino || held.dev !== before.dev) fail('File custody changed');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length > MAX_FILE || after.size !== before.size || after.mtimeMs !== before.mtimeMs || fs.lstatSync(p).ino !== before.ino) fail('File custody changed');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function readCanonical(p, device) {
  const text = readPrivate(p, device).toString('utf8'); const value = JSON.parse(text);
  if (text !== canonicalJson(value) + '\n') fail('Noncanonical runtime state');
  return value;
}
function writeNew(p, bytes, mode = 0o600) {
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function completionWitness(binding, authorization) {
  const a = JSON.parse(canonicalJson(authorization));
  if (!a || Object.keys(a).sort().join(',') !== 'osEvidence,ownershipPolicy,runtime' || Object.keys(a.runtime ?? {}).sort().join(',') !== 'digest,pid,reviewId,threadId' || Object.keys(a.osEvidence ?? {}).sort().join(',') !== 'after,before,verification') fail('Completion authorization required');
  const r = a.runtime; const p = a.ownershipPolicy;
  if (r.digest !== binding.candidateDigest || r.reviewId !== binding.reviewId || r.threadId !== binding.threadId || !Number.isSafeInteger(r.pid) || r.pid < 1 || p.phase !== 'after' || p.chromeExited || p.processes?.find(v => v.name === 'active-host')?.pid !== r.pid || !verifyOwnershipTopology(a.osEvidence.after, p).passed) fail('Invalid completion authorization');
  const evidence = sanitizeEvidence(a.osEvidence);
  const osEvidenceHash = sha256Json(Object.fromEntries(['before', 'verification', 'after'].map(phase => [`os/${phase}/evidence.json`, sha256Bytes(canonicalJson(evidence[phase]))])));
  return { schemaVersion: 1, binding, ...a, osEvidenceHash };
}

export class VersionStore {
  #project; #root; #device; #consume; #verifyConsumed; #clock; #lock; #receipts = null; #recovered = null; #pending = null; #runtimeGuard = null;
  constructor({ projectRoot, consumeDecision, verifyConsumedDecision, clock = Date.now, withRuntimeLock: lock = withRuntimeLock } = {}) {
    if (typeof lock !== 'function') fail('Runtime lock provider required');
    this.#project = concrete(projectRoot);
    this.#root = path.join(projectRoot, 'runtime');
    this.#consume = consumeDecision;
    this.#verifyConsumed = verifyConsumedDecision; this.#clock = clock; this.#lock = lock;
  }
  #prepare() {
    concrete(this.#project);
    if (!exists(this.#root)) { try { fs.mkdirSync(this.#root, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } syncDir(this.#project); }
    this.#device = privatePath(this.#root, true).dev;
    for (const name of ['active', 'previous', 'versions', 'quarantine', 'history', 'decisions', 'installations', 'completions']) {
      const dir = path.join(this.#root, name);
      if (!exists(dir)) { try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } syncDir(this.#root); }
      privatePath(dir, true, this.#device);
    }
  }
  async #locked(fn) {
    this.#prepare();
    return this.#lock({ file: path.join(this.#root, '.store-lock.json'), device: this.#device }, async () => {
      this.#prepare(); syncDir(this.#root); return fn();
    });
  }
  #atomic(relative, value) {
    const destination = path.join(this.#root, relative); const parent = path.dirname(destination);
    privatePath(parent, true, this.#device);
    if (exists(destination)) privatePath(destination, false, this.#device);
    const temp = path.join(parent, `.pending-${randomUUID()}`);
    writeNew(temp, canonicalJson(value) + '\n');
    privatePath(parent, true, this.#device);
    fs.renameSync(temp, destination); syncDir(parent);
  }
  #pin(name) {
    const p = path.join(this.#root, name, 'pin.json');
    if (!exists(p)) return null;
    const pin = readCanonical(p, this.#device);
    return pin === null ? null : assertPin(pin);
  }
  #state() {
    const p = path.join(this.#root, 'recovery-state.json');
    const state = exists(p) ? readCanonical(p, this.#device) : null;
    recoverInterruptedActivation(state); return state;
  }
  #save(state) { recoverInterruptedActivation(state); this.#atomic('recovery-state.json', state); }
  #archive(state) {
    if (state) { this.#atomic(`history/${randomUUID()}.json`, state); }
  }
  #recordInstallation(pin) {
    const file = path.join(this.#root, 'installations', `${pin.reviewId}.json`);
    if (exists(file)) {
      if (!samePin(readCanonical(file, this.#device), pin)) fail('Installation review identity mismatch');
    } else { writeNew(file, canonicalJson(pin) + '\n', 0o400); syncDir(path.dirname(file)); }
  }
  #assertInstalled(pin) {
    const file = path.join(this.#root, 'installations', `${pin.reviewId}.json`);
    if (!exists(file) || !samePin(readCanonical(file, this.#device), pin)) fail('Installation review identity mismatch');
  }
  #assertActiveState(state, pin) {
    const expected = state === null ? null : state.phase === 'rolled-back' ? state.previous : state.candidate;
    if (!samePin(pin, expected)) fail('Active pin disagrees with recovery state');
  }
  async #verifyBundle(root, manifest) {
    assertBundleManifest(manifest);
    if (manifest.schemaVersion !== 1 || manifest.files.length > 256 || manifest.files.some(f => f.mode !== 0o644)) fail('Unsupported bundle manifest');
    const inventory = []; let total = 0;
    const walk = dir => {
      privatePath(dir, true, this.#device);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { privatePath(p, false, this.#device); inventory.push(path.relative(root, p).split(path.sep).join('/')); }
      }
    };
    walk(root); inventory.sort();
    if (canonicalJson(inventory) !== canonicalJson(manifest.files.map(f => f.path).sort())) fail('Bundle inventory mismatch');
    for (const file of manifest.files) {
      const bytes = readPrivate(path.join(root, file.path), this.#device); total += bytes.length;
      if (total > MAX_BUNDLE || bytes.length !== file.bytes || sha256Bytes(bytes) !== file.sha256) fail('Bundle digest mismatch');
      if ((fs.lstatSync(path.join(root, file.path)).mode & 0o777) !== 0o400) fail('Unsealed bundle custody');
    }
    // Recompute capability/dependency declarations as well as file hashes. The
    // identity uses Git's original modes; custody deliberately seals them 0400.
    const observed = await buildBundleManifest({ root, files: inventory, sourceCommit: manifest.sourceCommit, schemaVersion: 1 });
    observed.files = observed.files.map(f => ({ ...f, mode: manifest.files.find(m => m.path === f.path).mode }));
    const { bundleDigest: ignored, ...unsigned } = observed;
    if (sha256Json(unsigned) !== manifest.bundleDigest) fail('Bundle digest mismatch');
    return manifest;
  }
  async #version(pin) {
    assertPin(pin);
    const directory = path.join(this.#root, 'versions', pin.digest);
    privatePath(directory, true, this.#device);
    const names = fs.readdirSync(directory).sort();
    if (names.join(',') !== 'bundle,manifest.json') fail('Version inventory mismatch');
    const manifest = assertBundleManifest(readCanonical(path.join(directory, 'manifest.json'), this.#device));
    if (manifest.bundleDigest !== pin.digest) fail('Version digest mismatch');
    await this.#verifyBundle(path.join(directory, 'bundle'), manifest);
    if (!manifest.files.some(f => f.path === 'native-host/host.js')) fail('Active host missing');
    return { digest: pin.digest, reviewId: pin.reviewId, hostPath: path.join(directory, 'bundle/native-host/host.js'), bundleRoot: path.join(directory, 'bundle'), manifest };
  }
  async installVersion(staged) {
    return this.#locked(async () => {
      const reviewId = path.basename(path.dirname(staged.bundleRoot));
      const expected = path.join(this.#root, 'quarantine', reviewId, 'bundle');
      assertPin({ schemaVersion: 1, digest: staged.manifest.bundleDigest, reviewId });
      if (staged.bundleRoot !== expected || staged.manifestPath !== path.join(path.dirname(expected), 'staging-manifest.json')) fail('Invalid quarantine path');
      privatePath(path.dirname(expected), true, this.#device);
      const manifest = assertBundleManifest(readCanonical(staged.manifestPath, this.#device));
      if (canonicalJson(manifest) !== canonicalJson(staged.manifest)) fail('Staging manifest digest mismatch');
      await this.#verifyBundle(expected, manifest);
      const pin = { schemaVersion: 1, digest: manifest.bundleDigest, reviewId };
      const final = path.join(this.#root, 'versions', pin.digest);
      if (exists(final)) { const result = await this.#version(pin); this.#recordInstallation(pin); return result; }
      const temp = path.join(this.#root, 'versions', `.pending-${randomUUID()}`);
      fs.mkdirSync(temp, { mode: 0o700 });
      fs.mkdirSync(path.join(temp, 'bundle'), { mode: 0o700 });
      const dirs = new Set([path.join(temp, 'bundle')]);
      for (const file of manifest.files) {
        const dest = path.join(temp, 'bundle', file.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        let dir = path.dirname(dest); while (dir !== temp) { dirs.add(dir); dir = path.dirname(dir); }
        writeNew(dest, readPrivate(path.join(expected, file.path), this.#device), 0o400);
      }
      writeNew(path.join(temp, 'manifest.json'), canonicalJson(manifest) + '\n', 0o400);
      await this.#verifyBundle(path.join(temp, 'bundle'), manifest);
      for (const dir of [...dirs].sort((a,b) => b.length-a.length)) { fs.chmodSync(dir, 0o500); syncDir(dir); }
      fs.chmodSync(temp, 0o500); syncDir(temp);
      if (exists(final)) fail('Existing digest version collision');
      fs.renameSync(temp, final); syncDir(path.dirname(final));
      const result = await this.#version(pin); this.#recordInstallation(pin); return result;
    });
  }
  async activate(decision) {
    decision = snapshotDecision(decision);
    return this.#locked(async () => {
      const old = this.#state();
      if (recoverInterruptedActivation(old).action !== 'none') fail('Activation recovery required');
      const candidate = { schemaVersion: 1, digest: decision.candidateDigest, reviewId: decision.reviewId };
      this.#assertInstalled(candidate);
      await this.#version(candidate);
      const previous = this.#pin('active'); const priorPrevious = this.#pin('previous');
      this.#assertActiveState(old, previous);
      if (previous) await this.#version(previous);
      if (priorPrevious) await this.#version(priorPrevious);
      if (previous?.digest === candidate.digest) fail('Candidate already active');
      if (typeof this.#consume !== 'function') fail('Trusted decision consumer required');
      const proof = await this.#consume(decision);
      if (!proof || proof.consumed !== true || canonicalJson(proof) !== canonicalJson({ ...decision, consumed: true })) fail('Consumed decision mismatch');
      // Recheck custody after the asynchronous coordinator boundary.
      await this.#version(candidate);
      if (previous) await this.#version(previous);
      const decisionHash = sha256Bytes(decision.nonce);
      const used = path.join(this.#root, 'decisions', `${decisionHash}.json`);
      if (exists(used)) fail('Decision nonce already consumed');
      writeNew(used, canonicalJson({ candidate, policyDigest: decision.policyDigest }) + '\n', 0o400); syncDir(path.dirname(used));
      this.#archive(old);
      const state = { schemaVersion: 1, phase: 'prepared', candidate, previous, priorPrevious, decisionHash, failureRef: null };
      this.#save(state);
      this.#atomic('previous/pin.json', previous); state.phase = 'previous-written'; this.#save(state);
      this.#atomic('active/pin.json', candidate); state.phase = 'active-written'; this.#save(state);
      state.phase = 'pending-verification'; this.#save(state); this.#pending = decisionHash;
      return { phase: state.phase, candidate };
    });
  }
  async resolveActiveHost() {
    return this.#locked(async () => {
      const state = this.#state();
      if (recoverInterruptedActivation(state).action !== 'none' && !(state.phase === 'pending-verification' && this.#pending === state.decisionHash)) fail('Activation recovery required');
      const pin = this.#pin('active'); if (!pin) fail('No active version');
      this.#assertActiveState(state, pin);
      return this.#version(pin);
    });
  }
  async completeActivation(decision) {
    decision = snapshotDecision(decision);
    if (this.#receipts) fail('Reviewed completion authorization required');
    return this.#locked(async () => {
      const state = this.#state();
      if (state?.phase !== 'pending-verification' || this.#pending !== state.decisionHash || sha256Bytes(decision.nonce) !== state.decisionHash || decision.reviewId !== state.candidate.reviewId || decision.candidateDigest !== state.candidate.digest || !samePin(this.#pin('active'), state.candidate)) fail('Activation completion mismatch');
      const consumed = readCanonical(path.join(this.#root, 'decisions', `${state.decisionHash}.json`), this.#device);
      if (canonicalJson(consumed) !== canonicalJson({ candidate: state.candidate, policyDigest: decision.policyDigest })) fail('Activation completion decision mismatch');
      await this.#version(state.candidate);
      if (this.#runtimeGuard && !this.#runtimeGuard({ ...state.candidate, decisionHash: state.decisionHash })) fail('Pending runtime refresh required before completion');
      state.phase = 'complete'; this.#save(state); this.#pending = null;
      return { phase: 'complete' };
    });
  }
  async #rollback(state, failureRef) {
    // Failed candidate bytes are evidence, never a prerequisite to restoring
    // the independently verified previous runtime. Do not edit or execute B.
    if (state.previous) await this.#version(state.previous);
    state.phase = 'rolling-back'; state.failureRef ??= failureRef; this.#save(state);
    this.#atomic('previous/pin.json', state.previous);
    this.#atomic('active/pin.json', state.previous);
    state.phase = 'rolled-back'; this.#save(state); this.#pending = null;
    return { phase: state.phase, restored: state.previous };
  }
  async rollback(failure) {
    return this.#locked(async () => {
      const state = this.#state();
      if (!state || !['prepared', 'previous-written', 'active-written', 'pending-verification', 'rolling-back', 'complete'].includes(state.phase) || failure?.reviewId !== state.candidate.reviewId || failure?.candidateDigest !== state.candidate.digest || !/^[A-Za-z0-9_-]{1,128}$/.test(failure?.failureRef ?? '')) fail('Rollback failure identity mismatch');
      if (await this.#committedCompletion(state)) fail('Committed activation cannot roll back');
      return this.#rollback(state, failure.failureRef);
    });
  }
  async recover() {
    return this.#locked(async () => {
      const state = this.#state();
      if (state && await this.#committedCompletion(state)) {
        if (!samePin(this.#pin('active'), state.candidate)) fail('Committed activation pin mismatch');
        await this.#version(state.candidate);
        if (state.phase !== 'complete') { state.phase = 'complete'; this.#save(state); }
        this.#pending = null; this.#recovered = null;
        return { action: 'completed', candidate: state.candidate };
      }
      if (recoverInterruptedActivation(state).action === 'none') return { action: 'none' };
      return this.#rollback(state, 'interrupted-activation');
    });
  }
  bindRuntimeGuard(guard) {
    if (this.#runtimeGuard || typeof guard !== 'function') fail('Runtime guard already bound or invalid');
    this.#runtimeGuard = guard;
  }
  bindReceiptStore(receipts) {
    if (!receipts || typeof receipts.verifyChain !== 'function' || (this.#receipts && this.#receipts !== receipts)) fail('Invalid receipt custody binding');
    this.#receipts = receipts;
  }
  async #committedCompletion(state) {
    const file = path.join(this.#root, 'completions', `${state.decisionHash}.json`);
    if (!this.#receipts) { if (exists(file)) fail('Receipt custody required for completion recovery'); return null; }
    const chain = await this.#receipts.verifyChain();
    if (chain.state !== 'intact') fail('Completion receipt custody broken');
    const receipt = chain.receipts.findLast(r => r.reviewId === state.candidate.reviewId && r.eventType === 'activated');
    if (!receipt) return null;
    if (!exists(file)) fail('Committed activation witness missing');
    const witness = readCanonical(file, this.#device);
    const binding = snapshotRecoveryBinding(witness.binding);
    const observed = completionWitness(binding, { runtime: witness.runtime, ownershipPolicy: witness.ownershipPolicy, osEvidence: witness.osEvidence });
    if (canonicalJson(witness) !== canonicalJson(observed) || binding.nonceDigest !== state.decisionHash || binding.reviewId !== state.candidate.reviewId || binding.candidateDigest !== state.candidate.digest || receipt.humanDecisionRef !== state.decisionHash || receipt.candidateBundleDigest !== state.candidate.digest || receipt.policySnapshotHash !== binding.policyDigest || receipt.activeBundleDigest !== state.previous?.digest || receipt.osEvidenceHash !== witness.osEvidenceHash) fail('Committed activation authorization mismatch');
    const consumed = readCanonical(path.join(this.#root, 'decisions', `${state.decisionHash}.json`), this.#device);
    if (canonicalJson(consumed) !== canonicalJson({ candidate: state.candidate, policyDigest: binding.policyDigest })) fail('Committed activation consumption mismatch');
    return receipt;
  }
  async verifyCompletedActivation({ reviewId, candidateDigest, nonceDigest }) {
    return this.#locked(async () => {
      const state = this.#state();
      if (state?.phase !== 'complete' || state.candidate.reviewId !== reviewId || state.candidate.digest !== candidateDigest || state.decisionHash !== nonceDigest || !samePin(this.#pin('active'), state.candidate)) fail('Activation is not durably complete');
      const receipt = await this.#committedCompletion(state);
      if (!receipt) fail('Canonical activation receipt required');
      await this.#version(state.candidate);
      return { phase: 'complete', receiptHash: receipt.receiptHash };
    });
  }
  async resolvePendingHost(decision) {
    decision = snapshotDecision(decision);
    return this.#locked(async () => {
      const state = this.#state();
      if (state?.phase !== 'pending-verification' || state.decisionHash !== this.#pending || state.decisionHash !== sha256Bytes(decision.nonce) || state.candidate.digest !== decision.candidateDigest || state.candidate.reviewId !== decision.reviewId || !samePin(this.#pin('active'), state.candidate)) fail('Pending refresh decision mismatch');
      const consumed = readCanonical(path.join(this.#root, 'decisions', `${state.decisionHash}.json`), this.#device);
      if (consumed.policyDigest !== decision.policyDigest) fail('Pending refresh policy mismatch');
      return this.#version(state.candidate);
    });
  }
  async #recoveryBinding(binding) {
    const state = this.#state();
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || state?.phase !== 'pending-verification' || binding.expiresAt <= now || state.decisionHash !== binding.nonceDigest || state.candidate.digest !== binding.candidateDigest || state.candidate.reviewId !== binding.reviewId || !samePin(this.#pin('active'), state.candidate) || !samePin(this.#pin('previous'), state.previous)) fail('Pending recovery binding mismatch');
    this.#assertInstalled(state.candidate);
    const consumed = readCanonical(path.join(this.#root, 'decisions', `${state.decisionHash}.json`), this.#device);
    if (canonicalJson(consumed) !== canonicalJson({ candidate: state.candidate, policyDigest: binding.policyDigest })) fail('Pending recovery consumption mismatch');
    if (typeof this.#verifyConsumed !== 'function') fail('Trusted consumed decision verifier required');
    const proof = await this.#verifyConsumed(binding);
    if (canonicalJson(proof) !== canonicalJson({ ...binding, consumed: true })) fail('Pending recovery proof mismatch');
    await this.#version(state.candidate);
    if (state.previous) await this.#version(state.previous);
    if (canonicalJson(this.#state()) !== canonicalJson(state) || !samePin(this.#pin('active'), state.candidate) || !samePin(this.#pin('previous'), state.previous) || canonicalJson(readCanonical(path.join(this.#root, 'decisions', `${state.decisionHash}.json`), this.#device)) !== canonicalJson(consumed) || binding.expiresAt <= this.#clock()) fail('Pending recovery custody changed');
    return state;
  }
  async resumePendingActivation(binding) {
    binding = snapshotRecoveryBinding(binding);
    return this.#locked(async () => {
      const state = await this.#recoveryBinding(binding);
      this.#pending = state.decisionHash; this.#recovered = binding;
      return { phase: state.phase, candidate: state.candidate };
    });
  }
  async resolveRecoveredHost(binding) {
    binding = snapshotRecoveryBinding(binding);
    return this.#locked(async () => {
      if (canonicalJson(this.#recovered) !== canonicalJson(binding) || this.#pending !== binding.nonceDigest) fail('Pending recovery not rehydrated');
      const state = await this.#recoveryBinding(binding);
      return this.#version(state.candidate);
    });
  }
  async #completeReviewed(binding, authorization, finalizeActivation, recovered) {
    if (!this.#runtimeGuard) fail('Owning runtime guard required');
    if (!this.#receipts || typeof finalizeActivation !== 'function' || !authorization) fail('Completion authorization required');
    if (this.#pending !== binding.nonceDigest || (recovered && canonicalJson(this.#recovered) !== canonicalJson(binding))) fail('Pending recovery not rehydrated');
    const state = await this.#recoveryBinding(binding);
    const witness = completionWitness(binding, authorization);
    const ownsRuntime = () => this.#runtimeGuard({ ...state.candidate, decisionHash: state.decisionHash, pid: witness.runtime.pid, threadId: witness.runtime.threadId }) === true;
    if (!ownsRuntime()) fail('Pending runtime refresh required before completion');
    const file = path.join(this.#root, 'completions', `${state.decisionHash}.json`);
    if (exists(file)) {
      if (canonicalJson(readCanonical(file, this.#device)) !== canonicalJson(witness)) fail('Completion witness changed');
    } else { writeNew(file, canonicalJson(witness) + '\n', 0o400); syncDir(path.dirname(file)); }
    // The witness is durable before the canonical event. An interrupted append
    // leaves pending state; a committed event is idempotently reconciled by recover.
    let receipt = await this.#committedCompletion(state);
    if (!receipt) {
      if (!ownsRuntime()) fail('Pending runtime refresh cancelled before completion');
      await this.#receipts.withCommitGuard(ownsRuntime, finalizeActivation);
      receipt = await this.#committedCompletion(state);
    }
    if (!receipt) fail('Canonical activation receipt required');
    state.phase = 'complete'; this.#save(state); this.#pending = null; this.#recovered = null;
    return { phase: 'complete', receiptHash: receipt.receiptHash };
  }
  async completeReviewedActivation(binding, authorization, finalizeActivation) {
    binding = snapshotRecoveryBinding(binding);
    authorization = JSON.parse(canonicalJson(authorization));
    return this.#locked(() => this.#completeReviewed(binding, authorization, finalizeActivation, false));
  }
  async completeRecoveredActivation(binding, authorization, finalizeActivation) {
    binding = snapshotRecoveryBinding(binding);
    if (!this.#runtimeGuard) fail('Owning runtime guard required');
    if (!authorization) fail('Completion authorization required');
    authorization = JSON.parse(canonicalJson(authorization));
    return this.#locked(() => this.#completeReviewed(binding, authorization, finalizeActivation, true));
  }
}
