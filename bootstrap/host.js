import { pathToFileURL } from 'node:url';
import { parseBrowserMessage } from '../native-host/sidecar-protocol.js';
import { BoundedDecoder, QUEUE_LIMIT, startNativeProxy, writeFrame } from './native-proxy.js';

// Requests contain no candidate text, decision nonce, command, or path. The
// trusted coordinator will own review policy and human-decision validation.
const LIFECYCLE = new Set(['review.status', 'review.start', 'review.open-report', 'review.continue-in-codex', 'review.dismiss']);
export function parseBootstrapMessage(value) {
  if (value && LIFECYCLE.has(value.type)) {
    if (Object.keys(value).length !== 1) throw new Error('Unsupported lifecycle field');
    return { channel: 'lifecycle', message: { type: value.type } };
  }
  return { channel: 'conversation', message: parseBrowserMessage(value) };
}

export async function runBootstrap({ store, nodePath, codexPath, workspace, userHome, codexHome, coordinator, input = process.stdin, output = process.stdout, signals = process }) {
  await store.recover();
  let proxy; let stopped = false; let closePromise; let resolveClosed; let queued = 0;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const send = message => { if (!stopped) writeFrame(output, message); };
  const close = () => {
    if (closePromise) return closePromise;
    stopped = true; input.pause();
    closePromise = (async () => {
      input.off('data', data); input.off('end', close); input.off('close', close); input.off('error', close);
      output.off('error', close); signals.off('SIGTERM', close); signals.off('SIGINT', close); signals.off('SIGHUP', close);
      await proxy?.close(); resolveClosed();
    })();
    return closePromise;
  };
  const failure = () => { try { send({ type: 'error', message: 'Native runtime unavailable' }); } catch {} void close(); };
  let queue = Promise.resolve();
  const decoder = new BoundedDecoder(value => {
    const route = parseBootstrapMessage(value); const bytes = Buffer.byteLength(JSON.stringify(route.message));
    queued += bytes; if (queued > QUEUE_LIMIT) throw new Error('Input queue exceeded');
    queue = queue.then(async () => {
      if (stopped) return;
      if (route.channel === 'lifecycle') {
        if (typeof coordinator?.handle !== 'function') throw new Error('Coordinator unavailable');
        const response = await coordinator.handle(route.message);
        if (response !== undefined) send(response);
      } else {
        if (!proxy) {
          const active = await store.resolveActiveHost(); if (stopped) return;
          proxy = startNativeProxy({ nodePath, codexPath, active, workspace, userHome, codexHome, onMessage: send, onFailure: failure });
        }
        proxy.send(route.message);
      }
    }).catch(failure).finally(() => { queued -= bytes; });
  });
  const data = chunk => { try { decoder.push(chunk); } catch { failure(); } };
  input.on('data', data); input.on('end', close); input.on('close', close); input.on('error', close);
  output.on('error', close); signals.on('SIGTERM', close); signals.on('SIGINT', close); signals.on('SIGHUP', close);
  return { close, closed, get childPid() { return proxy?.pid; } };
}

// Installation/configuration belongs to the later migration task. Direct
// invocation is deliberately inert until a trusted launcher supplies the
// coordinator and concrete paths; environment variables never configure it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFrame(process.stdout, { type: 'error', message: 'Native bootstrap is not configured' });
  process.exitCode = 1;
}
