#!/usr/bin/env node

import { AppServerClient } from './app-server-client.js';
import { GrokAgentClient } from './grok-agent-client.js';
import { NativeMessageDecoder, encodeNativeMessage } from './native-framing.js';
import { parseBrowserMessage, isLifecycleMessage } from './sidecar-protocol.js';

function parseArgs() {
  const encoded = process.env.RESONANT_CODEX_ARGS;
  if (!encoded) return ['app-server'];
  const parsed = JSON.parse(encoded);
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) {
    throw new TypeError('RESONANT_CODEX_ARGS must be a JSON array of strings');
  }
  return parsed;
}

const BROWSER_EVENTS = new Set([
  'session.ready',
  'turn.started',
  'assistant.delta',
  'turn.completed',
  'error',
  'protocol.error',
  'process.error',
  'policy.violation',
]);

function send(message) {
  try {
    process.stdout.write(encodeNativeMessage(message));
  } catch {
    process.stderr.write('outbound native message dropped\n');
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1024);
}

let appServer;
let grokBackend = false;
try {
  const command = process.env.RESONANT_CODEX_COMMAND || 'codex';
  const args = parseArgs();
  const cwd = process.env.RESONANT_WORKSPACE || process.cwd();
  grokBackend = process.env.RESONANT_AGENT === 'grok' || args.includes('stdio');
  appServer = grokBackend
    ? new GrokAgentClient({ command, args, cwd })
    : new AppServerClient({ command, args, cwd });
} catch (error) {
  console.error(safeError(error));
  process.exit(1);
}

appServer.on('event', event => {
  if (event.type === 'diagnostic') {
    process.stderr.write(event.text);
    return;
  }
  if (event.type === 'process.error') {
    send({ type: 'error', message: 'Native runtime unavailable' });
    return;
  }
  if (event.type === 'error' || event.type === 'protocol.error') {
    send({ type: event.type, message: 'Native runtime unavailable' });
    return;
  }
  if (!BROWSER_EVENTS.has(event.type)) return;
  send(event);
});

async function handleBrowserMessage(value) {
  // Only the stable trusted bootstrap may route review/refresh authority.
  // This replaceable child handles the unchanged conversation protocol alone.
  // update.status is bootstrap-only; ignore it on a conversation-only host.
  if (grokBackend && value && value.type === 'update.status') return;
  if (isLifecycleMessage(value)) throw new TypeError('Unsupported browser message type');
  const message = parseBrowserMessage(value);

  if (message.type === 'session.open') {
    await appServer.start();
    await appServer.openSession(message.threadId);
    return;
  }
  if (message.type === 'turn.start') {
    await appServer.startTurn(message.text);
    return;
  }
  if (message.type === 'turn.interrupt') {
    await appServer.interruptTurn();
  }
}

let messageQueue = Promise.resolve();
const decoder = new NativeMessageDecoder(value => {
  messageQueue = messageQueue
    .then(() => handleBrowserMessage(value))
    .catch(() => send({ type: 'error', message: 'Unsupported browser message type or unavailable runtime' }));
});

process.stdin.on('data', chunk => {
  try {
    decoder.push(chunk);
  } catch (error) {
    send({ type: 'error', message: 'Invalid native message' });
  }
});

process.stdin.on('end', () => appServer.close());
process.on('SIGTERM', () => {
  appServer.close();
  process.exit(0);
});
