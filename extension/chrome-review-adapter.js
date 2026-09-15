import {
  assertCompleteEvidenceShape, buildChromeReviewPrompt, canonicalReviewJson,
  CHROME_REVIEW_PROMPT, CHROME_REVIEW_PROMPT_ID, CHROME_REVIEW_SCHEMA, CHROME_REVIEW_SCHEMA_ID,
  exactReviewKeys, freezeReviewValue, MAX_EVIDENCE_PACKET_BYTES, parseChromeAnalysis, snapshotChromeReviewValue,
} from './chrome-review-contract.js';

const BINDING_FIELDS = ['reviewId', 'activeDigest', 'candidateDigest', 'policyDigest', 'invocationId', 'runtimeGeneration', 'inputDigest', 'evidenceDigest', 'promptDigest', 'schemaDigest', 'adapterDigest', 'deadline', 'channelId', 'restartId'];
const CANCEL_REASONS = new Set(['cancellation', 'panel-closure', 'emergency-stop']);
const FAILURE_REASONS = new Set(['connection-loss', 'provenance-drift', 'timeout', 'custody-failure']);
const NOTICE = 'Local analysis uses a Chrome-managed on-device model that may already be stored or updated on this device.';
const PREPARATION_NOTICE = 'Chrome may download and store an on-device model. Preparation does not run analysis.';
const MODALITIES = freezeReviewValue({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] });
const utf8 = new TextEncoder();
const requireBinding = condition => { if (!condition) throw new Error('Chrome review binding unavailable'); };

function snapshotReady(value, now) {
  const ready = snapshotChromeReviewValue(value);
  exactReviewKeys(ready, ['type', ...BINDING_FIELDS, 'packet']);
  requireBinding(ready.type === 'review.chromeReady');
  const binding = Object.fromEntries(BINDING_FIELDS.map(key => [key, ready[key]]));
  for (const [key, value] of Object.entries(binding)) {
    if (key === 'runtimeGeneration') requireBinding(Number.isSafeInteger(value) && value >= 0);
    else if (key === 'deadline') requireBinding(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) > now && Date.parse(value) - now <= 600000);
    else {
      const pattern = key === 'reviewId' ? /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/ : key === 'invocationId' ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ : ['channelId', 'restartId'].includes(key) ? /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/ : /^[a-f0-9]{64}$/;
      requireBinding(typeof value === 'string' && pattern.test(value));
    }
  }
  const packet = ready.packet;
  exactReviewKeys(packet, ['type', 'schemaVersion', 'reviewId', 'invocationId', 'activeBundleDigest', 'candidateBundleDigest', 'policyDigest', 'evidenceDigest', 'promptId', 'promptDigest', 'schemaId', 'schemaDigest', 'adapterDigest', 'runtimeGeneration', 'deadline', 'evidence']);
  requireBinding(packet.type === 'ChromeReviewPacket' && packet.schemaVersion === 2 && packet.promptId === CHROME_REVIEW_PROMPT_ID && packet.schemaId === CHROME_REVIEW_SCHEMA_ID);
  for (const key of BINDING_FIELDS.filter(key => !['inputDigest', 'channelId', 'restartId'].includes(key))) {
    const packetKey = key === 'activeDigest' ? 'activeBundleDigest' : key === 'candidateDigest' ? 'candidateBundleDigest' : key;
    requireBinding(binding[key] === packet[packetKey]);
  }
  assertCompleteEvidenceShape(packet.evidence);
  for (const key of ['reviewId', 'activeBundleDigest', 'candidateBundleDigest', 'policyDigest']) requireBinding(packet[key] === packet.evidence[key]);
  requireBinding(packet.evidence.policy.schemaVersion === 2);
  requireBinding(utf8.encode(canonicalReviewJson(packet)).length <= MAX_EVIDENCE_PACKET_BYTES);
  return freezeReviewValue({ binding, packet });
}

