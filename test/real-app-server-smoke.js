#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NativeMessageDecoder, encodeNativeMessage } from '../native-host/native-framing.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostPath = path.join(root, 'native-host', 'host.js');
const codexPath = process.env.RESONANT_CODEX_COMMAND || path.join(
  process.env.HOME || '',
  '.local',
  'bin',
  'codex',
);

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

class NativeHostHarness {
  constructor() {
    this.messages = [];
    this.waiters = [];
    this.diagnostics = [];
    this.host = spawn(process.execPath, [hostPath], {
      cwd: root,
      env: {
        ...process.env,
        RESONANT_CODEX_COMMAND: codexPath,
        RESONANT_WORKSPACE: root,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new NativeMessageDecoder(message => this.#dispatch(message));
    this.host.stdout.on('data', chunk => decoder.push(chunk));
    this.host.stderr.setEncoding('utf8');
    this.host.stderr.on('data', chunk => this.diagnostics.push(chunk));
  }

  #dispatch(message) {
    this.messages.push(message);
    const messageIndex = this.messages.length - 1;
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (messageIndex >= waiter.fromIndex && waiter.predicate(message)) {
        this.waiters.splice(index, 1);
        waiter.resolve(message);
      }
    }
  }

  send(message) {
    this.host.stdin.write(encodeNativeMessage(message));
  }

  waitFor(predicate, label, fromIndex = 0) {
    const existing = this.messages.slice(fromIndex).find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, fromIndex };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${label} timed out after 90 seconds`));
      }, 90_000);
      waiter.resolve = value => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }

  async open(threadId) {
    const fromIndex = this.messages.length;
    this.send({ type: 'session.open', threadId });
    return this.waitFor(message => message.type === 'session.ready', 'session.ready', fromIndex);
  }

  async runTurn(prompt, validate) {
    const fromIndex = this.messages.length;
    this.send({ type: 'turn.start', text: prompt });
    const started = await this.waitFor(
      message => message.type === 'turn.started',
      'turn.started',
      fromIndex,
    );
    const completed = await this.waitFor(
      message => message.type === 'turn.completed' && message.turnId === started.turnId,
      'turn.completed',
      fromIndex,
    );
    const answer = this.messages
      .slice(fromIndex)
      .filter(message => message.type === 'assistant.delta' && message.turnId === started.turnId)
      .map(message => message.text)
      .join('')
      .trim();

    if (completed.status !== 'completed') {
      throw new Error(`Turn ${started.turnId} ended with status ${completed.status}`);
    }
    if (!validate(answer)) {
      throw new Error(`Turn ${started.turnId} returned an unexpected answer (sha256 ${digest(answer)})`);
    }
    return {
      turnId: started.turnId,
      status: completed.status,
      replySha256: digest(answer),
    };
  }

  assertClean() {
    const violation = this.messages.find(message => message.type === 'policy.violation');
    const error = this.messages.find(message => message.type === 'error' || message.type === 'process.error');
    if (violation) throw new Error(violation.message || 'Zero-tool boundary was crossed');
    if (error) throw new Error(error.message || 'Native host reported an error');
  }

  diagnosticsBytes() {
    return Buffer.byteLength(this.diagnostics.join(''), 'utf8');
  }

  close() {
    this.host.stdin.end();
    this.host.kill('SIGTERM');
  }
}

const firstHost = new NativeHostHarness();
let secondHost;

try {
  const firstReady = await firstHost.open(null);
  const turns = [];
  turns.push(await firstHost.runTurn(
    'For this three-turn transport check, remember the token EMBER-7421. Reply exactly: STORED',
    answer => answer === 'STORED',
  ));
  firstHost.assertClean();
  firstHost.close();

  secondHost = new NativeHostHarness();
  const resumed = await secondHost.open(firstReady.threadId);
  if (resumed.threadId !== firstReady.threadId) {
    throw new Error('Resumed native host returned a different Codex thread id');
  }
  turns.push(await secondHost.runTurn(
    'What token did I ask you to remember? Reply with only the token.',
    answer => answer === 'EMBER-7421',
  ));
  turns.push(await secondHost.runTurn(
    'Using the same remembered token, reply with its word and the four digits reversed, exactly like WORD-1234.',
    answer => answer === 'EMBER-1247',
  ));
  secondHost.assertClean();

  process.stdout.write(`${JSON.stringify({
    result: 'pass',
    transport: 'Chrome native frames -> local host -> Codex app-server stdio',
    threadId: firstReady.threadId,
    nativeHostProcesses: 2,
    resumedSameThread: true,
    turns,
    policyViolations: 0,
    nativeHostDiagnosticsBytes: firstHost.diagnosticsBytes() + secondHost.diagnosticsBytes(),
  }, null, 2)}\n`);
} finally {
  firstHost.close();
  secondHost?.close();
}
