const HOST_NAME = 'com.resonantmirror.sidecar';
const THREAD_STORAGE_KEY = 'codexThreadId';

const lifecycleTypes = new Set(['update.available', 'review.started', 'review.eligible', 'review.failed', 'activation.started', 'activation.completed', 'activation.rolledBack']);
function lifecycleEvent(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid lifecycle event');
  const descriptors = Object.getOwnPropertyDescriptors(value), type = descriptors.type?.value;
  if (!lifecycleTypes.has(type)) throw new Error('Invalid lifecycle event');
  const fields = ['type', 'reviewId', 'candidateDigest', ...(type === 'review.eligible' ? ['policyDigest', 'nonce', 'rejectNonce'] : [])];
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(k => !Object.hasOwn(descriptors, k)) || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) throw new Error('Invalid lifecycle event');
  const event = Object.fromEntries(fields.map(k => [k, descriptors[k].value]));
  for (const key of fields.slice(1)) {
    if (type === 'review.failed' && event.reviewId === null && event.candidateDigest === null) continue;
    const pattern = key === 'reviewId' ? /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/ : key === 'nonce' || key === 'rejectNonce' ? /^[A-Za-z0-9_-]{43}$/ : /^[a-f0-9]{64}$/;
    if (typeof event[key] !== 'string' || !pattern.test(event[key])) throw new Error('Invalid lifecycle event');
  }
  if (type === 'review.eligible' && event.nonce === event.rejectNonce) throw new Error('Invalid lifecycle event');
  structuredClone(value); // rejects proxies; accessors and non-scalars were rejected
  return Object.freeze(event);
}

export class SidecarSession {
  #reviewState = 'idle'; #review = null; #decision = null; #statusRequested = false; #connecting = null;
  get reviewState() { return this.#reviewState; }
  get canNavigateReview() { return this.#reviewState === 'failed' && this.#review !== null; }
  constructor({ connectNative, storage, onEvent = () => {} }) {
    this.connectNative = connectNative;
    this.storage = storage;
    this.onEvent = onEvent;
    this.port = null;
    this.turnActive = false;
    this.pending = Promise.resolve();
  }

  async connect() {
    if (this.port) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect();
    try { await this.#connecting; } finally { this.#connecting = null; }
  }

  async #connect() {
    const stored = await this.storage.get(THREAD_STORAGE_KEY);
    this.port = this.connectNative(HOST_NAME);
    const port = this.port;
    port.onMessage.addListener(message => { if (this.port === port) this.#handleMessage(message); });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.turnActive = false;
      this.port = null;
      this.#reviewState = 'idle'; this.#review = this.#decision = null; this.#statusRequested = false;
      this.onEvent({ type: 'connection.closed' });
    });
    this.port.postMessage({
      type: 'session.open',
      threadId: typeof stored[THREAD_STORAGE_KEY] === 'string'
        ? stored[THREAD_STORAGE_KEY]
        : null,
    });
  }

  sendTurn(text) {
    if (!this.port) throw new Error('Sidecar is not connected');
    if (this.turnActive) throw new Error('A turn is already active');
    this.port.postMessage({ type: 'turn.start', text });
  }

  interrupt() {
    if (!this.port) throw new Error('Sidecar is not connected');
    if (!this.turnActive) throw new Error('There is no active turn');
    this.port.postMessage({ type: 'turn.interrupt' });
  }

  disconnect() {
    if (this.port) this.port.disconnect();
  }

  requestUpdateStatus() {
    if (!this.port || this.#reviewState !== 'idle' || this.#statusRequested) return;
    this.#statusRequested = true;
    this.port.postMessage({ type: 'update.status' });
  }
  #postReview(type, state, extra = {}) {
    if (!this.port || !this.#review) throw new Error('Review action unavailable');
    const message = { type, ...this.#review, ...extra };
    this.#reviewState = state; // linearize the click before sending
    this.port.postMessage(message);
  }
  startReview() {
    if (this.#reviewState !== 'available') throw new Error('Review action unavailable');
    this.#postReview('review.start', 'requested');
  }
  #choose(action) {
    if (this.#reviewState !== 'eligible' || !this.#decision) throw new Error('Review action unavailable');
    const grant = this.#decision; this.#decision = null;
    this.#postReview('review.' + action, action === 'accept' ? 'accepting' : 'rejected', { policyDigest: grant.policyDigest, nonce: action === 'accept' ? grant.nonce : grant.rejectNonce });
  }
  acceptReview() { this.#choose('accept'); }
  rejectReview() { this.#choose('reject'); }
  openReport() {
    if (this.#reviewState !== 'failed') throw new Error('Review action unavailable');
    this.#postReview('review.openReport', 'failed');
  }
  openDesktop() {
    if (this.#reviewState !== 'failed') throw new Error('Review action unavailable');
    this.#postReview('review.openDesktop', 'failed');
  }
  dismissReview() {
    if (!['failed', 'completed', 'rejected'].includes(this.#reviewState)) throw new Error('Review action unavailable');
    this.#reviewState = 'dismissed'; this.#review = this.#decision = null;
  }

  #lifecycle(value) {
    let event;
    try { event = lifecycleEvent(value); } catch { return; }
    const same = this.#review && event.reviewId === this.#review.reviewId && event.candidateDigest === this.#review.candidateDigest;
    if (event.type === 'update.available') {
      if (this.#reviewState !== 'idle' || !this.#statusRequested) return;
      this.#statusRequested = false; this.#review = Object.freeze({ reviewId: event.reviewId, candidateDigest: event.candidateDigest }); this.#reviewState = 'available';
    } else if (event.type === 'review.failed') {
      if ((!same && !(this.#reviewState === 'idle' && this.#statusRequested && event.reviewId === null)) || ['failed', 'completed', 'dismissed'].includes(this.#reviewState)) return;
      this.#reviewState = 'failed'; this.#decision = null; this.#statusRequested = false;
    } else {
      if (!same) return;
      const transitions = { 'review.started': ['requested', 'reviewing'], 'review.eligible': ['reviewing', 'eligible'], 'activation.started': ['accepting', 'activating'], 'activation.completed': ['activating', 'completed'], 'activation.rolledBack': ['activating', 'failed'] };
      const transition = transitions[event.type];
      if (!transition || this.#reviewState !== transition[0]) return;
      this.#reviewState = transition[1];
      this.#decision = event.type === 'review.eligible' ? event : null;
    }
    this.onEvent(event);
  }

  async whenSettled() {
    await this.pending;
  }

  #handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    const type = Object.getOwnPropertyDescriptor(message, 'type')?.value;
    if (typeof type !== 'string') return;
    if (/^(review|update|activation)\./.test(type)) { this.#lifecycle(message); return; }

    if (message.type === 'session.ready' && typeof message.threadId === 'string') {
      this.turnActive = false;
      this.pending = this.storage.set({ [THREAD_STORAGE_KEY]: message.threadId });
    }
    if (message.type === 'turn.started') this.turnActive = true;
    if (message.type === 'turn.completed') {
      this.turnActive = false;
    }
    this.onEvent(message);
  }
}