async function digest(text) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyReady({ binding, packet }) {
  const evidence = packet.evidence;
  const prompt = buildChromeReviewPrompt({ evidence, evidenceDigest: packet.evidenceDigest });
  const hashes = [
    [canonicalReviewJson(packet), binding.inputDigest], [canonicalReviewJson(evidence), binding.evidenceDigest],
    [prompt, binding.promptDigest], [canonicalReviewJson(CHROME_REVIEW_SCHEMA), binding.schemaDigest],
    [canonicalReviewJson(evidence.policy), binding.policyDigest],
  ];
  for (const manifest of [evidence.activeManifest, evidence.candidateManifest]) {
    const { bundleDigest, ...unsigned } = manifest; hashes.push([canonicalReviewJson(unsigned), bundleDigest]);
  }
  for (const file of evidence.sourceDiff.changedFiles) for (const side of ['before', 'after']) {
    if (file[side + 'Text'] !== null) hashes.push([file[side + 'Text'], file[side + 'Sha256']]);
  }
  const { encodedBytes, ...source } = evidence.sourceDiff;
  requireBinding(utf8.encode(canonicalReviewJson(source)).length === encodedBytes);
  const verified = await Promise.all(hashes.map(async ([text, expected]) => await digest(text) === expected));
  requireBinding(verified.every(Boolean));
  return prompt;
}

/** One visible panel invocation. Port ownership belongs to SidecarSession;
 * this adapter retains only immutable verified evidence and one-shot sessions.
 * No model call occurs until inspect receives the current bound ready packet.
 * Only the direct Prepare/Run handlers call create, synchronously before await. */
