import { canonicalJson } from './canonical-json.js';
import { snapshotChromeReviewValue, exactReviewKeys, freezeReviewValue, MAX_EVIDENCE_PACKET_BYTES, MAX_CHROME_ANALYSIS_BYTES } from './chrome-review-contract.js';
import { buildChromeReviewRequest } from './semantic-evidence.js';
import { bindChromeReviewResult } from './chrome-review.js';
import { buildChromeProvenance } from './chrome-provenance.js';

export const CHROME_BINDING_FIELDS = Object.freeze(['reviewId', 'activeDigest', 'candidateDigest', 'policyDigest', 'invocationId', 'runtimeGeneration', 'inputDigest', 'evidenceDigest', 'promptDigest', 'schemaDigest', 'adapterDigest', 'deadline', 'channelId', 'restartId']);
export const CHROME_RESULT_FAILURES = Object.freeze(['api-absent', 'setup-required', 'setup-declined', 'unavailable', 'timeout', 'connection-loss', 'malformed-output', 'provenance-drift', 'custody-failure']);
export const CHROME_CANCEL_REASONS = Object.freeze(['cancellation', 'panel-closure', 'emergency-stop']);
const chromeInvalid = () => { throw new TypeError('Invalid Chrome review message'); };
const messageType = value => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'type')?.value : null;
export function parseChromeBinding(value) {
  const binding = snapshotChromeReviewValue(value); exactReviewKeys(binding, CHROME_BINDING_FIELDS);
  for (const field of CHROME_BINDING_FIELDS) {
    const item = binding[field];
    if (field === 'runtimeGeneration') { if (!Number.isSafeInteger(item) || item < 0) chromeInvalid(); }
    else if (field === 'deadline') { if (typeof item !== 'string' || !Number.isFinite(Date.parse(item)) || new Date(item).toISOString() !== item) chromeInvalid(); }
    else {
      const pattern = field === 'reviewId' ? /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/ : field === 'invocationId' ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ : ['channelId', 'restartId'].includes(field) ? /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/ : /^[a-f0-9]{64}$/;
      if (typeof item !== 'string' || !pattern.test(item)) chromeInvalid();
    }
  }
  return freezeReviewValue(binding);
}
function chromeMessage(value, extra) {
  const message = snapshotChromeReviewValue(value); exactReviewKeys(message, ['type', ...CHROME_BINDING_FIELDS, ...extra]);
  parseChromeBinding(Object.fromEntries(CHROME_BINDING_FIELDS.map(key => [key, message[key]])));
  return message;
}
// Null selects no exception lane. A recognized malformed settlement throws;
// neither case may fall through as a conversation or a lifecycle command.
export function parseChromeSettlement(value) {
  const type = messageType(value);
  if (!['review.chromeResult', 'review.chromeCancel'].includes(type)) return null;
  const message = chromeMessage(value, type === 'review.chromeResult' ? ['rawText', 'reasonCode', 'availabilityStatus', 'executionStatus'] : ['reasonCode', 'availabilityStatus', 'executionStatus']);
  const { availabilityStatus, executionStatus, reasonCode } = message;
  if (!['available', 'api-absent', 'setup-required', 'setup-declined', 'unavailable', 'not-checked'].includes(availabilityStatus) || !['completed', 'failed', 'not-run'].includes(executionStatus)) chromeInvalid();
  if (type === 'review.chromeCancel') { if (!CHROME_CANCEL_REASONS.includes(message.reasonCode)) chromeInvalid(); }
  else if (message.reasonCode === null) {
    if (typeof message.rawText !== 'string' || !message.rawText.isWellFormed() || Buffer.byteLength(message.rawText, 'utf8') > MAX_CHROME_ANALYSIS_BYTES) chromeInvalid();
  } else if (message.rawText !== null || !CHROME_RESULT_FAILURES.includes(message.reasonCode)) chromeInvalid();
  if (reasonCode === null) { if (availabilityStatus !== 'available' || executionStatus !== 'completed') chromeInvalid(); }
  else if (['api-absent', 'setup-required', 'setup-declined', 'unavailable'].includes(reasonCode)) { if (availabilityStatus !== reasonCode || executionStatus !== 'not-run') chromeInvalid(); }
  else if (reasonCode === 'malformed-output') { if (availabilityStatus !== 'available' || executionStatus !== 'failed') chromeInvalid(); }
  else if (executionStatus !== 'not-run' && !(availabilityStatus === 'available' && executionStatus === 'failed')) chromeInvalid();
  return freezeReviewValue(message);
}
export function parseChromeReady(value) {
  if (messageType(value) !== 'review.chromeReady') chromeInvalid();
  const message = chromeMessage(value, ['packet']);
  if (!message.packet || Buffer.byteLength(JSON.stringify(message.packet)) > MAX_EVIDENCE_PACKET_BYTES) chromeInvalid();
  return freezeReviewValue(message);
}


