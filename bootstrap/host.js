import { pathToFileURL } from 'node:url';
import { parseBrowserMessage } from '../native-host/sidecar-protocol.js';
import { BoundedDecoder, QUEUE_LIMIT, startNativeProxy, writeFrame } from './native-proxy.js';
import { snapshotDecision } from './recovery-state.js';
import { sha256Bytes } from '../review/canonical-json.js';

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
  let proxy; let lastChildPid; let stopped = false; let closePromise; let resolveClosed; let queued = 0;
  let refreshing = null; let refreshed = null; let readyWait = null;
  let runtimeState = null; let sessionThreadId = null; let sessionRequested = false; let generation = 0;
  const owned = new Set(); let transitions = Promise.resolve(); let transitionBusy = false;
  const serialize = action => {
    const result = transitions.then(async () => {
      transitionBusy = true;
      try { return await action(); } finally { transitionBusy = false; }
    });
    transitions = result.catch(() => {});
    return result;
  };
  const stopOwned = async () => {
    ++generation;
    for (const child of owned) { await child.close(); owned.delete(child); }
    proxy = null; runtimeState = null;
  };
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const send = message => { if (!stopped) writeFrame(output, message); };
  store.bindRuntimeGuard(expected => !stopped && !refreshing && !transitionBusy && owned.size === 1 && owned.has(proxy) && refreshed?.pid === proxy.pid && refreshed?.decisionHash === expected.decisionHash && runtimeState?.digest === expected.digest && runtimeState?.reviewId === expected.reviewId);
  const close = () => {
    if (closePromise) return closePromise;
    stopped = true; input.pause();
    refreshed = null;
    readyWait?.reject(new Error('Pending runtime refresh cancelled')); readyWait = null;
    closePromise = serialize(async () => {
      input.off('data', data); input.off('end', close); input.off('close', close); input.off('error', close);
      signals.off('SIGTERM', close); signals.off('SIGINT', close); signals.off('SIGHUP', close);
      await stopOwned();
      // A disconnected pending runtime can never be completed. Restore the
      // prior verified pin after its process group has been reaped.
      try { await store.recover(); } finally { resolveClosed(); }
    });
    return closePromise;
  };
  const failure = () => { try { send({ type: 'error', message: 'Native runtime unavailable' }); } catch {} void close().catch(() => {}); };
  const startProxy = active => {
    if (stopped || proxy || owned.size !== 0) throw new Error('Proxy ownership transition invalid');
    const ownGeneration = ++generation;
    proxy = startNativeProxy({ nodePath, codexPath, active, workspace, userHome, codexHome, onFailure: failure, onMessage: message => {
      if (stopped || generation !== ownGeneration) return;
      if (message.type === 'session.ready') {
        if (!sessionRequested || (sessionThreadId !== null && message.threadId !== sessionThreadId) || (readyWait && message.threadId !== readyWait.threadId)) { failure(); return; }
        sessionThreadId = message.threadId;
        readyWait?.resolve(); readyWait = null;
      }
      send(message);
    } });
    owned.add(proxy);
    lastChildPid = proxy.pid;
    runtimeState = Object.freeze({ digest: active.digest, reviewId: active.reviewId, hostPath: active.hostPath, pid: proxy.pid, pgid: proxy.pid });
  };
  const refreshPending = decision => {
    decision = snapshotDecision(decision);
    if (stopped || refreshing) return Promise.reject(new Error('Runtime refresh unavailable'));
    refreshed = null;
    const transition = serialize(async () => {
      let timer;
      try {
        await stopOwned();
        if (stopped) throw new Error('Runtime refresh cancelled');
        if (sessionThreadId === null) throw new Error('Session identity unresolved for refresh');
        const active = await store.resolvePendingHost(decision);
        if (stopped) throw new Error('Runtime refresh cancelled');
        startProxy(active);
        const ready = new Promise((resolve, reject) => {
          readyWait = { resolve, reject, threadId: sessionThreadId };
          timer = setTimeout(() => reject(new Error('Pending runtime readiness timeout')), 5000);
        });
        // Resume the known conversation only; no turn is started by refresh.
        proxy.send({ type: 'session.open', threadId: sessionThreadId });
        await ready;
        if (stopped) throw new Error('Runtime refresh cancelled');
        refreshed = Object.freeze({ decisionHash: sha256Bytes(decision.nonce), pid: proxy.pid });
        return runtimeState;
      } finally { clearTimeout(timer); readyWait = null; }
    });
    // Recovery is queued only after this transition releases ownership, never
    // awaited from inside the same transition queue.
    const operation = transition.catch(async error => {
      if (!stopped) await close();
      throw error;
    }).finally(() => { refreshing = null; });
    refreshing = operation;
    return operation;
  };
  let queue = Promise.resolve();
  const decoder = new BoundedDecoder(value => {
    const route = parseBootstrapMessage(value); const bytes = Buffer.byteLength(JSON.stringify(route.message));
    if (route.channel === 'conversation' && route.message.type === 'session.open') {
      const requested = route.message.threadId;
      if (requested !== null) {
        if ((sessionThreadId !== null && sessionThreadId !== requested) || (sessionRequested && sessionThreadId === null)) throw new Error('Ambiguous session identity');
        sessionThreadId = requested;
      }
      sessionRequested = true;
      // Bind a non-null request at validation, before queuing or resolving a
      // host. A repeated null open may reuse an already-bound session only.
      route.message = { type: 'session.open', threadId: sessionThreadId };
    }
    queued += bytes; if (queued > QUEUE_LIMIT) throw new Error('Input queue exceeded');
    queue = queue.then(async () => {
      if (stopped) return;
      if (route.channel === 'lifecycle') {
        if (typeof coordinator?.handle !== 'function') throw new Error('Coordinator unavailable');
        const response = await coordinator.handle(route.message);
        if (response !== undefined) send(response);
      } else {
        if (refreshing) await refreshing;
        if (stopped) return;
        await serialize(async () => {
          if (stopped) return;
          if (!proxy) {
            const active = await store.resolveActiveHost(); if (stopped) return;
            startProxy(active);
          }
          proxy.send(route.message);
        });
      }
    }).catch(failure).finally(() => { queued -= bytes; });
  });
  const data = chunk => { try { decoder.push(chunk); } catch { failure(); } };
  input.on('data', data); input.on('end', close); input.on('close', close); input.on('error', close);
  output.on('error', close); signals.on('SIGTERM', close); signals.on('SIGINT', close); signals.on('SIGHUP', close);
  return {
    close, closed, refreshPending,
    completeActivation(decision) { return store.completeActivation(decision); },
    get childPid() { return proxy?.pid ?? lastChildPid; },
    get runtimeState() { return runtimeState; },
  };
}

// Installation/configuration belongs to the later migration task. Direct
// invocation is deliberately inert until a trusted launcher supplies the
// coordinator and concrete paths; environment variables never configure it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFrame(process.stdout, { type: 'error', message: 'Native bootstrap is not configured' });
  process.exitCode = 1;
}
