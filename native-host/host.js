#!/usr/bin/env node

import { AppServerClient } from './app-server-client.js';
import { NativeMessageDecoder, encodeNativeMessage } from './native-framing.js';
import { parseBrowserMessage } from './sidecar-protocol.js';

function parseArgs() {
  const encoded = process.env.RESONANT_CODEX_ARGS;
  if (!encoded) return ['app-server'];
  const parsed = JSON.parse(encoded);
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) {
    throw new TypeError('RESONANT_CODEX_ARGS must be a JSON array of strings');
  }
  return parsed;
}

function send(message) {
  process.stdout.write(encodeNativeMessage(message));
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1024);
}

let appServer;
try {
  appServer = new AppServerClient({
    command: process.env.RESONANT_CODEX_COMMAND || 'codex',
    args: parseArgs(),
    cwd: process.env.RESONANT_WORKSPACE || process.cwd(),
  });
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
    send({ type: 'error', message: event.message });
    return;
  }
  send(event);
});

async function handleBrowserMessage(value) {
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
    .catch(error => send({ type: 'error', message: safeError(error) }));
});

process.stdin.on('data', chunk => {
  try {
    decoder.push(chunk);
  } catch (error) {
    send({ type: 'error', message: safeError(error) });
  }
});

process.stdin.on('end', () => appServer.close());
process.on('SIGTERM', () => {
  appServer.close();
  process.exit(0);
});
