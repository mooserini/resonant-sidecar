import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

const ZERO_TOOL_INSTRUCTIONS = [
  'This thread is a conversational transport test.',
  'Do not call tools, execute commands, read files, browse, or modify external state.',
  'Reply only with ordinary assistant text.',
].join(' ');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class AppServerClient extends EventEmitter {
  #args;
  #closed = false;
  #command;
  #completedTurns = new Map();
  #cwd;
  #nextRequestId = 1;
  #pending = new Map();
  #process = null;
  #readline = null;
  #threadId = null;
  #turnId = null;
  #turnWaiters = new Map();

  constructor({ command = 'codex', args = ['app-server'], cwd = process.cwd() } = {}) {
    super();
    this.#command = command;
    this.#args = args;
    this.#cwd = cwd;
  }

  get threadId() {
    return this.#threadId;
  }

  get turnId() {
    return this.#turnId;
  }

  async start() {
    if (this.#process) return;
    if (this.#closed) throw new Error('App-server client is closed');

    this.#process = spawn(this.#command, this.#args, {
      cwd: this.#cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#process.once('error', error => this.#failAll(error));
    this.#process.once('exit', (code, signal) => {
      if (this.#closed && code === 0) return;
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      this.#failAll(new Error(`Codex app-server exited with ${detail}`));
    });
    this.#process.stderr.setEncoding('utf8');
    this.#process.stderr.on('data', text => {
      this.emit('event', { type: 'diagnostic', text: String(text).slice(0, 8192) });
    });

    this.#readline = readline.createInterface({ input: this.#process.stdout });
    this.#readline.on('line', line => this.#handleLine(line));

    await this.#request('initialize', {
      clientInfo: {
        name: 'resonant-sidecar',
        title: 'Resonant Sidecar',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: false },
    });
    this.#notify('initialized');
  }

  async openSession(threadId) {
    if (!this.#process) throw new Error('App-server client has not started');
    if (this.#threadId) {
      if (threadId === null || threadId === this.#threadId) return this.#threadId;
      throw new Error('A different Codex thread is already open');
    }

    const common = {
      approvalPolicy: 'never',
      cwd: this.#cwd,
      developerInstructions: ZERO_TOOL_INSTRUCTIONS,
      sandbox: 'readOnly',
    };
    const response = threadId === null
      ? await this.#request('thread/start', { ...common, ephemeral: false })
      : await this.#request('thread/resume', { ...common, threadId, excludeTurns: true });

    const openedThreadId = response?.thread?.id;
    if (typeof openedThreadId !== 'string' || openedThreadId.length === 0) {
      throw new Error('Codex app-server returned no thread id');
    }
    this.#threadId = openedThreadId;
    this.emit('event', { type: 'session.ready', threadId: openedThreadId });
    return openedThreadId;
  }

  async startTurn(text) {
    if (!this.#threadId) throw new Error('No Codex thread is open');
    if (this.#turnId) throw new Error('A Codex turn is already active');

    const response = await this.#request('turn/start', {
      threadId: this.#threadId,
      input: [{ type: 'text', text }],
    });
    const turnId = response?.turn?.id;
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new Error('Codex app-server returned no turn id');
    }
    this.#turnId = turnId;

    const alreadyCompleted = this.#completedTurns.get(turnId);
    if (alreadyCompleted) {
      this.#completedTurns.delete(turnId);
      this.#turnId = null;
      return { id: turnId, completed: Promise.resolve(alreadyCompleted) };
    }

    const waiter = deferred();
    this.#turnWaiters.set(turnId, waiter);
    return { id: turnId, completed: waiter.promise };
  }

  async interruptTurn() {
    if (!this.#threadId || !this.#turnId) {
      throw new Error('No Codex turn is active');
    }
    await this.#request('turn/interrupt', {
      threadId: this.#threadId,
      turnId: this.#turnId,
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#readline?.close();
    if (this.#process && this.#process.exitCode === null) this.#process.kill('SIGTERM');
  }

  #request(method, params) {
    const id = this.#nextRequestId++;
    const pending = deferred();
    this.#pending.set(id, pending);
    this.#write({ method, id, params });
    return pending.promise;
  }

  #notify(method, params) {
    this.#write(params === undefined ? { method } : { method, params });
  }

  #write(message) {
    if (!this.#process?.stdin.writable) throw new Error('Codex app-server stdin is unavailable');
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('event', { type: 'protocol.error', message: `Invalid app-server JSON: ${errorMessage(error)}` });
      return;
    }

    if (message && Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'App-server request failed'));
      else pending.resolve(message.result);
      return;
    }

    if (message && Object.hasOwn(message, 'id') && typeof message.method === 'string') {
      this.#handleServerRequest(message);
      return;
    }

    if (typeof message?.method === 'string') this.#handleNotification(message.method, message.params ?? {});
  }

  #handleServerRequest(message) {
    this.emit('event', {
      type: 'policy.violation',
      method: message.method,
      message: `Codex requested a capability excluded from the zero-tool test: ${message.method}`,
    });

    if (message.method.endsWith('/requestApproval')) {
      this.#write({ id: message.id, result: { decision: 'decline' } });
    } else {
      this.#write({
        id: message.id,
        error: { code: -32000, message: 'Unsupported during zero-tool sidecar test' },
      });
    }
  }

  #handleNotification(method, params) {
    if (method === 'turn/started') {
      this.#turnId = params.turn?.id ?? this.#turnId;
      this.emit('event', { type: 'turn.started', turnId: params.turn?.id });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      this.emit('event', {
        type: 'assistant.delta',
        text: params.delta ?? '',
        phase: 'unknown',
        turnId: params.turnId,
      });
      return;
    }

    if (method === 'item/started') {
      const allowedItemTypes = new Set(['userMessage', 'agentMessage', 'reasoning']);
      const itemType = params.item?.type;
      if (itemType && !allowedItemTypes.has(itemType)) {
        this.emit('event', {
          type: 'policy.violation',
          method,
          message: `Codex started excluded item type: ${itemType}`,
        });
      }
      return;
    }

    if (method === 'turn/completed') {
      const turnId = params.turn?.id;
      const completion = {
        status: params.turn?.status ?? 'unknown',
        turnId,
      };
      const waiter = this.#turnWaiters.get(turnId);
      if (waiter) {
        this.#turnWaiters.delete(turnId);
        waiter.resolve(completion);
      } else if (turnId) {
        this.#completedTurns.set(turnId, completion);
      }
      if (turnId === this.#turnId) this.#turnId = null;
      this.emit('event', { type: 'turn.completed', ...completion });
      return;
    }

    this.emit('event', { type: 'app-server.event', method, params });
  }

  #failAll(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.#pending.values()) pending.reject(normalized);
    this.#pending.clear();
    for (const waiter of this.#turnWaiters.values()) waiter.reject(normalized);
    this.#turnWaiters.clear();
    this.emit('event', { type: 'process.error', message: normalized.message });
  }
}
