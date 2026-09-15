export const MAX_TURN_TEXT_BYTES = 32 * 1024;

const BINDING = ['reviewId', 'candidateDigest'];
const DECISION = [...BINDING, 'policyDigest', 'nonce'];
const COMMANDS = new Map([
  ['update.status', []], ['review.start', BINDING], ['review.accept', DECISION],
  ['review.reject', DECISION], ['review.openReport', BINDING], ['review.openDesktop', BINDING],
]);
const EVENTS = new Map([
  ['update.available', BINDING], ['review.started', BINDING],
  ['review.eligible', [...DECISION, 'rejectNonce']], ['review.failed', BINDING],
  ['activation.started', BINDING], ['activation.completed', BINDING], ['activation.rolledBack', BINDING],
]);
const invalid = () => { throw new TypeError('Invalid lifecycle message'); };
export function isLifecycleMessage(value) {
  // Never invoke a type accessor during channel selection.
  const type = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'type')?.value : null;
  return typeof type === 'string' && (type.startsWith('review.') || type.startsWith('update.') || type.startsWith('activation.'));
}
function exactLifecycle(value, shapes) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const type = descriptors.type?.value, fields = shapes.get(type);
  if (!fields) invalid();
  const keys = ['type', ...fields];
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(k => !Object.hasOwn(descriptors, k)) || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) invalid();
  // Structured clone rejects Proxy objects, including transparent proxies.
  // Accessors were rejected first; only scalar own values are read below.
  const result = Object.fromEntries(keys.map(k => [k, descriptors[k].value]));
  const emptyFailure = type === 'review.failed' && result.reviewId === null && result.candidateDigest === null;
  for (const key of fields) {
    if (emptyFailure && BINDING.includes(key)) continue;
    const field = result[key];
    const pattern = key === 'reviewId' ? /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/ : key.endsWith('Nonce') || key === 'nonce' ? /^[A-Za-z0-9_-]{43}$/ : /^[a-f0-9]{64}$/;
    if (typeof field !== 'string' || !pattern.test(field)) invalid();
  }
  if (type === 'review.eligible' && result.nonce === result.rejectNonce) invalid();
  structuredClone(value);
  return Object.freeze(result);
}
export function parseLifecycleEvent(value) { return exactLifecycle(value, EVENTS); }

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(message, keys) {
  const allowed = new Set(keys);
  const extra = Object.keys(message).filter(key => !allowed.has(key));
  if (extra.length > 0) {
    throw new TypeError(`Unsupported field: ${extra[0]}`);
  }
}

export function parseBrowserMessage(value) {
  if (!isRecord(value) || typeof Object.getOwnPropertyDescriptor(value, 'type')?.value !== 'string') {
    throw new TypeError('Browser message must be an object with a type');
  }
  if (isLifecycleMessage(value)) return exactLifecycle(value, COMMANDS);

  if (value.type === 'session.open') {
    assertOnlyKeys(value, ['type', 'threadId']);
    if (value.threadId !== null && typeof value.threadId !== 'string') {
      throw new TypeError('session.open threadId must be a string or null');
    }
    if (typeof value.threadId === 'string') {
      if (value.threadId.length === 0 || value.threadId.length > 256) {
        throw new RangeError('session.open threadId must contain 1 to 256 characters');
      }
    }
    return { type: value.type, threadId: value.threadId };
  }

  if (value.type === 'turn.start') {
    assertOnlyKeys(value, ['type', 'text']);
    if (typeof value.text !== 'string' || value.text.trim().length === 0) {
      throw new TypeError('turn.start text must be non-empty');
    }
    if (Buffer.byteLength(value.text, 'utf8') > MAX_TURN_TEXT_BYTES) {
      throw new RangeError('turn.start text is too large');
    }
    return { type: value.type, text: value.text };
  }

  if (value.type === 'turn.interrupt') {
    assertOnlyKeys(value, ['type']);
    return { type: value.type };
  }

  throw new TypeError('Unsupported browser message type');
}

