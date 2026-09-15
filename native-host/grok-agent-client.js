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

export class GrokAgentClient extends EventEmitter {
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
  #turnSequence = 0;
  #turnWaiters = new Map();

  constructor({ command = 'grok', args = ['agent', '--no-leader', 'stdio'], cwd = process.cwd() } = {}) {
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
      this.#failAll(new Error(`Grok agent exited with ${detail}`));
    });
    this.#process.stderr.setEncoding('utf8');
    this.#process.stderr.on('data', text => {
      this.emit('event', { type: 'diagnostic', text: String(text).slice(0, 8192) });
    });

    this.#readline = readline.createInterface({ input: this.#process.stdout });
    this.#readline.on('line', line => this.#handleLine(line));

    await this.#request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'resonant-sidecar', title: 'Resonant Sidecar', version: '0.1.0' },
      clientCapabilities: {},
    });
  }

  async openSession(threadId) {
    if (!this.#process) throw new Error('App-server client has not started');
    if (this.#threadId) {
      if (threadId === null || threadId === this.#threadId) return this.#threadId;
      throw new Error('A different Grok session is already open');
    }

    const response = threadId === null
      ? await this.#request('session/new', { cwd: this.#cwd, mcpServers: [] })
      : await this.#request('session/resume', { cwd: this.#cwd, sessionId: threadId, mcpServers: [] });

    const openedThreadId = response?.sessionId;
    if (typeof openedThreadId !== 'string' || openedThreadId.length === 0) {
      throw new Error('Grok agent returned no session id');
    }
    this.#threadId = openedThreadId;
    this.emit('event', { type: 'session.ready', threadId: openedThreadId });
    return openedThreadId;
  }

  async startTurn(text) {
    if (!this.#threadId) throw new Error('No Grok session is open');
    if (this.#turnId) throw new Error('A Grok turn is already active');

    const turnId = `turn-${++this.#turnSequence}`;
    this.#turnId = turnId;
    this.emit('event', { type: 'turn.started', turnId });

    const waiter = deferred();
    this.#turnWaiters.set(turnId, waiter);
    const alreadyCompleted = this.#completedTurns.get(turnId);
    if (alreadyCompleted) {
      this.#completedTurns.delete(turnId);
      this.#turnId = null;
      waiter.resolve(alreadyCompleted);
      return { id: turnId, completed: Promise.resolve(alreadyCompleted) };
    }

    this.#request('session/prompt', {
      sessionId: this.#threadId,
      prompt: [
        { type: 'text', text: `${ZERO_TOOL_INSTRUCTIONS}\n\n${text}` },
      ],
    }).then(() => this.#completeTurn(turnId, 'completed'))
      .catch(error => {
        const waiterPending = this.#turnWaiters.get(turnId);
        if (waiterPending) {
          this.#turnWaiters.delete(turnId);
          waiterPending.reject(error);
        }
        if (this.#turnId === turnId) this.#turnId = null;
      });

    return { id: turnId, completed: waiter.promise };
  }

  async interruptTurn() {
    if (!this.#threadId || !this.#turnId) {
      throw new Error('No Grok turn is active');
    }
    this.#notify('session/cancel', { sessionId: this.#threadId });
    this.#completeTurn(this.#turnId, 'interrupted');
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#readline?.close();
    if (this.#process && this.#process.exitCode === null) this.#process.kill('SIGTERM');
  }

  #completeTurn(turnId, status) {
    const completion = { status, turnId };
    const waiter = this.#turnWaiters.get(turnId);
    if (waiter) {
      this.#turnWaiters.delete(turnId);
      waiter.resolve(completion);
    } else if (turnId) {
      this.#completedTurns.set(turnId, completion);
    }
    if (turnId === this.#turnId) this.#turnId = null;
    this.emit('event', { type: 'turn.completed', ...completion });
  }

  #request(method, params) {
    const id = this.#nextRequestId++;
    const pending = deferred();
    this.#pending.set(id, pending);
    this.#write({ jsonrpc: '2.0', method, id, params });
    return pending.promise;
  }

  #notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(message) {
    if (!this.#process?.stdin.writable) throw new Error('Grok agent stdin is unavailable');
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
      if (message.error) pending.reject(new Error(message.error.message ?? 'Grok agent request failed'));
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
      message: `Grok requested a capability excluded from the zero-tool test: ${message.method}`,
    });

    if (message.method === 'session/request_permission' || message.method.endsWith('/request_permission') || message.method.endsWith('/requestApproval')) {
      this.#write({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    this.#write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: 'Unsupported during zero-tool sidecar test' },
    });
  }

  #handleNotification(method, params) {
    if (method === 'session/update') {
      const update = params.update ?? params;
      const kind = update.sessionUpdate;
      if (kind === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
        this.emit('event', {
          type: 'assistant.delta',
          text: update.content.text,
          phase: 'unknown',
          turnId: this.#turnId,
        });
      }
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
