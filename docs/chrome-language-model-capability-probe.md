# Frozen inert Chrome LanguageModel capability probe

Status: authored for source review only. No live capability result exists. Task 11
stops here until Tom approves this exact script hash for a human-present check.
The existing V1 development extension remains the intended later target; this
document does not load the prepared V2 extension or change its registration.

Script SHA-256: `0684a6e86be943271d5f3abdc08a72fd086b0695f6dcde9d5690e68b461f0956`

Hash definition: SHA-256 over UTF-8 bytes between the single `javascript` fence
below, beginning with `void` and including the final LF after `})();`. Exclude
the fences and marker comments. The hash is external to the script; it is not a
self-attestation. The later receipt assembler binds this hash to the frozen
document commit and saved Console snapshots. Recompute it before Tom pastes.

## Resource consequence and authority

Pasting installs three temporary controls and performs only API presence and one
availability check. Clicking **Prepare** may cause Chrome to download and store
browser-managed model data. Clicking **Run inert probe** creates a fresh session
and submits the single literal record below. Creation can allocate memory and
compute resources, and may cause acquisition even if an earlier availability
observation said `available`. Cancel/destroy releases the session through the API;
it does not promise deletion of Chrome-managed model files or rollback of a
download. Model acquisition is separate from inference behavior.

The official documentation describes downloaded models, text modality options,
normalized `downloadprogress.loaded`, `create({signal})`, `contextWindow`, and
session destruction. This probe uses those current fields, with English text
input/output throughout. It omits sampling overrides and `params()`. The local
extension reference's `loaded / total` example is older than the current progress
example; this probe never reads `total`. The reference's broad context claim is
not treated as proof for this installed browser: only the selected side-panel
Window is in scope. [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api)
(reviewed 2026-09-15; page updated 2026-08-26).