export function createChromeReviewAdapter({ languageModel, sendResult, sendCancel, onState = () => {}, clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let invocation = null, destroyed = false;
  function state(value) {
    if (!invocation) return;
    invocation.phase = value;
    onState(Object.freeze({ state: value, notice: NOTICE, preparationNotice: ['preparation-required', 'preparing'].includes(value) ? PREPARATION_NOTICE : null }));
  }
  function send(callback, message) {
    // A lost native channel must never leave a rejected promise unobserved.
    void (async () => { try { await callback(freezeReviewValue(message)); } catch { /* Channel owner invalidates the invocation. */ } })();
  }
  async function dispose(operation) {
    if (!operation?.session) return;
    if (!operation.destroyed) {
      operation.destroyed = true; // Linearize before a reentrant destroy call.
      operation.cleanup = (async () => {
        try { await operation.session.destroy(); } catch { operation.cleanupFailed = true; }
      })();
    }
    await operation.cleanup;
  }
  function terminal(reasonCode, rawText = null) {
    const active = invocation;
    if (!active || active.terminal) return false;
    active.terminal = true; clearTimer(active.timer);
    active.operation?.controller.abort();
    active.release(false);
    const isCancel = CANCEL_REASONS.has(reasonCode);
    state(reasonCode === null ? 'completed' : isCancel ? 'stopped' : 'failed');
    const status = { reasonCode, availabilityStatus: active.availability, executionStatus: reasonCode === null ? 'completed' : active.prompted ? 'failed' : 'not-run' };
    // Bound cancellation is initiated before any cleanup that could be slow.
    send(isCancel ? sendCancel : sendResult, { type: isCancel ? 'review.chromeCancel' : 'review.chromeResult', ...active.binding,
      ...(!isCancel ? { rawText } : {}), ...status });
    void dispose(active.operation);
    return true;
  }
  function arm(ms) {
    const active = invocation; clearTimer(active.timer);
    active.timer = setTimer(() => terminal('timeout'), Math.max(1, Math.min(ms, Date.parse(active.binding.deadline) - clock())));
  }
  function live() {
    if (!invocation || invocation.terminal || destroyed) return false;
    if (clock() >= Date.parse(invocation.binding.deadline)) { terminal('timeout'); return false; }
    return true;
  }
  async function inspect(value) {
    if (invocation || destroyed) return false;
    let request;
    try { request = snapshotReady(value, clock()); } catch { return false; }
    let release;
    invocation = { ...request, availability: 'not-checked', phase: 'verifying', terminal: false, prompted: false,
      cancelled: new Promise(resolve => { release = resolve; }), release: value => release(value), operation: null, timer: null };
    arm(60000);
    const inspecting = (async () => {
      try {
        const prompt = await verifyReady(request);
        if (!live()) return false;
        invocation.prompt = prompt;
        state('checking');
        if (!languageModel || typeof languageModel.availability !== 'function' || typeof languageModel.create !== 'function') {
          invocation.availability = 'api-absent'; terminal('api-absent'); return true;
        }
        const available = await languageModel.availability(MODALITIES);
        if (!live()) return false;
        if (available === 'available') { invocation.availability = 'available'; state('ready'); }
        else if (available === 'downloadable' || available === 'downloading') { invocation.availability = 'setup-required'; state('preparation-required'); }
        else { invocation.availability = 'unavailable'; terminal('unavailable'); return true; }
        arm(600000); return true;
      } catch {
        if (live()) terminal('custody-failure');
        return false;
      }
    })();
    return Promise.race([inspecting, invocation.cancelled]);
  }
  function execute(preparation) {
    if (!live() || invocation.phase !== (preparation ? 'preparation-required' : 'ready')) return Promise.resolve(false);
    const active = invocation;
    const operation = { controller: new AbortController(), session: null, cleanup: null, cleanupFailed: false, destroyed: false };
    active.operation = operation;
    state(preparation ? 'preparing' : 'running'); arm(preparation ? 600000 : 60000);
    const work = (async () => {
      let raw = null, failure = null;
      try {
        operation.session = await languageModel.create({ ...MODALITIES,
          initialPrompts: [{ role: 'system', content: CHROME_REVIEW_PROMPT }], signal: operation.controller.signal,
          monitor() { /* Fixed preparing/running labels expose no model or event prose. */ },
        });
        if (!live()) return false;
        if (!preparation) {
          active.prompted = true;
          raw = await operation.session.prompt(active.prompt, { signal: operation.controller.signal, responseConstraint: CHROME_REVIEW_SCHEMA });
          if (!live()) return false;
          const source = active.packet.evidence.sourceDiff;
          try {
            requireBinding(typeof raw === 'string');
            parseChromeAnalysis(raw, { suppliedFiles: source.changedFiles.map(file => file.path),
              suppliedLocations: source.coverage.flatMap(file => ['before', 'after'].flatMap(side => file[side] === null ? [] : file[side].ranges.map(([start, end]) => ({ file: file.path, location: `${side}:${start}-${end}` })))) });
          } catch { failure = 'malformed-output'; }
        }
      } catch {
        // Once prompt was attempted, report failed execution truthfully. The
        // wire protocol reserves unavailable/not-run for preflight failures.
        failure = active.prompted ? 'custody-failure' : preparation ? 'setup-declined' : 'unavailable';
      } finally {
        await dispose(operation);
      }
      if (!live()) return false;
      if (operation.cleanupFailed) failure = 'custody-failure';
      if (failure) {
        if (failure === 'setup-declined' || failure === 'unavailable') active.availability = failure;
        terminal(failure); return false;
      }
      if (preparation) { active.availability = 'available'; state('ready'); arm(600000); return true; }
      terminal(null, raw); return true;
    })();
    return Promise.race([work, active.cancelled]);
  }
  function cancel(reasonCode) {
    if (!CANCEL_REASONS.has(reasonCode) && !FAILURE_REASONS.has(reasonCode)) return false;
    return terminal(reasonCode);
  }
  return Object.freeze({ inspect, prepare: () => execute(true), run: () => execute(false), cancel,
    destroy(reasonCode = 'panel-closure') { const cancelled = cancel(reasonCode); destroyed = true; return cancelled; },
  });
}