const CLOSE_REASONS = new Set([...CHROME_RESULT_FAILURES, ...CHROME_CANCEL_REASONS]);
const invalid = () => { throw new Error('Chrome review invocation unavailable'); };
function verifyRequest(input) {
  const value = snapshotChromeReviewValue(input); exactReviewKeys(value, ['binding', 'packet', 'deadline']);
  const binding = parseChromeBinding(value.binding); const p = value.packet;
  const request = buildChromeReviewRequest({ evidence: p.evidence, evidenceDigest: p.evidenceDigest, invocationId: p.invocationId, runtimeGeneration: p.runtimeGeneration, adapterDigest: p.adapterDigest, deadline: p.deadline });
  if (request.type !== 'ReadyChromeReviewRequest' || canonicalJson(request.packet) !== canonicalJson(p) || value.deadline !== binding.deadline) invalid();
  const { activeBundleDigest, candidateBundleDigest, promptId, schemaId, ...transport } = request.transportBinding;
  const expected = { ...transport, activeDigest: activeBundleDigest, candidateDigest: candidateBundleDigest, channelId: binding.channelId, restartId: binding.restartId };
  if (canonicalJson(binding) !== canonicalJson(expected)) invalid();
  return { binding, request };
}

/** One outstanding invocation, with no coordinator, path, tool, policy or
 * decision capability. Browser-side analysis never substitutes for the native
 * binder. Task 7 must verify packet/evidence/prompt/schema hashes with Web Crypto
 * before building the browser prompt and bind its current panel/native Port to
 * channelId. IDs bind this channel, not cryptographic model/inference identity. */
