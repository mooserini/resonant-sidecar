import { randomUUID } from 'node:crypto';
import { readFileSync, constants, openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256Bytes, sha256Json } from './canonical-json.js';
import { transitionReview, terminalReview } from './review-state.js';
import { snapshotHumanDecision } from './decision-nonce.js';
import { snapshotRecoveryBinding } from '../bootstrap/recovery-state.js';
import { sanitizeEvidence, sanitizeSemanticReview } from './redaction.js';
import { assertSupportedReviewPolicy, loadReviewPolicy, reviewPolicyDigest } from './policy-registry.js';
import { buildSourceDiff } from './source-diff.js';
import { buildSemanticEvidence, buildChromeReviewRequest } from './semantic-evidence.js';
import { buildChromeReviewPrompt, CHROME_REVIEW_SCHEMA, snapshotChromeReviewValue } from './chrome-review-contract.js';
import { buildChromeProvenance } from './chrome-provenance.js';
import { bindChromeReviewResult } from './chrome-review.js';
import { parseChromeBinding } from './chrome-review-bridge.js';
import { verifyOwnershipTopology, assertOwnershipPolicy } from './process-ownership.js';
import { CustodyError, CompletionCancelledError } from './receipt-store.js';

const POLICY = JSON.parse(readFileSync(new URL('../policy/review-policy.v1.json', import.meta.url), 'utf8'));
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
  #policyDigest; #chrome = null;
  constructor(deps = {}) {
    for (const [object, methods] of [[deps.receiptStore, ['verifyChain', 'finalizeEvent']], [deps.nonceStore, ['issue', 'consume', 'recover']], [deps.versionStore, ['resolveActiveHost', 'installVersion', 'activate', 'rollback', 'recover', 'completeActivation', 'resumePendingActivation', 'resolveRecoveredHost', 'completeRecoveredActivation']], [deps.candidateSource, ['inspect', 'stage']], [deps.runtime, ['snapshot', 'refreshPending', 'refreshRecovered', 'stopCandidate', 'restartPrevious', 'withTransition']]]) {
      if (!object || methods.some(m => typeof object[m] !== 'function')) throw new TypeError('Trusted coordinator dependencies required');
    }
    if (['deterministicReview', 'codexReview', 'collectEvidence', 'ownershipPolicy'].some(k => typeof deps[k] !== 'function')) throw new TypeError('Trusted coordinator dependencies required');
    const policy = assertSupportedReviewPolicy(deps.policy ?? POLICY);
    if (policy.schemaVersion === 2 && (['chromeReview', 'chromeContext', 'mintChromeInvocation', 'chromeReviewStatus', 'completeChromeReview'].some(key => typeof deps[key] !== 'function') || !deps.chromeJournal || ['recover', 'snapshot', 'markReceipted', 'finish'].some(key => typeof deps.chromeJournal[key] !== 'function') || typeof deps.receiptStore.withCommitGuard !== 'function')) throw new TypeError('Trusted Chrome coordinator dependencies required');
    this.#policyDigest = sha256Json(policy);
    this.#d = { ...deps, policy: clone(policy), clock: deps.clock ?? Date.now, reviewId: deps.reviewId ?? randomUUID };
    this.#d.versionStore.bindReceiptStore(this.#d.receiptStore);
  }
  get state() { return this.#state; }
  get chromeFinalizationPending() { return this.#chrome?.entered === true && this.#chrome.finalized !== true; }
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
        const version = [1, 2].find(version => reviewPolicyDigest(version) === r.policySnapshotHash);
        transitionReview(previous?.eventType ?? null, r.eventType, loadReviewPolicy(version));
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
    if (this.#d.policy.schemaVersion === 2) await this.#recoverChrome(chain);
  }
  async #integrity() {
    if (this.#halted) throw new CustodyError();
    const chain = await this.#d.receiptStore.verifyChain();
    if (chain.state !== 'intact' || chain.tailHash !== this.#tail) { this.#halted = true; throw new CustodyError(); }
    if (this.#d.currentPolicy && sha256Json(this.#d.currentPolicy()) !== this.#policyDigest) {
      if (this.#state && !terminalReview(this.#state, this.#d.policy)) await this.#move('custody-broken', 'policy-changed', false);
      this.#halted = true; throw new CustodyError('Policy changed');
    }
    return chain;
  }
  async #move(next, reasonCode, check = true, semanticReview) {
    transitionReview(this.#state, next, this.#d.policy);
    if (check) await this.#integrity();
    const testResults = clone(this.#project.testResults);
    if (reasonCode) testResults.checks = [...(testResults.checks ?? []), { name: 'review-lifecycle', passed: false, reasonCode }];
    const input = { reviewId: this.#review.reviewId, eventType: next, outcome: next, verifierIdentities: [{ name: 'review-coordinator', version: '1' }], activeBundleDigest: this.#review.activeDigest, candidateBundleDigest: this.#review.candidateDigest, projectEvidence: { ...this.#project, testResults }, osEvidence: this.#os, attestation: this.#attestation,
      ...(this.#decisionHash ? { humanDecisionRef: this.#decisionHash } : {}), ...(semanticReview ? { semanticReview } : {}) };
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
    if (this.#state && !terminalReview(this.#state, this.#d.policy)) return this.#view();
    this.#active = await this.#d.versionStore.resolveActiveHost();
    const candidate = await this.#d.candidateSource.inspect({ activeDigest: this.#active.digest, policy: clone(this.#d.policy) });
    if (candidate.state !== 'available') return { state: 'unavailable' };
    const candidateDigest = candidate.digest ?? candidate.manifest?.bundleDigest;
    if (!digest(candidateDigest) || candidateDigest === this.#active.digest) throw new Error('Invalid candidate binding');
    const reviewId = this.#d.reviewId(); if (typeof reviewId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(reviewId)) throw new Error('Invalid review identity');
    const chain = await this.#d.receiptStore.verifyChain();
    if (chain.receipts.some(r => r.reviewId === reviewId)) throw new Error('Review identity already used');
    this.#review = { reviewId, candidateDigest, policyDigest: this.#policyDigest, activeDigest: this.#active.digest };
    this.#state = null; this.#fresh = true; this.#decisionHash = null; this.#attestation = null; this.#staged = null; this.#chrome = null;
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
    const evidence = sanitizeEvidence(await this.#d.collectEvidence(clone(policy)), this.#d.policy);
    this.#os[phase] = evidence;
    if (!verifyOwnershipTopology(evidence, policy).passed) throw new Error('Ownership topology failed');
    if (phase === 'after') this.#afterPolicy = policy;
    return evidence;
    } catch { throw new CustodyError('Ownership evidence failed'); }
  }
  #boundResult(result) {
    return result?.passed === true && result.activeBundleDigest === this.#review.activeDigest && result.candidateBundleDigest === this.#review.candidateDigest && result.policySnapshotHash === this.#policyDigest;
  }
  async #prepareChrome(deterministic) {
    const context = snapshotChromeReviewValue(this.#d.chromeContext());
    const provenance = buildChromeProvenance({ browserObservation: context.browserObservation, componentObservation: context.componentObservation });
    const runtime = snapshotChromeReviewValue(this.#d.runtime.snapshot());
    if (!runtime?.threadId || runtime.digest !== this.#review.activeDigest || context.activeDigest !== runtime.digest) throw new CustodyError('Chrome runtime unbound');
    const common = buildSemanticEvidence({ reviewId: this.#review.reviewId, activeManifest: this.#active.manifest, candidateManifest: this.#staged.manifest, policy: this.#d.policy, deterministic,
      sourceDiff: await buildSourceDiff({ activeRoot: this.#active.bundleRoot, candidateRoot: this.#staged.bundleRoot, activeManifest: this.#active.manifest, candidateManifest: this.#staged.manifest }) });
    const startedAt = new Date(this.#d.clock()).toISOString();
    const invocationId = this.#d.mintChromeInvocation();
    const retained = await this.#integrity();
    // Even an incomplete request permanently reserves its artifact identity,
    // although it never opens a bridge invocation or a journal entry.
    if (retained.receipts.some(receipt => receipt.semanticReview?.invocationId === invocationId)) throw new CustodyError('Chrome invocation identity already retained');
    const deadline = new Date(Date.parse(startedAt) + this.#d.policy.applicationLimits.readyToResultExpiryMs).toISOString();
    const request = buildChromeReviewRequest({ ...common, invocationId, runtimeGeneration: context.runtimeGeneration, adapterDigest: context.adapterDigest, deadline });
    // Incomplete requests intentionally expose no packet. These hashes are
    // computed from the same trusted complete input, never from model output.
    const binding = parseChromeBinding({ reviewId: this.#review.reviewId, activeDigest: this.#review.activeDigest, candidateDigest: this.#review.candidateDigest, policyDigest: this.#policyDigest,
      invocationId, runtimeGeneration: context.runtimeGeneration, adapterDigest: context.adapterDigest, deadline, channelId: context.channelId, restartId: context.restartId,
      inputDigest: request.inputDigest ?? request.transportBinding.inputDigest, evidenceDigest: common.evidenceDigest,
      promptDigest: sha256Bytes(buildChromeReviewPrompt(common)), schemaDigest: sha256Json(CHROME_REVIEW_SCHEMA) });
    this.#chrome = { context, provenance, runtime, common, request, binding, startedAt, entered: false, finalized: false };
    this.#project.testResults.checks.push({ name: 'chrome-binding', passed: true, outputDigest: sha256Json(binding) });
  }
  #chromeReason() {
    const c = this.#chrome;
    if (!c.finalized) {
      const status = this.#d.chromeReviewStatus(c.binding);
      if (status.terminal !== true) return 'custody-failure';
      if (status.reasonCode !== null) return status.reasonCode;
    }
    const current = snapshotChromeReviewValue(this.#d.chromeContext());
    if (!current || ['channelId', 'restartId', 'runtimeGeneration', 'activeDigest'].some(key => current[key] !== c.binding[key])) return 'connection-loss';
    if (canonicalJson(current) !== canonicalJson(c.context)) return 'provenance-drift';
    const runtime = this.#d.runtime.snapshot();
    if (!runtime || ['digest', 'threadId', 'pid'].some(key => runtime[key] !== c.runtime[key])) return 'connection-loss';
    if (this.#d.clock() > Date.parse(c.binding.deadline)) return 'timeout';
    return null;
  }
  #chromeInputIntact() {
    // Final commit guards cannot await. Read only the manifest's bounded byte
    // count through a no-follow held file, including unchanged source files.
    try {
      for (const [root, manifest] of [[this.#active.bundleRoot, this.#active.manifest], [this.#staged.bundleRoot, this.#staged.manifest]]) {
        for (const file of manifest.files) {
          const name = path.join(root, file.path);
          if (realpathSync(name) !== name) return false;
          const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const before = fstatSync(fd);
            const mode = before.mode & 0o7777;
            if (!before.isFile() || before.size !== file.bytes || (mode & 0o7000) !== 0 || (mode !== file.mode && mode !== 0o400)) return false;
            const bytes = Buffer.alloc(file.bytes + 1); let count = 0;
            while (count < bytes.length) { const read = readSync(fd, bytes, count, bytes.length - count, count); if (!read) break; count += read; }
            const after = fstatSync(fd);
            if (count !== file.bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || sha256Bytes(bytes.subarray(0, count)) !== file.sha256) return false;
          } finally { closeSync(fd); }
        }
      }
      return true;
    } catch { return false; }
  }
  #chromeArtifact({ reasonCode = null, availabilityStatus = 'available', executionStatus = 'completed', analysis = null, completedAt = new Date(this.#d.clock()).toISOString() }) {
    const c = this.#chrome, b = c.binding;
    return sanitizeSemanticReview({ schemaVersion: 2, reviewerId: 'chrome-language-model', evidenceKind: 'semantic-analysis', reviewerRequirement: 'required', ...c.provenance,
      reviewId: b.reviewId, invocationId: b.invocationId, runtimeGeneration: b.runtimeGeneration, activeBundleDigest: b.activeDigest, candidateBundleDigest: b.candidateDigest,
      policySnapshotHash: b.policyDigest, inputDigest: b.inputDigest, promptDigest: b.promptDigest, schemaDigest: b.schemaDigest, adapterDigest: b.adapterDigest,
      coverageStatus: reasonCode === 'incomplete-input' ? 'incomplete-input' : 'complete-input-supplied', availabilityStatus, executionStatus,
      reasonCode: reasonCode === 'emergency-stop' ? 'cancellation' : reasonCode === 'interrupted-restart' ? 'browser-restart' : reasonCode,
      startedAt: c.startedAt, completedAt, analysis, analysisDigest: analysis === null ? null : sha256Json(analysis), eligibilityEffect: reasonCode === null ? 'prerequisite-satisfied' : 'candidate-withheld',
    }, this.#d.policy);
  }
  #terminalChrome() {
    const record = this.#d.chromeJournal.snapshot();
    if (!record || record.status !== 'terminal' || canonicalJson(record.binding) !== canonicalJson(this.#chrome.binding)) throw new CustodyError('Chrome terminal cleanup unbound');
    return record;
  }
  async #rereadChrome(receipt, artifact) {
    const chain = await this.#d.receiptStore.verifyChain();
    const retained = chain.receipts?.find(r => r.receiptHash === receipt.receiptHash);
    if (chain.state !== 'intact' || chain.tailHash !== this.#tail || !retained || retained.reviewId !== this.#review.reviewId || retained.semanticReviewsHash !== sha256Json(artifact) || canonicalJson(retained.semanticReview) !== canonicalJson(artifact)) {
      this.#halted = true; throw new CustodyError('Chrome receipt reread mismatch');
    }
    return retained;
  }
  async #runChrome() {
    const c = this.#chrome;
    await this.#move('chrome-semantic-review'); c.entered = true;
    let value, artifact;
    try { value = snapshotChromeReviewValue(await this.#d.chromeReview({ binding: c.binding, packet: c.request.packet, deadline: c.binding.deadline })); }
    catch { value = null; }
    const terminal = this.#terminalChrome();
    // A terminal failure is canonical. Later source drift can withhold a
    // completed result, but cannot relabel an already failed invocation.
    let reason = terminal.reasonCode !== 'completed' ? terminal.reasonCode : this.#chromeInputIntact() ? this.#chromeReason() : 'provenance-drift';
    if (!reason && (!value || canonicalJson(value.binding) !== canonicalJson(c.binding))) reason = 'provenance-drift';
    if (!reason && value.type === 'ChromeReviewResult') {
      try {
        const bound = bindChromeReviewResult({ request: c.request, rawText: canonicalJson(value.analysis), browserObservation: c.provenance.browserObservation, componentObservation: c.provenance.componentObservation, completedAt: value.completedAt });
        const { binding, availabilityStatus, executionStatus, ...result } = value;
        if (canonicalJson(result) !== canonicalJson(bound) || availabilityStatus !== 'available' || executionStatus !== 'completed' || terminal.reasonCode !== 'completed') throw new Error();
        const outcome = bound.analysis.outcome;
        artifact = this.#chromeArtifact({ analysis: bound.analysis, completedAt: bound.completedAt, reasonCode: outcome === 'no-blocking-concern' ? null : outcome === 'blocking-concern' ? 'unfavorable-analysis' : 'inconclusive-analysis' });
      } catch { reason = 'sanitization-failure'; }
    } else if (!reason && value.type === 'ChromeReviewFailure' && value.schemaVersion === 2 && value.reasonCode === terminal.reasonCode) {
      try { artifact = this.#chromeArtifact(value); } catch { reason = 'sanitization-failure'; }
    } else reason ??= 'provenance-drift';
    if (reason) {
      const status = this.#d.chromeReviewStatus(c.binding);
      // A first terminal failure and its status come from the exact-bound
      // native owner, even if the returned result envelope later drifts.
      const observed = terminal.reasonCode !== 'completed' || (value?.type === 'ChromeReviewFailure' && canonicalJson(value.binding) === canonicalJson(c.binding) && reason === value.reasonCode);
      artifact = this.#chromeArtifact({ reasonCode: reason, availabilityStatus: observed ? status.availabilityStatus : 'not-checked', executionStatus: observed && status.executionStatus === 'not-run' ? 'not-run' : 'failed' });
    }
    const favorable = artifact.eligibilityEffect === 'prerequisite-satisfied';
    let receipt;
    if (favorable) {
      try {
        receipt = await this.#d.receiptStore.withCommitGuard(() => this.#chromeReason() === null && this.#chromeInputIntact(),
          () => this.#move('eligible', undefined, true, artifact));
      } catch (error) {
        if (!(error instanceof CompletionCancelledError)) throw error;
        reason = this.#chromeInputIntact() ? this.#chromeReason() ?? 'cancellation' : 'provenance-drift';
        artifact = this.#chromeArtifact({ reasonCode: reason, availabilityStatus: 'not-checked', executionStatus: 'failed' });
      }
    }
    if (!receipt) {
      const record = this.#terminalChrome();
      if (record.reasonCode === 'completed' && ['cancellation', 'emergency-stop', 'panel-closure', 'connection-loss', 'timeout', 'provenance-drift'].includes(reason)) await this.#d.chromeJournal.finish(c.binding, reason);
      receipt = await this.#move('review-failed', artifact.reasonCode, true, artifact);
    }
    await this.#rereadChrome(receipt, artifact);
    await this.#d.chromeJournal.markReceipted(receipt.receiptHash);
    const marked = this.#terminalChrome();
    if (!marked.receiptCommitted || marked.receiptHash !== receipt.receiptHash) throw new CustodyError('Chrome receipt mark mismatch');
    await this.#integrity();
    // An eligible receipt records favorable prerequisites. A cancellation after
    // publication withdraws the attempt with no human decision or nonce.
    const withdrawn = this.#chromeInputIntact() ? this.#chromeReason() : 'provenance-drift';
    if (this.#state === 'eligible' && withdrawn !== null) {
      await this.#move('rejected', withdrawn === 'emergency-stop' ? 'cancellation' : withdrawn); this.#fresh = false;
    }
    // No await separates final live checks, owner retirement and nonce issuance.
    if (this.#state === 'eligible' && (this.#chromeReason() !== null || !this.#chromeInputIntact())) throw new CustodyError('Chrome grant invalidated');
    this.#d.completeChromeReview(c.binding); c.finalized = true;
    if (this.#state !== 'eligible') return this.#view();
    const binding = { reviewId: this.#review.reviewId, candidateDigest: this.#review.candidateDigest, policyDigest: this.#policyDigest };
    return this.#view({ decision: this.#d.nonceStore.issue({ ...binding, action: 'accept' }, { threadId: c.runtime.threadId }), rejection: this.#d.nonceStore.issue({ ...binding, action: 'reject' }, { threadId: c.runtime.threadId }) });
  }
  async #restoreChromeEvidence(receipt) {
    const projectFiles = { activeVersion: 'active-version.json', candidateVersion: 'candidate-version.json', sourceHashes: 'source-hashes.json', dependencyLock: 'dependency-lock.json', testResults: 'test-results.json' };
    const files = Object.values(projectFiles).map(name => `project/${name}`).concat('report.md', 'attestation.json', ...['before', 'verification', 'after'].map(phase => `os/${phase}/evidence.json`));
    const bytes = Object.fromEntries(await Promise.all(files.map(async name => [name, await readFile(path.join(receipt.directory, name), { flag: constants.O_RDONLY | constants.O_NOFOLLOW })])));
    const hashes = prefix => sha256Json(Object.fromEntries(files.filter(name => prefix === 'os' ? name.startsWith('os/') : !name.startsWith('os/')).map(name => [name, sha256Bytes(bytes[name])])));
    if (hashes('project') !== receipt.projectEvidenceHash || hashes('os') !== receipt.osEvidenceHash) throw new CustodyError('Chrome recovery evidence changed');
    this.#project = Object.fromEntries(Object.entries(projectFiles).map(([key, file]) => [key, JSON.parse(bytes[`project/${file}`])]));
    this.#os = Object.fromEntries(['before', 'verification', 'after'].map(phase => [phase, JSON.parse(bytes[`os/${phase}/evidence.json`])]));
    this.#attestation = JSON.parse(bytes['attestation.json']);
  }
  async #recoverChrome(chain) {
    try {
      const owners = new Map(), issued = new Set();
      const previous = new Map(), unissuedReviews = new Map();
      const enteredReviews = new Set(chain.receipts.filter(receipt => receipt.policySnapshotHash === reviewPolicyDigest(2) && receipt.eventType === 'chrome-semantic-review').map(receipt => receipt.reviewId));
      for (const receipt of chain.receipts) {
        if (receipt.policySnapshotHash !== reviewPolicyDigest(2)) continue;
        const predecessor = previous.get(receipt.reviewId);
        previous.set(receipt.reviewId, receipt.eventType);
        const artifact = receipt.semanticReview;
        if (!artifact) continue;
        if (!unissuedReviews.has(receipt.reviewId)) unissuedReviews.set(receipt.reviewId, predecessor === 'deterministic-review' && !enteredReviews.has(receipt.reviewId));
        const owner = owners.get(artifact.invocationId);
        if (owner && owner !== receipt.reviewId) throw new CustodyError('Chrome invocation identity reused');
        owners.set(artifact.invocationId, receipt.reviewId);
        const unissued = unissuedReviews.get(receipt.reviewId) && artifact.reasonCode === 'incomplete-input' && artifact.coverageStatus === 'incomplete-input' && artifact.executionStatus === 'not-run' && artifact.availabilityStatus === 'not-checked' && artifact.analysis === null && artifact.analysisDigest === null && artifact.eligibilityEffect === 'candidate-withheld';
        if (!unissued) issued.add(artifact.invocationId);
      }
      await this.#d.chromeJournal.recover();
      const record = this.#d.chromeJournal.snapshot();
      if (!record) {
        if (issued.size || this.#state === 'chrome-semantic-review') throw new CustodyError('Missing Chrome journal');
        return;
      }
      const used = new Set(record.usedInvocationIds);
      const extra = record.usedInvocationIds.filter(id => !issued.has(id));
      // Only the current unfinished invocation can precede its permanent
      // artifact. Historical IDs are never dropped or silently reconstructed.
      if ([...issued].some(id => !used.has(id)) || extra.length > 1 || (extra.length === 1 && (record.receiptCommitted || extra[0] !== record.binding.invocationId || owners.has(extra[0])))) throw new CustodyError('Chrome invocation history conflicts with journal');
      if (record.status !== 'terminal') throw new CustodyError('Chrome invocation still pending');
      const b = record.binding;
      const history = chain.receipts.filter(r => r.reviewId === b.reviewId);
      const anchor = history.find(r => r.eventType === 'chrome-semantic-review');
      if (!anchor || b.policyDigest !== this.#policyDigest || anchor.activeBundleDigest !== b.activeDigest || anchor.candidateBundleDigest !== b.candidateDigest || anchor.policySnapshotHash !== b.policyDigest) throw new CustodyError('Chrome journal anchor mismatch');
      await this.#restoreChromeEvidence(anchor);
      if (!this.#project.testResults.checks?.some(check => check.name === 'chrome-binding' && check.passed === true && check.outputDigest === sha256Json(b))) throw new CustodyError('Chrome journal binding changed');
      const bound = history.find(r => r.semanticReview);
      if (bound) {
        const artifact = bound.semanticReview;
        const fields = { reviewId: 'reviewId', invocationId: 'invocationId', runtimeGeneration: 'runtimeGeneration', activeDigest: 'activeBundleDigest', candidateDigest: 'candidateBundleDigest', policyDigest: 'policySnapshotHash', inputDigest: 'inputDigest', promptDigest: 'promptDigest', schemaDigest: 'schemaDigest', adapterDigest: 'adapterDigest' };
        if (Object.entries(fields).some(([key, field]) => b[key] !== artifact[field]) || sha256Json(artifact) !== bound.semanticReviewsHash || (record.receiptCommitted && record.receiptHash !== bound.receiptHash)) throw new CustodyError('Chrome recovery receipt conflict');
        if (artifact.reasonCode !== 'terminal-receipt-interrupted' && record.reasonCode !== 'completed' && artifact.reasonCode !== ({ 'emergency-stop': 'cancellation', 'interrupted-restart': 'browser-restart' }[record.reasonCode] ?? record.reasonCode)) throw new CustodyError('Chrome recovery reason conflict');
        await this.#d.chromeJournal.markReceipted(bound.receiptHash);
        return;
      }
      if (record.receiptCommitted || history.at(-1)?.eventType !== 'chrome-semantic-review' || chain.receipts.at(-1)?.receiptHash !== anchor.receiptHash) throw new CustodyError('Chrome receipt missing');
      const now = new Date(this.#d.clock()).toISOString();
      this.#chrome = { binding: b, startedAt: now, entered: true, finalized: false, provenance: buildChromeProvenance({
        browserObservation: { executableSha256: null, version: null, signingIdentity: null, observedAt: now, unavailableFields: ['executableSha256', 'version', 'signingIdentity'] },
        componentObservation: { status: 'not-collected', metadataSource: null, version: null, artifactSha256: null, observedAt: null },
      }) };
      const artifact = this.#chromeArtifact({ reasonCode: 'terminal-receipt-interrupted', availabilityStatus: 'not-checked', executionStatus: 'failed' });
      const receipt = await this.#move('review-failed', 'terminal-receipt-interrupted', true, artifact);
      await this.#rereadChrome(receipt, artifact);
      await this.#d.chromeJournal.markReceipted(receipt.receiptHash);
      this.#chrome.finalized = true;
    } catch (error) { this.#halted = true; throw error instanceof CustodyError ? error : new CustodyError('Chrome recovery failed'); }
  }
  startReview() { return this.#exclusive(async () => {
    if (!this.#state || terminalReview(this.#state, this.#d.policy)) await this.#available();
    if (this.#state !== 'available' || !this.#fresh) throw new Error('Review state requires a fresh review');
    try {
      this.#staged = await this.#d.candidateSource.stage({ reviewId: this.#review.reviewId, policy: clone(this.#d.policy) });
      if (this.#staged.manifest.bundleDigest !== this.#review.candidateDigest) throw new Error('Candidate changed');
      this.#project.candidateVersion = clone(this.#staged.manifest);
      this.#project.sourceHashes = { files: clone(this.#staged.manifest.files) };
      this.#project.dependencyLock = clone(this.#staged.manifest.dependencies);
      await this.#move('staged');
      await this.#evidence('before', this.#d.runtime.snapshot());
      await this.#move('deterministic-review');
      const deterministic = sanitizeEvidence(await this.#d.deterministicReview({ ...this.#d.deterministicInput, staged: this.#staged, active: this.#active, policy: clone(this.#d.policy) }), this.#d.policy);
      this.#project.testResults = deterministic;
      if (!this.#boundResult(deterministic) || !Array.isArray(deterministic.checks) || deterministic.checks.length === 0 || deterministic.checks.some(c => c.passed !== true)) {
        await this.#move('review-failed', 'deterministic-failed'); return this.#view();
      }
      if (this.#d.policy.schemaVersion === 2) {
        await this.#prepareChrome(deterministic);
        if (this.#chrome.request.type === 'IncompleteChromeReviewRequest') {
          await this.#move('review-failed', 'incomplete-input', true, this.#chromeArtifact({ reasonCode: 'incomplete-input', availabilityStatus: 'not-checked', executionStatus: 'not-run' }));
          return this.#view();
        }
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
      const codex = await this.#d.codexReview({ ...this.#d.codexInput, ...(this.#chrome ? clone(this.#chrome.common) : {}), active: clone(this.#active.manifest), candidate: clone(this.#staged.manifest), deterministic, policy: clone(this.#d.policy), sampleVerifier, finalizeResult: async result => {
        if (finalized) throw new Error('Duplicate Codex finalization');
        const safe = sanitizeEvidence(result, this.#d.policy);
        if (!boundVerification(safe)) throw new Error('Unbound verifier evidence');
        this.#attestation = safe.attestation ?? null;
        this.#project.testResults.verifierIdentities = [...(this.#project.testResults.verifierIdentities ?? []), ...(safe.verifierIdentities ?? [])];
        this.#project.testResults.checks.push({ name: 'codex-result', passed: safe.passed === true, ...(digest(safe.outputDigest) ? { outputDigest: safe.outputDigest } : {}) });
        await this.#move('codex-review'); finalized = true;
      } });
      if (!finalized) await this.#move('codex-review');
      // Task 5 can downgrade its result during cleanup AFTER finalizeResult.
      // Only its final return can satisfy the Codex prerequisite.
      if (!finalized || !boundVerification(codex) || !this.#boundResult(codex) || codex.reasonCode !== 'codex-favorable' || codex.attestation?.verdict !== 'favorable' || canonicalJson(codex.attestation) !== canonicalJson(this.#attestation)) {
        const reason = codex?.reasonCode === 'cleanup-failed' ? 'cleanup-failed' : 'codex-failed';
        await this.#move('review-failed', reason); return this.#view();
      }
      if (this.#d.policy.schemaVersion === 2) return await this.#runChrome();
      await this.#move('eligible');
      const runtime = this.#d.runtime.snapshot();
      if (!runtime?.threadId) { await this.#move('custody-broken', 'session-unbound'); return this.#view(); }
      const b = { reviewId: this.#review.reviewId, candidateDigest: this.#review.candidateDigest, policyDigest: this.#policyDigest };
      return this.#view({ decision: this.#d.nonceStore.issue({ ...b, action: 'accept' }, { threadId: runtime.threadId }), rejection: this.#d.nonceStore.issue({ ...b, action: 'reject' }, { threadId: runtime.threadId }) });
    } catch (error) {
      if (this.#halted) throw error;
      if (this.chromeFinalizationPending) { this.#halted = true; throw new CustodyError('Chrome finalization incomplete'); }
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
    if (this.#d.policy.schemaVersion === 2 && (!this.#chrome?.finalized || this.#chromeReason() !== null || !this.#chromeInputIntact())) { this.#fresh = false; throw new Error('Chrome decision binding expired'); }
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
    if (this.#halted || this.#state !== 'activating' || this.#proofGiven || !this.#grant || sha256Bytes(d.nonce) !== this.#decisionHash || d.reviewId !== this.#review.reviewId || d.candidateDigest !== this.#review.candidateDigest || d.policyDigest !== this.#policyDigest) throw new Error('Consumed decision grant mismatch');
    this.#d.nonceStore.recover(this.#decisionHash); this.#proofGiven = true;
    return { ...d, consumed: true };
  }
  verifyConsumedDecision(value) {
    const b = snapshotRecoveryBinding(value); const proof = this.#d.nonceStore.recover(b.nonceDigest);
    if (this.#halted || this.#state !== 'activating' || this.#decisionHash !== b.nonceDigest || proof.action !== 'accept' || canonicalJson(boundRecovery(proof)) !== canonicalJson(b) || b.reviewId !== this.#review.reviewId || b.candidateDigest !== this.#review.candidateDigest || b.policyDigest !== this.#policyDigest) throw new Error('Consumed recovery binding mismatch');
    return { ...b, consumed: true };
  }
  async acceptReview(value) {
    const d = this.#decision(value, 'accept');
    return this.#exclusive(async () => {
      this.#assertBinding(d);
      const active = await this.#d.versionStore.resolveActiveHost();
      const candidate = await this.#d.candidateSource.inspect({ activeDigest: active.digest, policy: clone(this.#d.policy) });
      if (active.digest !== this.#review.activeDigest || (candidate.digest ?? candidate.manifest?.bundleDigest) !== this.#review.candidateDigest || candidate.state !== 'available') { await this.#move('custody-broken', 'candidate-changed'); return this.#view(); }
      await this.#integrity();
      this.#assertBinding(d);
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
    if (!this.#state || terminalReview(this.#state, this.#d.policy)) return this.#view();
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