`responseConstraint` receives the complete inline V2 JSON Schema. The script
validates the returned JSON shape and discards its text; a passed shape check
grants no candidate or acceptance authority.
[Structured output for the Prompt API](https://developer.chrome.com/docs/ai/structured-output-for-prompt-api)
(reviewed 2026-09-15; page updated 2025-05-13).

Model identity remains `not-attested`; inference binding remains
`not-established`. A later observation may use exactly
`documented-on-device; no adapter network observed` only when supported by its
separate network observation. Those words are documented behavior plus bounded
observation, not cryptographic or process-level locality proof. This script has
no network observer and cannot establish that label by itself.

## Exact source-review checklist

- [ ] Match the external source SHA-256, frozen document commit, and complete script.
- [ ] Verify the inline `SCHEMA` expression is copied exactly from committed
  `review/chrome-review-contract.js` at `efc93c6bf639bc8f963ddbf4d721656d594194df`;
  its JSON value also matches `policy/chrome-language-model.v2.schema.json`.
- [ ] Verify the literal `INPUT` is the only prompt, with no interpolation,
  initial prompts, candidate packet, repository bytes, conversation, page text,
  cookie, credential, native-port payload, or model-service data.
- [ ] Verify initial injection calls only `LanguageModel.availability()` with the
  fixed modalities after detecting the API. No creation or inference occurs.
- [ ] Verify only direct trusted button handlers reach `create()`; only the Run
  handler's one session reaches `prompt()`. Both calls are inside that handler's
  operation; the prompt follows its awaited fresh session. Preparation is a
  separate operation, destroys its session, and requires another Run click.
- [ ] Verify there is no `chrome.runtime`, `connectNative`, `sendMessage`, `fetch`,
  XHR, WebSocket, storage, navigation mutation, dynamic import, `eval`, `Function`,
  message/worker transport, or alternate model/API fallback.
- [ ] Verify existing-document reads are only `location.href`, `location.origin`,
  and `document.body` as the append point. Creation/removal affects only the
  held probe subtree. No selector, transcript/status read, cookie read, or native
  Port read occurs. Idle status and exact extension identity are human checks.
- [ ] Verify the only controls are Prepare, Run inert probe, and Cancel. All
  displayed text uses `textContent`; no model text enters DOM, Console, or receipt.
  Probe clicks stop propagation and default handling before proceeding.
- [ ] Verify `responseConstraint`, an `AbortSignal` for every create/prompt, and
  unconditional destruction for every session returned, including late creation.
- [ ] Verify fixed failure states, bounded numeric progress/context capacity,
  one availability attempt, one preparation attempt at most, one run at most,
  no automatic retry, and no resumption after cancellation or `pagehide`.
- [ ] Verify all three button listeners, the `pagehide` listener, the progress
  listener, every timer, and the subtree are removed at stop. No global variable,
  callback, session, or receipt binding is exported. A pending API promise is
  explicitly pending until it settles; its continuation only cleans up.
- [ ] Verify the exact receipt allowlist below and the separated external sources.

## Complete Console script

<!-- BEGIN FROZEN PROBE -->
```javascript
void (async () => {
  'use strict';
  function freezeReviewValue(value) {
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) freezeReviewValue(item);
      Object.freeze(value);
    }
    return value;
  }
  const SCHEMA = freezeReviewValue({
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'outcome', 'summary', 'findings'],
  properties: {
    schemaVersion: { const: 2 },
    outcome: { enum: ['no-blocking-concern', 'blocking-concern', 'inconclusive'] },
    summary: { type: 'string', maxLength: 2000 },
    findings: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'category', 'file', 'location', 'explanation'],
        properties: {
          severity: { enum: ['important', 'caution', 'observation'] },
          category: { enum: ['behavior', 'dependency', 'capability', 'provenance', 'coverage', 'other'] },
          file: { type: 'string', maxLength: 512 },
          location: { type: ['string', 'null'], maxLength: 128 },
          explanation: { type: 'string', maxLength: 1000 },
        },
      },
    },
  },
});
  const INPUT = 'Classify this literal inert record using the supplied V2 output schema. Record: {"kind":"inert-capability-probe","change":"none","data":"A blue square is a blue square."}. Return schemaVersion 2, outcome no-blocking-concern, a short summary, and an empty findings array. This is a capability check with no candidate and no approval authority.';
  const MODALITIES = freezeReviewValue({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  });
  const startedAt = new Date().toISOString();
  const receipt = {
    probeRevision: 'resonant-sidecar.inert-capability.v1',
    inputSha256: '88f4231031edc2969eececefe010ebe8de434dbec7c106af1148e55413a42d63',
    schemaSha256: '25ef9c147e32bf985d9481d22e1e5f3ffa19859b3e72e751a7a1824631b20b00',
    startedAt, updatedAt: startedAt, finishedAt: null,
    sidePanelUrl: location.href, sidePanelOrigin: location.origin,
    availability: 'not-checked', state: 'checking', preparation: 'not-needed',
    preparationProgress: null, contextWindow: null, structuredOutput: 'not-run',
    abort: 'not-requested', preparationDestroy: 'not-created', runDestroy: 'not-created',
  };
  let api = null, root = null, statusText = null, prepareButton = null;
  let runButton = null, cancelButton = null, attached = false, listening = false;
  let phase = 'checking', stopReason = null, operation = null, timer = null;
  function publish(state, terminal = false) {
    receipt.state = state;
    receipt.updatedAt = new Date().toISOString();
    if (terminal) receipt.finishedAt = receipt.updatedAt;
    if (attached) statusText.textContent = state;
    console.log(JSON.stringify(receipt));
  }
  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function clearMonitor(op) {
    if (op?.monitor) {
      op.monitor.removeEventListener('downloadprogress', op.progress);
      op.monitor = null;
    }
  }
  function removeControls() {
    clearTimer();
    clearMonitor(operation);
    if (prepareButton) prepareButton.removeEventListener('click', prepare);
    if (runButton) runButton.removeEventListener('click', run);
    if (cancelButton) cancelButton.removeEventListener('click', cancel);
    if (listening) globalThis.removeEventListener('pagehide', pageHidden);
    listening = false;
    if (attached) root.remove();
    attached = false;
    root = null; statusText = null;
    prepareButton = null; runButton = null; cancelButton = null;
  }
  function destroy(op) {
    if (!op?.session) return;
    const held = op.session;
    op.session = null;
    try { held.destroy(); receipt[op.destroyField] = 'succeeded'; }
    catch { receipt[op.destroyField] = 'failed'; }
  }
  function complete(reason) {
    phase = 'terminal';
    removeControls();
    api = null;
    publish(receipt.preparationDestroy === 'failed' || receipt.runDestroy === 'failed'
      ? 'destroy-failed' : reason, true);
  }
  function stop(reason) {
    if (stopReason !== null || phase === 'terminal') return;
    stopReason = reason;
    phase = 'stopping';
    if (operation) {
      try { operation.controller.abort(); receipt.abort = 'requested'; }
      catch { receipt.abort = 'failed'; }
      destroy(operation);
    }
    removeControls();
    api = null;
    if (operation?.pending) publish(reason + '-pending');
    else complete(reason);
  }
  function arm(ms) { clearTimer(); timer = setTimeout(() => stop('timeout'), ms); }
  function direct(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return event.isTrusted === true;
  }
  function cancel(event) { if (direct(event)) stop('cancelled'); }
  function pageHidden() { stop('page-hidden'); }
  function begin(kind) {
    phase = kind === 'prepare' ? 'preparing' : 'running';
    prepareButton.disabled = true; runButton.disabled = true;
    const op = { controller: new AbortController(), session: null, pending: true,
      monitor: null, progress: null,
      destroyField: kind === 'prepare' ? 'preparationDestroy' : 'runDestroy' };
    receipt[op.destroyField] = 'pending';
    operation = op;
    arm(kind === 'prepare' ? 600000 : 60000);
    publish(phase);
    return op;
  }
  function watch(op, monitor) {
    if (stopReason !== null || !op.pending || op.monitor) return;
    op.monitor = monitor;
    op.progress = event => {
      if (stopReason !== null || !op.pending) return;
      const loaded = event.loaded;
      if (typeof loaded === 'number' && Number.isFinite(loaded) && loaded >= 0 && loaded <= 1) {
        if (op.destroyField === 'preparationDestroy') receipt.preparationProgress = loaded;
      }
    };
    monitor.addEventListener('downloadprogress', op.progress);
  }
  async function prepare(event) {
    if (!direct(event) || phase !== 'needs-preparation') return;
    receipt.preparation = 'preparing';
    const op = begin('prepare');
    let failed = false;
    try {
      op.session = await api.create({ ...MODALITIES, signal: op.controller.signal,
        monitor(monitor) { watch(op, monitor); } });
      if (stopReason === null) receipt.preparation = 'prepared';
    } catch {
      failed = true;
      if (stopReason === null) receipt.preparation = 'failed';
    } finally {
      op.pending = false;
      destroy(op);
      if (receipt.preparationDestroy === 'pending') receipt.preparationDestroy = 'not-created';
      clearMonitor(op); clearTimer(); operation = null;
      if (stopReason !== null) complete(stopReason);
      else if (failed || receipt.preparationDestroy === 'failed') complete('prepare-error');
      else {
        phase = 'ready';
        runButton.disabled = false;
        publish('prepared');
      }
    }
  }
  function matches(value, schema) {
    if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
    if (schema.enum && !schema.enum.includes(value)) return false;
    if (!schema.type) return true;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(type)) return false;
    if (type === 'string') return [...value].length <= schema.maxLength;
    if (type === 'array') return value.length <= schema.maxItems && value.every(item => matches(item, schema.items));
    if (type === 'object') {
      const keys = Object.keys(value);
      return keys.length === schema.required.length && schema.required.every(key => Object.hasOwn(value, key))
        && keys.every(key => Object.hasOwn(schema.properties, key) && matches(value[key], schema.properties[key]));
    }
    return true;
  }
  function validOutput(raw) {
    if (typeof raw !== 'string' || raw.length > 65536 || new TextEncoder().encode(raw).length > 65536) return false;
    try { return matches(JSON.parse(raw), SCHEMA); } catch { return false; }
  }
  async function run(event) {
    if (!direct(event) || phase !== 'ready') return;
    const op = begin('run');
    let result = 'run-error';
    let raw = null;
    try {
      op.session = await api.create({ ...MODALITIES, signal: op.controller.signal,
        monitor(monitor) { watch(op, monitor); } });
      if (stopReason !== null) return;
      const capacity = op.session.contextWindow;
      if (!Number.isSafeInteger(capacity) || capacity <= 0) return;
      receipt.contextWindow = capacity;
      raw = await op.session.prompt(INPUT, { responseConstraint: SCHEMA, signal: op.controller.signal });
      if (stopReason !== null) return;
      receipt.structuredOutput = validOutput(raw) ? 'passed' : 'failed';
      result = receipt.structuredOutput === 'passed' ? 'completed' : 'output-invalid';
    } catch {
      if (stopReason === null) receipt.structuredOutput = 'failed';
    } finally {
      raw = null;
      op.pending = false;
      destroy(op);
      if (receipt.runDestroy === 'pending') receipt.runDestroy = 'not-created';
      clearMonitor(op); clearTimer(); operation = null;
      complete(stopReason ?? result);
    }
  }
  try {
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(receipt.sidePanelOrigin)
      || receipt.sidePanelUrl !== receipt.sidePanelOrigin + '/sidepanel.html') {
      complete('context-invalid'); return;
    }
    root = document.createElement('div');
    statusText = document.createElement('p'); statusText.textContent = 'checking';
    prepareButton = document.createElement('button'); prepareButton.type = 'button';
    prepareButton.textContent = 'Prepare'; prepareButton.disabled = true;
    runButton = document.createElement('button'); runButton.type = 'button';
    runButton.textContent = 'Run inert probe'; runButton.disabled = true;
    cancelButton = document.createElement('button'); cancelButton.type = 'button';
    cancelButton.textContent = 'Cancel';
    prepareButton.addEventListener('click', prepare);
    runButton.addEventListener('click', run);
    cancelButton.addEventListener('click', cancel);
    root.append(statusText, prepareButton, runButton, cancelButton);
    document.body.append(root); attached = true;
    globalThis.addEventListener('pagehide', pageHidden); listening = true;
    api = globalThis.LanguageModel;
    if (!api || typeof api.availability !== 'function' || typeof api.create !== 'function') {
      complete('api-absent'); return;
    }
    arm(30000);
    let available;
    try { available = await api.availability(MODALITIES); }
    catch { if (stopReason === null) complete('availability-error'); return; }
    if (stopReason !== null) return;
    clearTimer();
    if (!['available', 'downloadable', 'downloading', 'unavailable'].includes(available)) {
      complete('availability-invalid'); return;
    }
    receipt.availability = available;
    if (available === 'unavailable') { complete('unavailable'); return; }
    if (available === 'available') { phase = 'ready'; runButton.disabled = false; }
    else { phase = 'needs-preparation'; receipt.preparation = 'required'; prepareButton.disabled = false; }
    publish(available);
  } catch { if (stopReason === null) complete('setup-error'); }
})();
```
<!-- END FROZEN PROBE -->

## Exact script receipt schema

Every Console entry is one immutable JSON string snapshot with exactly these
17 fields. No raw exception, output text, parsed analysis, summary, finding,
model name, prompt payload, or unlisted field is logged. Runtime timestamps are
ISO-8601 UTC strings produced locally; hashes and the revision are fixed literals.

| Field | Exact permitted value or type |
| --- | --- |
| `probeRevision` | `resonant-sidecar.inert-capability.v1` |
| `inputSha256` | `88f4231031edc2969eececefe010ebe8de434dbec7c106af1148e55413a42d63` (UTF-8 literal `INPUT`) |
| `schemaSha256` | `25ef9c147e32bf985d9481d22e1e5f3ffa19859b3e72e751a7a1824631b20b00` (`JSON.stringify(SCHEMA)` in insertion order) |
| `startedAt`, `updatedAt` | ISO-8601 UTC timestamp strings |
| `finishedAt` | `null` until terminal; then ISO-8601 UTC timestamp |
| `sidePanelUrl`, `sidePanelOrigin` | Only this Window's observed URL/origin; unexpected context stops before API use |
| `availability` | `not-checked`, `available`, `downloadable`, `downloading`, `unavailable` |
| `state` | `checking`, `available`, `downloadable`, `downloading`, `preparing`, `prepared`, `running`, `completed`, `context-invalid`, `api-absent`, `unavailable`, `availability-error`, `availability-invalid`, `setup-error`, `prepare-error`, `run-error`, `output-invalid`, `destroy-failed`, `cancelled-pending`, `cancelled`, `page-hidden-pending`, `page-hidden`, `timeout-pending`, `timeout` |
| `preparation` | `not-needed`, `required`, `preparing`, `prepared`, `failed` |
| `preparationProgress` | `null` or last finite numeric progress in `[0,1]` observed during Prepare |
| `contextWindow` | `null` or a positive safe integer observed from the run session |
| `structuredOutput` | `not-run`, `passed`, `failed`; shape validity only |
| `abort` | `not-requested`, `requested`, `failed`; API call outcome, not proof of browser internals |
| `preparationDestroy`, `runDestroy` | `not-created`, `pending`, `succeeded`, `failed`; destroy return/throw observation |

In a pending terminal request, listeners/controls/timers are already removed and
the signal has been aborted. `finishedAt:null` and the `-pending` state mean the
browser operation has not settled. A late session is destroyed without prompting;
late model output is discarded. Only settlement emits the final terminal entry.
If Chrome never settles, retain the pending observation and stop: do not claim
complete session cleanup or re-inject. The API may internally retain resources;
this same-realm script does not attest garbage collection or resist modified
browser/DOM intrinsics. A complete invocation leaves no exported globals or
registered probe listeners. The saved Console strings may remain in DevTools;
the script does not clear Console history or save anything to extension storage.

## Separate evidence sources for the later capability receipt

The script snapshots are one source. The existing runtime collector supplies the
Chrome executable, version, and signing observation; repository inspection supplies
the current exact manifest permission arrays. Record their own collection times,
paths, and hashes separately. Never place either observation inside the script
snapshot or attribute it to `LanguageModel`.

The outer human-assembled capability record also binds the approved script hash,
document commit, runtime generation, human approval and click sequence, observed
ordinary V1 native-Port boundary, lifecycle observations, and the non-attestation
labels. The ordinary port is pre-existing application state: it is never read,
written, closed, or used as probe transport. No capability receipt has been
collected at this authoring checkpoint, and the Task 10 receipt is unchanged.

## Manual human sequence after approval of this hash

1. Tom approves this exact script hash and resource consequence. Confirm from the
   existing fixed V1 side-panel status that no review or conversation turn is
   active. Identify its exact existing DevTools Window target and extension URL;
   compare identity and manifest permissions to the separate inspected evidence.
   Do not reload, replace, install, or activate an extension to make this work.
2. Tom pastes the complete frozen script once into that Console. Pasting checks
   API presence and availability only. Unsupported context/API, unavailable,
   invalid availability, timeout, or error removes the controls and stops. A
   flaky first call is recorded as failure; it is never automatically retried.
3. If `downloadable` or `downloading`, Tom may click Prepare. Wait for `prepared`;
   that preparation session has been destroyed. Tom then separately clicks Run
   inert probe. If initially `available`, Tom may click Run directly. Each enabled
   action accepts one trusted click, locks immediately, and is used at most once.
4. Cancel stops an in-progress attempt. The fixed time limits are 30 seconds for
   availability, 10 minutes for preparation, and 60 seconds for the run. These
   timers only cancel; they never create, prompt, or retry. Preserve the fixed
   terminal JSON and separate collector evidence before lifecycle actions.
5. A second inert invocation to exercise cancellation is permitted only after
   the first safe capability check and explicit human selection of that second
   check. Reinjection is a new explicit human action, never recovery or auto-retry.
   Do not inject while another invocation or its cleanup is pending.
6. Tom performs the later panel close/reopen and Chrome Dev exit/relaunch manually.
   Record terminal state and bound runtime generation before closing; after
   reopening, inspect that the old invocation cannot resume, no analysis auto-ran,
   and no session/candidate packet persisted. The probe itself persists neither.
   Record acquisition separately and qualify any network/locality observation.

Stop after this bounded capability receipt. No prepared stable-extension load,
native-host registration change, installation, V1 migration, real candidate review,
candidate activation, publication, push, fallback model, or old Task 12 is
authorized. The next artifact is a separately reviewed exact migration plan and
explicit human authorization for that mutation.

## Local authoring verification

The ignored Task 11 harness extracts the exact fenced script, verifies its SHA-256
and syntax, and executes it only against fake DOM/LanguageModel facilities. It
traps browser messaging, network, storage, native/Chrome, navigation, and code
generation; exercises direct gestures, failures, timeouts and late continuations;
and verifies output suppression, exact receipt keys, and listener/global/subtree
cleanup. RED/GREEN receipts and the self-review report remain under the ignored
`.superpowers/sdd/2026-09-14-chrome-native-semantic-review/` directory. This is a
source/lifecycle proof in a fake environment, not a real browser capability claim.