// Instantiated ONLY by the trusted bootstrap. This adapter has no process,
// filesystem, candidate, or policy authority: all effects go through the
// constructor-bound Task 8 and Task 9 dependencies.
export function createLifecycleRouter({ coordinator, receiptStore, presentation, send, chromeBridge = null }) {
  for (const [object, methods] of [[coordinator, ['checkAvailability', 'startReview', 'acceptReview', 'rejectReview']], [receiptStore, ['verifyChain']], [presentation, ['openReviewReport', 'openChromeDeveloperProject']]]) {
    if (!object || methods.some(k => typeof object[k] !== 'function')) throw new TypeError('Trusted lifecycle dependencies required');
  }
  if (typeof send !== 'function') throw new TypeError('Trusted lifecycle output required');
  let state = 'idle', binding = null, grant = null, rejection = null, busy = false, closed = false;
  const emit = (type, extra = {}) => { if (!closed) send(parseLifecycleEvent({ type, ...(binding ?? { reviewId: null, candidateDigest: null }), ...extra })); };
  const matches = m => binding && BINDING.every(k => m[k] === binding[k]);
  const resultMatches = r => r && matches(r);
  const fail = () => { state = 'failed'; grant = rejection = null; if (coordinator.chromeFinalizationPending !== true) emit('review.failed'); };
  async function navigate(message) {
    const chain = await receiptStore.verifyChain();
    if (closed || chain.state !== 'intact') throw new Error('Review navigation unavailable');
    const receipt = chain.receipts.filter(r => r.reviewId === message.reviewId && r.candidateBundleDigest === message.candidateDigest).at(-1);
    if (!receipt || !['review-failed', 'custody-broken', 'rolled-back', 'activation-failed', 'rejected'].includes(receipt.eventType) || typeof receipt.directory !== 'string') throw new Error('Review navigation unavailable');
    if (message.type === 'review.openReport') await presentation.openReviewReport(`${receipt.directory}/report.md`);
    else await presentation.openChromeDeveloperProject();
    // Task 9 can latch custody-broken; no successful presentation verdict or
    // desktop project-membership assertion is emitted into the browser.
  }
  return Object.freeze({
    close() { closed = true; state = 'closed'; grant = rejection = binding = null; },
    handle(value) {
      // Only the pinned constructor-bound bridge parses and settles this lane.
      const settlementType = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'type')?.value : null;
      if (settlementType === 'review.chromeResult' || settlementType === 'review.chromeCancel') return Promise.resolve(!closed && chromeBridge ? chromeBridge.handleSettlement(value) : false);
      const message = parseBrowserMessage(value); // snapshot before any await
      if (closed || busy) return Promise.resolve();
      const type = message.type;
      if (type === 'update.status' && state !== 'idle') return Promise.resolve();
      if (type !== 'update.status' && !matches(message)) return Promise.resolve();
      if (type === 'review.start' && state !== 'available') return Promise.resolve();
      if (['review.openReport', 'review.openDesktop'].includes(type) && state !== 'failed') return Promise.resolve();
      let decision;
      if (type === 'review.accept' || type === 'review.reject') {
        const expected = type === 'review.accept' ? grant : rejection;
        if (state !== 'eligible' || !expected || DECISION.some(k => expected[k] !== message[k])) return Promise.resolve();
        decision = expected; grant = rejection = null;
        state = type === 'review.accept' ? 'activating' : 'rejected';
      }
      busy = true;
      return (async () => {
        if (type === 'update.status') {
          const view = await coordinator.checkAvailability();
          if (closed || view.state === 'unavailable') return;
          if (view.state !== 'available') { fail(); return; }
          const event = parseLifecycleEvent({ type: 'update.available', reviewId: view.reviewId, candidateDigest: view.candidateDigest });
          binding = Object.freeze({ reviewId: event.reviewId, candidateDigest: event.candidateDigest }); state = 'available'; emit('update.available');
        } else if (type === 'review.start') {
          state = 'reviewing'; emit('review.started');
          const result = await coordinator.startReview();
          if (closed) return;
          if (!resultMatches(result) || result.state !== 'eligible') { fail(); return; }
          const d = result.decision, r = result.rejection;
          if (!d || !r || d.action !== 'accept' || r.action !== 'reject' || !matches(d) || !matches(r) || d.policyDigest !== r.policyDigest) throw new Error('Invalid coordinator grants');
          const event = parseLifecycleEvent({ type: 'review.eligible', ...binding, policyDigest: d.policyDigest, nonce: d.nonce, rejectNonce: r.nonce });
          grant = Object.freeze({ ...binding, policyDigest: event.policyDigest, action: 'accept', nonce: event.nonce });
          rejection = Object.freeze({ ...binding, policyDigest: event.policyDigest, action: 'reject', nonce: event.rejectNonce });
          state = 'eligible'; emit('review.eligible', { policyDigest: event.policyDigest, nonce: event.nonce, rejectNonce: event.rejectNonce });
        } else if (type === 'review.accept') {
          emit('activation.started');
          const result = await coordinator.acceptReview(decision);
          if (closed) return;
          if (!resultMatches(result)) { fail(); return; }
          if (result.state === 'activated') { state = 'completed'; emit('activation.completed'); }
          else if (result.state === 'rolled-back') { state = 'failed'; emit('activation.rolledBack'); }
          else fail();
        } else if (type === 'review.reject') {
          const result = await coordinator.rejectReview(decision);
          if (!closed && (!resultMatches(result) || result.state !== 'rejected')) fail();
        } else if (['review.openReport', 'review.openDesktop'].includes(type)) await navigate(message);
      })().catch(() => { if (!closed) fail(); }).finally(() => { busy = false; });
    },
  });
}
