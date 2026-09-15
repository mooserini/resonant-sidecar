import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { encodeNativeMessage } from '../native-host/native-framing.js';

export const FRAME_LIMIT = 1024 * 1024;
export const QUEUE_LIMIT = 2 * FRAME_LIMIT;

export class BoundedDecoder {
  #buffer = Buffer.alloc(0); #receive;
  // Preserve the exact frame text: never repair invalid bytes or strip a BOM.
  #utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  constructor(receive) { this.#receive = receive; }
  push(chunk) {
    if (this.#buffer.length + chunk.length > QUEUE_LIMIT) throw new Error('Frame buffer exceeded');
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (!length || length > FRAME_LIMIT) throw new Error('Frame size exceeded');
      if (this.#buffer.length < length + 4) return;
      const message = JSON.parse(this.#utf8.decode(this.#buffer.subarray(4, length + 4)));
      this.#buffer = this.#buffer.subarray(length + 4);
      this.#receive(message);
    }
  }
}

export function writeFrame(stream, message) {
  const bytes = encodeNativeMessage(message);
  if (!stream.writable || stream.destroyed || stream.writableLength + bytes.length > QUEUE_LIMIT) throw new Error('Output queue exceeded');
  stream.write(bytes);
}

export function executable(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.normalize(p) !== p || /[\x00-\x1f]/.test(p) || realpathSync(p) !== p || !lstatSync(p).isFile() || !(lstatSync(p).mode & 0o111)) throw new Error('Expected concrete executable path');
  return p;
}

function conversationEvent(message) {
  const shapes = {
    'session.ready': ['threadId'], 'turn.started': ['turnId'],
    'assistant.delta': ['text', 'phase', 'turnId'], 'turn.completed': ['status', 'turnId'],
    'error': ['message'], 'protocol.error': ['message'],
    'policy.violation': ['method', 'message'], 'app-server.event': ['method', 'params'],
  };
  if (!message || !Object.hasOwn(shapes, message.type) || Object.keys(message).some(k => k !== 'type' && !shapes[message.type].includes(k))) throw new Error('Invalid child event');
  if (message.type === 'session.ready' && (typeof message.threadId !== 'string' || message.threadId.length < 1 || message.threadId.length > 256)) throw new Error('Invalid child session readiness');
  for (const key of shapes[message.type]) {
    if (key === 'params') {
      if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) throw new Error('Invalid child event');
    } else if (Object.hasOwn(message, key) && typeof message[key] !== 'string') throw new Error('Invalid child event');
  }
  return message;
}

export function startNativeProxy({ nodePath, codexPath, active, workspace, userHome, codexHome, onMessage, onFailure }) {
  executable(nodePath); executable(codexPath);
  for (const p of [active.hostPath, active.bundleRoot, workspace, userHome, codexHome].filter(p => p !== undefined)) {
    if (!path.isAbsolute(p) || path.normalize(p) !== p || realpathSync(p) !== p) throw new Error('Expected concrete runtime path');
  }
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', RESONANT_CODEX_COMMAND: codexPath, RESONANT_CODEX_ARGS: '["app-server"]', RESONANT_WORKSPACE: workspace };
  if (userHome !== undefined) env.HOME = userHome;
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  const child = spawn(nodePath, [active.hostPath], { cwd: active.bundleRoot, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true });
  let closing; let stderrBytes = 0; let closedResolve;
  const exited = new Promise(resolve => { closedResolve = resolve; });
  child.once('close', closedResolve);
  const groupSignal = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      child.stdin.destroy(); groupSignal('SIGTERM');
      // Always escalate the owned group, even when its leader exits first.
      await new Promise(resolve => setTimeout(resolve, 200));
      groupSignal('SIGKILL'); await exited;
    })();
    return closing;
  };
  const fail = () => { if (!closing) { onFailure(); void close(); } };
  child.on('error', fail); child.stdin.on('error', fail);
  child.stdout.on('error', fail); child.stderr.on('error', fail);
  child.once('exit', () => { if (!closing) fail(); });
  const decoder = new BoundedDecoder(message => onMessage(conversationEvent(message)));
  child.stdout.on('data', chunk => { try { decoder.push(chunk); } catch { fail(); } });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 256 * 1024) fail(); });
  return { pid: child.pid, close, send(message) { if (closing) throw new Error('Proxy closed'); writeFrame(child.stdin, message); } };
}
