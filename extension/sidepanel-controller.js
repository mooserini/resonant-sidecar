const HOST_NAME = 'com.resonantmirror.sidecar';
const THREAD_STORAGE_KEY = 'codexThreadId';

export class SidecarSession {
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

    const stored = await this.storage.get(THREAD_STORAGE_KEY);
    this.port = this.connectNative(HOST_NAME);
    this.port.onMessage.addListener(message => this.#handleMessage(message));
    this.port.onDisconnect.addListener(() => {
      this.turnActive = false;
      this.port = null;
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

  async whenSettled() {
    await this.pending;
  }

  #handleMessage(message) {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'session.ready' && typeof message.threadId === 'string') {
      this.pending = this.storage.set({ [THREAD_STORAGE_KEY]: message.threadId });
    }
    if (message.type === 'turn.started') this.turnActive = true;
    if (message.type === 'turn.completed' || message.type === 'error') {
      this.turnActive = false;
    }
    this.onEvent(message);
  }
}
