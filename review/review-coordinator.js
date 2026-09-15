import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Bytes, sha256Json } from './canonical-json.js';
import { transitionReview, terminalReview } from './review-state.js';
import { snapshotHumanDecision } from './decision-nonce.js';
import { snapshotRecoveryBinding } from '../bootstrap/recovery-state.js';
import { sanitizeEvidence } from './redaction.js';
import { verifyOwnershipTopology, assertOwnershipPolicy } from './process-ownership.js';
import { CustodyError, CompletionCancelledError } from './receipt-store.js';

const POLICY = JSON.parse(readFileSync(new URL('../policy/review-policy.v1.json', import.meta.url), 'utf8'));
const POLICY_DIGEST = sha256Json(POLICY);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clone = value => JSON.parse(canonicalJson(value));
const boundRecovery = proof => snapshotRecoveryBinding(Object.fromEntries(['reviewId', 'candidateDigest', 'policyDigest', 'nonceDigest', 'threadId', 'expiresAt'].map(k => [k, proof[k]])));

// Dependency functions are configured by the trusted launcher. Browser messages
// never select them. This class owns no transport and never stops A for review.
export class ReviewCoordinator {
  #d; #state = null; #review = null; #tail = null; #initialized = false; #fresh = false; #busy = false; #halted = false;
  #active = null; #staged = null; #decisionHash = null; #grant = null; #proofGiven = false;
  #project = { activeVersion: {}, candidateVersion: {}, sourceHashes: {}, dependencyLock: {}, testResults: {} };
  #os = { before: {}, verification: {}, after: {} }; #attestation = null; #afterPolicy = null;
  constructor(deps = {}) {
    for (const [object, methods] of [[deps.receiptStore, ['verifyChain', 'finalizeEvent']], [deps.nonceStore, ['issue', 'consume', 'recover']], [deps.versionStore, ['resolveActiveHost', 'installVersion', 'activate', 'rollback', 'recover', 'completeActivation', 'resumePendingActivation', 'resolveRecoveredHost', 'completeRecoveredActivation']], [deps.candidateSource, ['inspect', 'stage']], [deps.runtime, ['snapshot', 'refreshPending', 'refreshRecovered', 'stopCandidate', 'restartPrevious', 'withTransition']]]) {
      if (!object || methods.some(m => typeof object[m] !== 'function')) throw new TypeError('Trusted coordinator dependencies required');
    }
    if (['deterministicReview', 'codexReview', 'collectEvidence', 'ownershipPolicy'].some(k => typeof deps[k] !== 'function')) throw new TypeError('Trusted coordinator dependencies required');
    if (sha256Json(deps.policy ?? POLICY) !== POLICY_DIGEST) throw new TypeError('Unsupported coordinator policy');
    this.#d = { ...deps, policy: clone(POLICY), reviewId: deps.reviewId ?? randomUUID };
    this.#d.versionStore.bindReceiptStore(this.#d.receiptStore);
  }
  get state() { return this.#state; }
  async #exclusive(operation) {
    if (this.#busy) throw new Error('Review operation already in progress');
    this.#busy = true;
    try { await this.#initialize(); await this.#integrity(); return await operation(); }
    finally { this.#busy = false; }
  }
  async #initialize() {
    if (this.#initialized) return;
    const chain = await this.#d.receiptStore.verifyChain();
    if (chain.state !== 'intact') { this.#halted = true; throw new CustodyError(); }
    const states = new Map();
    for (const r of chain.receipts) {
      const previous = states.get(r.reviewId);
      try {
        transitionReview(previous?.eventType ?? null, r.eventType);
        if (previous && (previous.candidateBundleDigest !== r.candidateBundleDigest || previous.activeBundleDigest !== r.activeBundleDigest || previous.policySnapshotHash !== r.policySnapshotHash)) throw new Error();
      } catch { this.#halted = true; throw new CustodyError('Review transition history invalid'); }
      states.set(r.reviewId, r);
      if (r.eventType === 'custody-broken') this.#halted = true;
    }
    const last = chain.receipts.at(-1);
    if (last) {
      this.#state = last.eventType; this.#review = { reviewId: last.reviewId, candidateDigest: last.candidateBundleDigest, policyDigest: last.policySnapshotHash, activeDigest: last.activeBundleDigest };
      this.#decisionHash = last.humanDecisionRef ?? null;
    }
    this.#tail = chain.tailHash; this.#initialized = true;
  }
  async #integrity() {
    if (this.#halted) throw new CustodyError();
    const chain = await this.#d.receiptStore.verifyChain();
    if (chain.state !== 'intact' || chain.tailHash !== this.#tail) { this.#halted = true; throw new CustodyError(); }
    if (this.#d.currentPolicy && sha256Json(this.#d.currentPolicy()) !== POLICY_DIGEST) {
      if (this.#state && !terminalReview(this.#state)) await this.#move('custody-broken', 'policy-changed', false);
      this.#halted = true; throw new CustodyError('Policy changed');
    }
  }
  async #move(next, reasonCode, check = true) {
    transitionReview(this.#state, next);
    if (check) await this.#integrity();
    const testResults = clone(this.#project.testResults);
    if (reasonCode) testResults.checks = [...(testResults.checks ?? []), { name: 'review-lifecycle', passed: false, reasonCode }];
    const input = { reviewId: this.#review.reviewId, eventType: next, outcome: next, verifierIdentities: [{ name: 'review-coordinator', version: '1' }], activeBundleDigest: this.#review.activeDigest, candidateBundleDigest: this.#review.candidateDigest, projectEvidence: { ...this.#project, testResults }, osEvidence: this.#os, attestation: this.#attestation,
      ...(this.#decisionHash ? { humanDecisionRef: this.#decisionHash } : {}) };
    // State changes only after canonical finalization. A failure halts all later
    // mutations; never append a replacement receipt over a broken chain.
    let receipt;
    try { receipt = await this.#d.receiptStore.finalizeEvent(input); }
    catch (error) { if (error instanceof CompletionCancelledError) throw error; this.#halted = true; throw new CustodyError('Receipt finalization failed'); }
    if (receipt.eventType !== next || receipt.reviewId !== this.#review.reviewId || receipt.previousReceiptHash !== this.#tail) { this.#halted = true; throw new CustodyError(); }
    this.#tail = receipt.receiptHash; this.#state = next;
    if (next === 'custody-broken') this.#halted = true;
    return receipt;
  }
  #view(extra = {}) { return { state: this.#state, ...(this.#review ? { reviewId: this.#review.reviewId, candidateDigest: this.#review.candidateDigest } : {}), ...extra }; }
  async #available() {
    if (this.#state && !terminalReview(this.#state)) return this.#view();
    this.#active = await this.#d.versionStore.resolveActiveHost();
    const candidate = await this.#d.candidateSource.inspect({ activeDigest: this.#active.digest, policy: clone(POLICY) });
    if (candidate.state !== 'available') return { state: 'unavailable' };
    const candidateDigest = candidate.digest ?? candidate.manifest?.bundleDigest;
    if (!digest(candidateDigest) || candidateDigest === this.#active.digest) throw new Error('Invalid candidate binding');
    const reviewId = this.#d.reviewId(); if (typeof reviewId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(reviewId)) throw new Error('Invalid review identity');
    const chain = await this.#d.receiptStore.verifyChain();
    if (chain.receipts.some(r => r.reviewId === reviewId)) throw new Error('Review identity already used');
    this.#review = { reviewId, candidateDigest, policyDigest: POLICY_DIGEST, activeDigest: this.#active.digest };
    this.#state = null; this.#fresh = true; this.#decisionHash = null; this.#attestation = null; this.#staged = null;
    this.#project = { activeVersion: clone(this.#active.manifest), candidateVersion: { bundleDigest: candidateDigest }, sourceHashes: {}, dependencyLock: {}, testResults: {} };
    this.#os = { before: {}, verification: {}, after: {} };
    await this.#move('available'); return this.#view();
  }
  checkAvailability() { return this.#exclusive(() => this.#available()); }
  async #evidence(phase, runtime) {
    try {
    const policy = clone(assertOwnershipPolicy(this.#d.ownershipPolicy(phase, runtime)));
    if (policy.phase !== phase || policy.chromeExited) throw new Error('Invalid live evidence policy');
    if (runtime && policy.processes.find(p => p.name === 'active-host')?.pid !== runtime.pid) throw new Error('Post-refresh PID mismatch');
    const evidence = sanitizeEvidence(await this.#d.collectEvidence(clone(policy)), POLICY);
    this.#os[phase] = evidence;
    if (!verifyOwnershipTopology(evidence, policy).passed) throw new Error('Ownership topology failed');
    if (phase === 'after') this.#afterPolicy = policy;
    return evidence;
    } catch { throw new CustodyError('Ownership evidence failed'); }
  }
  #boundResult(result) {
    return result?.passed === true && result.activeBundleDigest === this.#review.activeDigest && result.candidateBundleDigest === this.#review.candidateDigest && result.policySnapshotHash === POLICY_DIGEST;
  }
  startReview() { return this.#exclusive(async () => {
    if (!this.#state || terminalReview(this.#state)) await this.#available();
    if (this.#state !== 'available' || !this.#fresh) throw new Error('Review state requires a fresh review');
    try {
      this.#staged = await this.#d.candidateSource.stage({ reviewId: this.#review.reviewId, policy: clone(POLICY) });
      if (this.#staged.manifest.bundleDigest !== this.#review.candidateDigest) throw new Error('Candidate changed');
      this.#project.candidateVersion = clone(this.#staged.manifest);
      this.#project.sourceHashes = { files: clone(this.#staged.manifest.files) };
      this.#project.dependencyLock = clone(this.#staged.manifest.dependencies);
      await this.#move('staged');
      await this.#evidence('before', this.#d.runtime.snapshot());
      await this.#move('deterministic-review');
      const deterministic = sanitizeEvidence(await this.#d.deterministicReview({ ...this.#d.deterministicInput, staged: this.#staged, active: this.#active, policy: clone(POLICY) }), POLICY);
      this.#project.testResults = deterministic;
      if (!this.#boundResult(deterministic) || !Array.isArray(deterministic.checks) || deterministic.checks.length === 0 || deterministic.checks.some(c => c.passed !== true)) {
        await this.#move('review-failed', 'deterministic-failed'); return this.#view();
      }
      let finalized = false;
      let verificationBinding = null;
      const sampleVerifier = async identity => {
        if (verificationBinding !== null || !identity || Object.keys(identity).sort().join(',') !== 'executablePath,executableSha256,pid' || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || typeof identity.executablePath !== 'string' || !digest(identity.executableSha256)) throw new Error('Invalid verifier process binding');
        const runtime = this.#d.runtime.snapshot();
        const evidence = await this.#evidence('verification', { ...runtime, verifier: clone(identity) });
        const process = evidence.processes?.find(item => item.name === 'verifier');
        if (!process || process.pid !== identity.pid || process.executableDigest !== identity.executableSha256) throw new Error('Verifier evidence identity mismatch');
        verificationBinding = { ...clone(identity), evidenceDigest: sha256Json(evidence) };
        return clone(verificationBinding);
      };
      const boundVerification = result => verificationBinding !== null && result?.verifierIdentities?.some(identity => identity?.name === 'codex-process-evidence' && identity.sha256 === sha256Json(verificationBinding));
      const codex = await this.#d.codexReview({ ...this.#d.codexInput, active: clone(this.#active.manifest), candidate: clone(this.#staged.manifest), deterministic, policy: clone(POLICY), sampleVerifier, finalizeResult: async result => {
        if (finalized) throw new Error('Duplicate Codex finalization');
        const safe = sanitizeEvidence(result, POLICY);
        if (!boundVerification(safe)) throw new Error('Unbound verifier evidence');
        this.#attestation = safe.attestation ?? null;
        this.#project.testResults.verifierIdentities = [...(this.#project.testResults.verifierIdentities ?? []), ...(safe.verifierIdentities ?? [])];
        this.#project.testResults.checks.push({ name: 'codex-result', passed: safe.passed === true, ...(digest(safe.outputDigest) ? { outputDigest: safe.outputDigest } : {}) });
        await this.#move('codex-review'); finalized = true;
      } });
      if (!finalized) await this.#move('codex-review');
      // Task 5 can downgrade its result during cleanup AFTER finalizeResult.
      // Only its final return can grant eligibility.
      if (!finalized || !boundVerification(codex) || !this.#boundResult(codex) || codex.reasonCode !== 'codex-favorable' || codex.attestation?.verdict !== 'favorable' || canonicalJson(codex.attestation) !== canonicalJson(this.#attestation)) {
        const reason = codex?.reasonCode === 'cleanup-failed' ? 'cleanup-failed' : 'codex-failed';
        await this.#move('review-failed', reason); return this.#view();
      }
      await this.#move('eligible');
      const runtime = this.#d.runtime.snapshot();
      if (!runtime?.threadId) { await this.#move('custody-broken', 'session-unbound'); return this.#view(); }
      const b = { reviewId: this.#review.reviewId, candidateDigest: this.#review.candidateDigest, policyDigest: POLICY_DIGEST };
      return this.#view({ decision: this.#d.nonceStore.issue({ ...b, action: 'accept' }, { threadId: runtime.threadId }), rejection: this.#d.nonceStore.issue({ ...b, action: 'reject' }, { threadId: runtime.threadId }) });
    } catch (error) {
      if (this.#halted) throw error;
      await this.#move(error instanceof CustodyError || ['available', 'eligible'].includes(this.#state) ? 'custody-broken' : 'review-failed', 'review-operation-failed');
      return this.#view();
    }
  }); }
  #decision(value, action) {
    const d = snapshotHumanDecision(value);
    if (d.action !== action) throw new Error('Decision binding mismatch');
    return d;
  }
  #assertBinding(d) {
    if (!this.#fresh || this.#state !== 'eligible') throw new Error('Review state cannot consume decision');
    if (d.reviewId !== this.#review.reviewId || d.candidateDigest !== this.#review.candidateDigest || d.policyDigest !== this.#review.policyDigest) throw new Error('Decision binding mismatch');
  }
  async #consumeHuman(d) {
    try { return this.#d.nonceStore.consume(d); }
    catch (error) {
      if (/expired|restart/.test(error.message)) await this.#move('rejected', 'decision-expired');
      throw error;
    }
  }
  consumeDecision(value) {
    const d = this.#decision(value, 'accept');
    if (this.#halted || this.#state !== 'activating' || this.#proofGiven || !this.#grant || sha256Bytes(d.nonce) !== this.#decisionHash || d.reviewId !== this.#review.reviewId || d.candidateDigest !== this.#review.candidateDigest || d.policyDigest !== POLICY_DIGEST) throw new Error('Consumed decision grant mismatch');
    this.#d.nonceStore.recover(this.#decisionHash); this.#proofGiven = true;
    return { ...d, consumed: true };
  }
  verifyConsumedDecision(value) {
    const b = snapshotRecoveryBinding(value); const proof = this.#d.nonceStore.recover(b.nonceDigest);
    if (this.#halted || this.#state !== 'activating' || this.#decisionHash !== b.nonceDigest || proof.action !== 'accept' || canonicalJson(boundRecovery(proof)) !== canonicalJson(b) || b.reviewId !== this.#review.reviewId || b.candidateDigest !== this.#review.candidateDigest || b.policyDigest !== POLICY_DIGEST) throw new Error('Consumed recovery binding mismatch');
    return { ...b, consumed: true };
  }
  async acceptReview(value) {
    const d = this.#decision(value, 'accept');
    return this.#exclusive(async () => {
      this.#assertBinding(d);
      const active = await this.#d.versionStore.resolveActiveHost();
      const candidate = await this.#d.candidateSource.inspect({ activeDigest: active.digest, policy: clone(POLICY) });
      if (active.digest !== this.#review.activeDigest || (candidate.digest ?? candidate.manifest?.bundleDigest) !== this.#review.candidateDigest || candidate.state !== 'available') { await this.#move('custody-broken', 'candidate-changed'); return this.#view(); }
      await this.#integrity();
      const proof = await this.#consumeHuman(d); this.#grant = proof; this.#proofGiven = false; this.#decisionHash = proof.nonceDigest;
      await this.#move('human-accepted'); await this.#move('activating');
      return this.#d.runtime.withTransition(async owner => {
        try {
          await this.#integrity(); await this.#d.versionStore.installVersion(this.#staged);
          await this.#integrity(); await this.#d.versionStore.activate(d);
          await this.#integrity();
          const runtime = await owner.refreshPending(d);
          const authorization = await this.#postRefresh(runtime, proof, owner);
          await this.#integrity();
          const binding = boundRecovery(proof);
          await this.#d.versionStore.completeReviewedActivation(binding, authorization, () => this.#move('activated'));
          await this.#d.versionStore.verifyCompletedActivation(binding);
          return this.#view();
        } catch (error) { if (this.#halted || this.#state === 'activated') throw error; return this.#rollback('activation-operation-failed', owner); }
        finally { this.#grant = null; }
      });
    });
  }
  async #postRefresh(runtime, proof, owner) {
    const snapshot = clone(runtime);
    if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid < 1 || snapshot.digest !== proof.candidateDigest || snapshot.reviewId !== proof.reviewId || snapshot.threadId !== proof.threadId) throw new Error('Post-refresh runtime binding mismatch');
    await this.#evidence('after', snapshot);
    const live = owner.snapshot();
    for (const k of ['pid', 'digest', 'reviewId', 'threadId']) if (snapshot[k] !== live?.[k]) throw new Error('Runtime changed during post-refresh evidence');
    return { runtime: Object.fromEntries(['pid', 'digest', 'reviewId', 'threadId'].map(k => [k, snapshot[k]])), ownershipPolicy: clone(this.#afterPolicy), osEvidence: clone(this.#os) };
  }
  async #rollback(reasonCode, owner) {
    if (!owner) return this.#d.runtime.withTransition(runtime => this.#rollback(reasonCode, runtime));
    if (this.#state === 'human-accepted') await this.#move('activating');
    if (this.#state === 'activating') await this.#move('activation-failed', reasonCode);
    if (this.#state === 'activation-failed') await this.#move('rolling-back');
    try {
      await this.#integrity(); await owner.stopCandidate();
      // recover handles partial journals and an already-restored bootstrap.
      // Neither recovery nor rollback verifies the failed candidate first.
      await this.#integrity();
      try { await this.#d.versionStore.rollback({ reviewId: this.#review.reviewId, candidateDigest: this.#review.candidateDigest, failureRef: 'activation-failed' }); }
      catch { await this.#d.versionStore.recover(); }
      const pin = await this.#d.versionStore.resolveActiveHost();
      if (pin.digest !== this.#review.activeDigest) throw new Error('Previous pin was not restored');
      await this.#integrity();
      const restored = await owner.restartPrevious();
      if (restored.digest !== this.#review.activeDigest) throw new Error('Previous runtime mismatch');
      await this.#evidence('after', restored);
      const current = owner.snapshot();
      if (current?.pid !== restored.pid || current?.digest !== restored.digest || current?.threadId !== restored.threadId) throw new Error('Restored runtime changed');
      await this.#move('rolled-back'); return this.#view();
    } catch (error) {
      if (this.#halted) throw error;
      await this.#move('custody-broken', 'rollback-failed'); return this.#view();
    }
  }
  async rejectReview(value) {
    const d = this.#decision(value, 'reject');
    return this.#exclusive(async () => {
      this.#assertBinding(d); this.#decisionHash = (await this.#consumeHuman(d)).nonceDigest;
      await this.#move('rejected'); return this.#view();
    });
  }
  resumePendingActivation() { return this.#exclusive(async () => {
    if (this.#state === 'activated') {
      await this.#d.versionStore.recover();
      await this.#d.versionStore.verifyCompletedActivation({ ...this.#review, nonceDigest: this.#decisionHash });
      return this.#view();
    }
    if (!this.#state || terminalReview(this.#state)) return this.#view();
    if (this.#fresh) throw new Error('Recovery requires a restarted coordinator');
    if (this.#state === 'eligible') { await this.#move('rejected', 'restart-decision-expired'); return this.#view(); }
    if (['available', 'staged', 'deterministic-review', 'codex-review'].includes(this.#state)) {
      await this.#move(this.#state === 'available' ? 'custody-broken' : 'review-failed', 'review-interrupted'); return this.#view();
    }
    if (this.#state !== 'activating') return this.#rollback('activation-interrupted');
    return this.#d.runtime.withTransition(async owner => {
      try {
        const proof = this.#d.nonceStore.recover(this.#decisionHash); const binding = boundRecovery(proof);
        this.verifyConsumedDecision(binding);
        await this.#d.versionStore.resumePendingActivation(binding);
        await this.#integrity();
        const runtime = await owner.refreshRecovered(binding);
        const authorization = await this.#postRefresh(runtime, proof, owner);
        await this.#integrity(); await this.#d.versionStore.completeRecoveredActivation(binding, authorization, () => this.#move('activated'));
        await this.#d.versionStore.verifyCompletedActivation(binding);
        return this.#view();
      } catch (error) { if (this.#halted || this.#state === 'activated') throw error; return this.#rollback('activation-interrupted', owner); }
    });
  }); }
  handle(value) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return Promise.reject(new Error('Invalid lifecycle request'));
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== 1 || !descriptors.type || !Object.hasOwn(descriptors.type, 'value') || !descriptors.type.enumerable) return Promise.reject(new Error('Invalid lifecycle request'));
    switch (descriptors.type.value) {
      case 'review.status': return this.checkAvailability();
      case 'review.start': return this.startReview().then(({ decision, rejection, ...view }) => view);
      case 'review.dismiss': return Promise.resolve({ state: 'dismissed' });
      case 'review.open-report': case 'review.continue-in-codex': return Promise.resolve({ state: 'presentation-required' });
      default: return Promise.reject(new Error('Invalid lifecycle request'));
    }
  }
}