export class ChromeReviewBridge {
  #journal; #send; #current; #clock; #observations; #pending = null; #closed = null;
  constructor({ journal, send, currentChannel, clock = Date.now, browserObservation, componentObservation }) {
    if (!journal || typeof send !== 'function' || typeof currentChannel !== 'function' || typeof clock !== 'function') invalid();
    this.#journal = journal; this.#send = send; this.#current = currentChannel; this.#clock = clock;
    const provenance = buildChromeProvenance({ browserObservation, componentObservation });
    this.#observations = { browserObservation: provenance.browserObservation, componentObservation: provenance.componentObservation };
  }
  #invalidated(binding) {
    if (this.#closed) return this.#closed;
    const current = this.#current();
    if (!current || ['channelId', 'restartId', 'runtimeGeneration', 'activeDigest'].some(key => current[key] !== binding[key])) return 'connection-loss';
    if (this.#clock() > Date.parse(binding.deadline)) return 'timeout';
    return null;
  }
  #failure(pending) { return pending.cancelReason ?? this.#invalidated(pending.binding); }
  request(input) {
    let verified;
    try {
      verified = verifyRequest(input);
      if (this.#pending || this.#invalidated(verified.binding)) invalid();
      const remaining = Date.parse(verified.binding.deadline) - this.#clock();
      if (remaining < 0 || remaining > 2147483646) invalid();
    } catch (error) { return Promise.reject(error); }
    let resolve; let reject; const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending = { ...verified, resolve, reject, phase: 'preparing', timer: null, finishing: null, preparation: null };
    this.#pending = pending;
    pending.preparation = (async () => {
      await this.#journal.begin(pending.binding);
      const reason = this.#failure(pending);
      if (reason) { this.#settle(pending, null, reason); return; }
      pending.phase = 'issued';
      pending.timer = setTimeout(() => this.#settle(pending, null, 'timeout'), Math.max(1, Date.parse(pending.binding.deadline) - this.#clock()));
      try { this.#send(parseChromeReady({ type: 'review.chromeReady', ...pending.binding, packet: pending.request.packet })); }
      catch { this.#settle(pending, null, 'connection-loss'); }
    })().catch(() => { pending.phase = 'terminal'; if (this.#pending === pending) this.#pending = null; reject(new Error('Chrome review journal unavailable')); });
    return result;
  }
  handleSettlement(value) {
    let message;
    try { message = parseChromeSettlement(value); } catch { return false; }
    const pending = this.#pending;
    if (!message || !pending || CHROME_BINDING_FIELDS.some(key => message[key] !== pending.binding[key])) return false;
    if (pending.phase === 'settling' && pending.settlementReason === null && !pending.cancelReason && message.type === 'review.chromeCancel') {
      pending.cancelReason = message.reasonCode;
      pending.observedStatus = { availabilityStatus: message.availabilityStatus, executionStatus: message.executionStatus }; return true;
    }
    if (pending.phase !== 'issued') return false;
    const reason = this.#failure(pending);
    if (reason) { this.#settle(pending, null, reason); return false; }
    pending.observedStatus = { availabilityStatus: message.availabilityStatus, executionStatus: message.executionStatus };
    this.#settle(pending, message.type === 'review.chromeResult' ? message.rawText : null, message.reasonCode);
    return true;
  }
  #settle(pending, rawText, reasonCode) {
    if (pending.phase === 'settling' || pending.phase === 'terminal') return;
    pending.phase = 'settling'; pending.settlementReason = reasonCode; clearTimeout(pending.timer);
    pending.finishing = (async () => {
      let result; let reason = this.#failure(pending) ?? reasonCode;
      if (reason === null) {
        try { result = bindChromeReviewResult({ request: pending.request, rawText, ...this.#observations, completedAt: new Date(this.#clock()).toISOString() }); }
        catch { reason = 'malformed-output'; }
      }
      await this.#journal.finish(pending.binding, reason ?? 'completed');
      const interrupted = this.#failure(pending);
      if (interrupted && !reason) { reason = interrupted; result = null; await this.#journal.finish(pending.binding, reason); }
      // The final check and resolution share a synchronous turn. Task 8 must
      // still check live runtime identity through its receipt/eligibility gate.
      if (!reason) {
        const finalReason = this.#failure(pending);
        if (finalReason) { reason = finalReason; result = null; await this.#journal.finish(pending.binding, reason); }
      }
      pending.phase = 'terminal'; if (this.#pending === pending) this.#pending = null;
      // Without a bound adapter settlement, not-checked means the host received
      // no terminal availability observation. Failed describes the invocation;
      // neither scalar asserts whether a browser model session actually ran.
      const status = pending.observedStatus ?? { availabilityStatus: 'not-checked', executionStatus: 'failed' };
      pending.resolve(freezeReviewValue(reason ? { type: 'ChromeReviewFailure', schemaVersion: 2, binding: pending.binding, reasonCode: reason,
        ...status, executionStatus: status.executionStatus === 'completed' ? 'failed' : status.executionStatus, completedAt: new Date(this.#clock()).toISOString() } : { ...result, binding: pending.binding, ...status }));
    })().catch(() => pending.reject(new Error('Chrome review terminal journal unavailable'))).finally(() => { pending.phase = 'terminal'; if (this.#pending === pending) this.#pending = null; });
  }
  async close(reasonCode) {
    if (!CLOSE_REASONS.has(reasonCode)) invalid();
    this.#closed ??= reasonCode;
    await this.cancelPending(this.#closed);
  }
  async cancelPending(reasonCode) {
    if (!CLOSE_REASONS.has(reasonCode)) invalid();
    const pending = this.#pending; if (!pending) return;
    pending.cancelReason ??= reasonCode;
    await pending.preparation;
    if (pending.phase === 'issued') this.#settle(pending, null, pending.cancelReason);
    await pending.finishing;
  }
}
