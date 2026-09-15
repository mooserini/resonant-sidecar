# Chrome-Native Semantic Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one visible, user-triggered, no-tool Chrome on-device semantic-review prerequisite to the existing fail-closed refresh lifecycle while preserving deterministic review, isolated Codex review, explicit human acceptance, rollback, and durable receipts.

**Architecture:** The pinned bootstrap constructs one canonical evidence set from immutable active and staged bytes. Codex and Chrome receive that evidence independently; a visible side-panel action invokes one fresh `LanguageModel` session, while a narrowly scoped native result/cancel lane can settle only the invocation already issued by the bootstrap. V2 policy and receipt code add `chrome-semantic-review` without rewriting V1 history, and no acceptance nonce exists until all three required reviews are finalized.

**Tech Stack:** Chrome Dev Manifest V3 side panel; Chrome Prompt API (`LanguageModel.availability()`, `.create()`, `.prompt()`, `responseConstraint`, `AbortSignal`, `.destroy()`); dependency-free Node.js 22+ ESM and `node:test`; Chrome Native Messaging; Codex CLI; canonical JSON and SHA-256 receipts.

**Spec:** `docs/superpowers/specs/2026-09-14-chrome-native-semantic-review-amendment-design.md`

**Inherited base spec:** `docs/superpowers/specs/2026-09-14-visible-review-refresh-design.md`

**Primary API references:**

- `https://developer.chrome.com/docs/ai/prompt-api`
- `https://developer.chrome.com/docs/ai/structured-output-for-prompt-api`

## Global Constraints

- Do not push, add a Git remote, publish, install, migrate, re-register the native host, load a prepared stable extension, or activate a candidate under this plan.
- Do not invoke a real browser model until Task 11 reaches its explicit human-present checkpoint and Tom approves that exact inert probe.
- Keep `Llama.app`, `llama.cpp`, `gpt-oss-20b`, port `9931`, Google AI Edge Eloquent, its Gemma models, and every other local/localhost/cloud model outside the implementation. Tests must prove there is no fallback.
- Keep `extension/manifest.json` permissions exactly `nativeMessaging`, `sidePanel`, and `storage`; keep host permissions empty.
- Add no content script, page/tab/history/cookie/credential/clipboard access, CDP, WebMCP actuation, debugger permission, browser automation, persistent/background/application transport listener, tool callback, generalized RPC, or model-controlled action. Fixed DOM click handlers on the three visible side-panel controls are the only new event listeners.
- Treat candidate filenames, source, comments, documentation, fixtures, strings, and all model output as untrusted data.
- Preserve the isolated Codex CLI process-evidence requirement. Chrome receives its own provider-specific provenance record and never impersonates `codex-process-evidence`.
- The same canonical source evidence feeds Codex and Chrome independently. Neither initial request contains the other reviewer's verdict or prose.
- An unavailable, incomplete, malformed, unfavorable, inconclusive, stale, interrupted, or unsanitizable Chrome result withholds only the current candidate and preserves the active pin.
- Model preparation is visible and user-triggered. Preparation never begins analysis; only a fresh **Run local analysis** click may do that.
- Browser/model output never supplies trusted identities, digests, timestamps, permissions, paths, commands, URLs, nonce grants, policy, state, or activation decisions.
- Existing V1 receipts and their hashes remain valid under V1 rules. V2 appends history; it never rewrites, reinterprets, or silently repairs it.
- Generated task reports and capability receipts remain local and ignored. Track only code, schemas, tests, and explanatory documentation.
- Every implementation task starts with a failing test, ends with focused and proportional verification, and is committed separately.

---

## Current checkpoint

- Approved amendment commit: `02b8f8a` records Tom's artifact approval.
- The existing implementation remains preparation-only. The old Task 11 ended failed at `fe9db73`; its five-review history remains immutable and Task 12 was never started.
- This plan starts a new ledger at `.superpowers/sdd/2026-09-14-chrome-native-semantic-review/`. Do not edit or relabel `.superpowers/sdd/2026-09-14-visible-review-refresh/`.
- Each task receives one implementation pass, one spec-compliance review, one code-quality review, and at most two repair/rereview passes. A remaining blocker stops the task for a new design decision.

### Observed local capacity outside this design

A user-supplied Eloquent screenshot on 2026-09-14 shows Google AI Edge Eloquent reporting these on-device models as **Ready to use**: 524.4 MB of small dictation expert models, Gemma 4 2B at 2.4 GB, and Gemma 4 12B at 6.1 GB. This is evidence of substantial local inference capacity, not evidence that Chrome's Prompt API can invoke those artifacts or that Eloquent and Chrome share a model lifecycle, API, process, or provenance boundary.

Eloquent and its Gemma models are therefore observed but excluded. The sidecar does not inspect their files, invoke their processes, depend on Eloquent availability, or use them as a reviewer or fallback. Adopting them would require a separate design decision.

## File and interface map

| Responsibility | Files |
| --- | --- |
| Bounded bootstrap-source inspection | `scripts/build-initial-bundle.js`, `test/build-initial-bundle.test.js`, `README.md` |
| Versioned policy and analysis schema | `policy/review-policy.v2.json`, `policy/chrome-language-model.v2.schema.json`, `review/policy-registry.js` |
| Canonical source evidence | `review/source-diff.js`, `review/semantic-evidence.js`, `review/codex-prompt.js`, `review/chrome-review-contract.js`, `extension/chrome-review-contract.js` |
| Browser/host analysis contract | byte-identical `review/chrome-review-contract.js` and `extension/chrome-review-contract.js`, plus `review/chrome-review.js` and `review/chrome-provenance.js` |
| Versioned permanent receipts | `review/receipt-layout.js`, `review/receipt-store.js`, `review/redaction.js` |
| One-invocation transport custody | `bootstrap/chrome-review-journal.js`, `review/chrome-review-bridge.js`, `native-host/sidecar-protocol.js`, `bootstrap/host.js` |
| Visible on-device adapter | `extension/chrome-review-adapter.js`, `extension/sidepanel-controller.js`, `extension/sidepanel.js`, `extension/sidepanel.html`, `extension/sidepanel.css` |
| Eligibility and recovery | `review/review-state.js`, `review/review-coordinator.js` |
| Sealed installation preparation | `review/capability-diff.js`, `scripts/build-initial-bundle.js`, `scripts/install-macos.js`, `scripts/verify-install-plan.js` |
| Automated and human-present proof | `test/chrome-semantic-review.integration.test.js`, `test/fixtures/fake-chrome-language-model.js`, `docs/chrome-semantic-review-test-receipt.md`, `docs/chrome-language-model-capability-probe.md` |

### Task 1: Close the reproduced loader forms and state the bounded trust claim

**Files:**

- Modify: `scripts/build-initial-bundle.js`
- Modify: `test/build-initial-bundle.test.js`
- Modify: `README.md`

**Interfaces:**

- Consumes: committed trusted-bootstrap JavaScript bytes already passed to `moduleTokens(source, name)`.
- Produces: rejection of the four reproduced escaped/computed loader forms while retaining the claim that lexical inspection is defense-in-depth around an exact reviewed byte identity.
- Does not produce: a JavaScript semantic-equivalence proof or a general sandbox.

- [ ] **Step 1: Add the reproduced bypasses as failing regression cases**

```js
for (const [name, source] of [
  ['escaped eval identifier', String.raw`\u0065val("import('ambient')")`],
  ['escaped constructor identifier', String.raw`(async()=>{}).constr\u0075ctor("return import('ambient')")()`],
  ['computed createRequire property', `m['create' + 'Require'](import.meta.url)('ambient')`],
  ['computed builtin loader chain', `process['getBuiltin' + 'Module']('module')['create' + 'Require'](import.meta.url)('ambient')`],
]) {
  test(`trusted closure rejects ${name}`, async () => {
    await assert.rejects(() => inspectFixture({ 'bootstrap/host.js': source }), /loader|generation|syntax/i);
  });
}
```

- [ ] **Step 2: Run the focused regression and verify all four new cases fail**

Run: `node --test --test-name-pattern='escaped|computed' test/build-initial-bundle.test.js`

Expected: the new cases report missing rejection because the current scanner tokenizes the escape and constant property fragments separately.

- [ ] **Step 3: Add conservative escape rejection and constant computed-property folding**

```js
if (character === '\\') failSyntax('identifier escapes are forbidden in trusted control code');

function staticComputedName(tokens, openIndex) {
  let value = '';
  for (let i = openIndex + 1, wantString = true; i < tokens.length; i += 1) {
    if (tokens[i].value === ']') return wantString ? null : value;
    if (wantString && tokens[i].type === 'string' && !tokens[i].escaped) value += tokens[i].value;
    else if (!wantString && tokens[i].value !== '+') return null;
    else if (wantString) return null;
    wantString = !wantString;
  }
  return null;
}
```

Reject a folded name when it equals a member of `generatedCodeOrLoader` or `constructor`. Reject escaped string tokens used as computed property names rather than attempting to interpret their runtime value.

- [ ] **Step 4: Narrow the README claim and preserve the exact reviewed-byte boundary**

Replace “rejects executable uses” with wording that names recognized literal, escaped-identifier, and statically foldable computed-property forms. State immediately afterward that arbitrary JavaScript equivalence remains outside the detector's guarantee and that the exact committed bootstrap bytes are the trust root.

- [ ] **Step 5: Verify and commit**

Run:

```sh
node --test test/build-initial-bundle.test.js
npm run check
git diff --check
```

Commit: `fix: bound trusted loader inspection claims`

### Task 2: Add explicit V2 policy, schema, and control-plane identity

**Files:**

- Create: `policy/review-policy.v2.json`
- Create: `policy/chrome-language-model.v2.schema.json`
- Create: `review/policy-registry.js`
- Create: `test/policy-registry.test.js`
- Verify unchanged: `policy/review-policy.v1.json`

**Interfaces:**

- Produces: `loadReviewPolicy(version): Readonly<object>`, `reviewPolicyDigest(version): string`, and `assertSupportedReviewPolicy(value): Readonly<object>`.
- V2 adds `chrome-semantic-review`, two required semantic reviewers, fixed application limits, and exact `trustedControlPaths`.
- V1 remains byte-identical with digest `2c800a3dbb7520e37129213f0dabb648bca6cde03ed3180c91faee1f868f0821`.

- [ ] **Step 1: Write failing policy-version and state-graph tests**

```js
assert.equal(reviewPolicyDigest(1), '2c800a3dbb7520e37129213f0dabb648bca6cde03ed3180c91faee1f868f0821');
assert.deepEqual(loadReviewPolicy(2).stateTransitions['codex-review'], ['chrome-semantic-review', 'review-failed', 'custody-broken']);
assert.deepEqual(loadReviewPolicy(2).stateTransitions['chrome-semantic-review'], ['eligible', 'review-failed', 'custody-broken']);
assert.deepEqual(loadReviewPolicy(2).semanticReviewers, [
  { id: 'codex-cli', required: true },
  { id: 'chrome-language-model', required: true, modelIdentityAssurance: 'not-attested' },
]);
```

Define `trustedControlPaths` as the bytewise-sorted unique union of the final V2 trusted-bootstrap graph and these stable delivery files: `extension/manifest.json`, `extension/service-worker.js`, `extension/sidepanel-controller.js`, `extension/sidepanel.js`, `extension/sidepanel.html`, `extension/sidepanel.css`, `extension/chrome-review-contract.js`, `extension/chrome-review-adapter.js`, `native-host/sidecar-protocol.js`, `scripts/build-initial-bundle.js`, `scripts/install-macos.js`, and `scripts/verify-install-plan.js`.

The final V2 trusted-bootstrap graph is the existing `TRUSTED_BOOTSTRAP_FILES` list plus exactly: `bootstrap/chrome-review-journal.js`, `policy/review-policy.v2.json`, `policy/chrome-language-model.v2.schema.json`, `review/policy-registry.js`, `review/source-diff.js`, `review/semantic-evidence.js`, `review/chrome-review-contract.js`, `review/chrome-review.js`, `review/chrome-provenance.js`, `review/receipt-layout.js`, and `review/chrome-review-bridge.js`. Task 2 freezes that final path set before those modules exist; Task 9 makes `TRUSTED_BOOTSTRAP_FILES` exactly equal to the frozen bootstrap subset. Neither task silently discovers new paths. Assert exact equality rather than containment so any missing or unclassified control-plane file fails.

- [ ] **Step 2: Run `node --test test/policy-registry.test.js` and confirm missing V2 contract failures**

- [ ] **Step 3: Create the exact Chrome analysis schema**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "outcome", "summary", "findings"],
  "properties": {
    "schemaVersion": { "const": 2 },
    "outcome": { "enum": ["no-blocking-concern", "blocking-concern", "inconclusive"] },
    "summary": { "type": "string", "maxLength": 2000 },
    "findings": {
      "type": "array",
      "maxItems": 100,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "category", "file", "location", "explanation"],
        "properties": {
          "severity": { "enum": ["important", "caution", "observation"] },
          "category": { "enum": ["behavior", "dependency", "capability", "provenance", "coverage", "other"] },
          "file": { "type": "string", "maxLength": 512 },
          "location": { "type": ["string", "null"], "maxLength": 128 },
          "explanation": { "type": "string", "maxLength": 1000 }
        }
      }
    }
  }
}
```

Trusted validation further restricts `file` and `location` to identities actually supplied in the evidence packet.

- [ ] **Step 4: Implement the frozen registry and V2 policy**

```js
const policies = new Map([[1, V1], [2, V2]]);
export function loadReviewPolicy(version) {
  const policy = policies.get(version);
  if (!policy) throw new TypeError('Unsupported review policy version');
  return structuredClone(policy);
}
export const reviewPolicyDigest = version => sha256Json(loadReviewPolicy(version));
```

Set V2 application caps to 131,072 UTF-8 bytes for a complete semantic evidence packet, 65,536 UTF-8 bytes for raw model output, one outstanding Chrome invocation, a 10-minute ready-to-result expiry, a 60-second in-browser inference timeout, and zero automatic retries. Browser-reported context capacity may lower the effective input limit but may never raise these caps.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/policy-registry.test.js test/review-state.test.js && npm run check && git diff --check`

Commit: `feat: define versioned Chrome review policy`

### Task 3: Build one complete canonical source-evidence packet

**Files:**

- Create: `review/source-diff.js`
- Create: `review/semantic-evidence.js`
- Create: `review/chrome-review-contract.js`
- Create: `extension/chrome-review-contract.js`
- Create: `test/source-diff.test.js`
- Create: `test/semantic-evidence.test.js`
- Modify: `review/codex-prompt.js`
- Modify: `test/codex-verifier.test.js`

**Interfaces:**

```js
buildSourceDiff({ activeRoot, candidateRoot, activeManifest, candidateManifest })
// -> CompleteSourceDiff | IncompleteSourceDiff

buildSemanticEvidence({ reviewId, activeManifest, candidateManifest, policy, deterministic, sourceDiff })
// -> { evidence, evidenceDigest }

buildChromeReviewRequest({ evidence, evidenceDigest, invocationId, runtimeGeneration, adapterDigest, deadline })
// -> ReadyChromeReviewRequest | IncompleteChromeReviewRequest
```

`CompleteSourceDiff.changedFiles` contains `{ path, change, beforeSha256, afterSha256, beforeBytes, afterBytes, beforeText, afterText }`. Its coverage table names every changed file and records each supplied side as `{ byteLength, ranges: [[0, byteLength]], omittedRanges: [] }`. It includes full verified UTF-8 before/after bytes for every changed approved text file; it never contains a model- or candidate-authored summary. `IncompleteSourceDiff` is a distinct non-promptable type containing only trusted hashes, byte counts, and exact omitted ranges.

`ReadyChromeReviewRequest.packet` is the canonical Chrome envelope required by the amendment: review and invocation IDs; active, candidate, and policy digests; both manifests; the complete source diff and coverage table; sanitized deterministic results; fixed prompt/schema identities; adapter digest; runtime generation; and deadline. `inputDigest`, `promptDigest`, and `schemaDigest` are computed by trusted code outside the model-authored body and copied into the transport binding.

- [ ] **Step 1: Write failing tests for actual changed bytes and complete coverage**

```js
const diff = await buildSourceDiff({ activeRoot, candidateRoot, activeManifest, candidateManifest });
assert.equal(diff.coverageStatus, 'complete-input-supplied');
assert.deepEqual(diff.changedFiles[0], {
  path: 'native-host/host.js',
  change: 'modified',
  beforeSha256: sha256Bytes('export const value = 1;\n'),
  afterSha256: sha256Bytes('export const value = 2;\n'),
  beforeBytes: 24,
  afterBytes: 24,
  beforeText: 'export const value = 1;\n',
  afterText: 'export const value = 2;\n',
});
```

Add cases for added/deleted files, manifest/hash mismatch, invalid UTF-8, symlinks, ordering, oversized complete input, mutation during reread, and candidate filenames containing control characters.

- [ ] **Step 2: Run `node --test test/source-diff.test.js test/semantic-evidence.test.js` and confirm missing-module failures**

- [ ] **Step 3: Implement manifest-bound full-file differences**

Read only manifest-listed regular files, verify each byte hash before comparison, sort paths bytewise, and compute the canonical encoded size. Build the complete source evidence first, then have `buildChromeReviewRequest()` enforce the fixed 131,072-byte packet limit. If the complete packet exceeds the limit, return the distinct non-promptable `IncompleteChromeReviewRequest` with trusted hashes, byte counts, and exact omitted ranges; never return a partial packet or summarized source.

- [ ] **Step 4: Feed the identical evidence body to both reviewer prompt builders**

```js
const { evidence, evidenceDigest } = buildSemanticEvidence(input);
const codexPrompt = buildCodexReviewPrompt({ evidence, evidenceDigest });
const chromeRequest = buildChromeReviewRequest({
  evidence,
  evidenceDigest,
  invocationId,
  runtimeGeneration,
  adapterDigest,
  deadline,
});
```

Each prompt adds only its trusted fixed wrapper. Neither accepts a prior reviewer result. The Chrome request must assert `coverageStatus === 'complete-input-supplied'` before exposing `packet`; both semantic prompt builders reject the incomplete type. Generate the Node and extension contract modules from the same literal source in the test fixture and assert byte-for-byte equality plus one shared SHA-256; later tasks may not edit one without the other. Replace the installer's declaration-only sentence in a focused test with an assertion that the changed source bytes occur in `evidence.sourceDiff.changedFiles`.

- [ ] **Step 5: Make incomplete evidence structurally non-promptable**

Add a fixture showing that `IncompleteChromeReviewRequest` has no `packet`, that both prompt builders reject it, and that its trusted terminal description is fixed to `outcome: inconclusive`, `coverageStatus: incomplete-input`, `executionStatus: not-run`, and `reasonCode: incomplete-input`. Task 8 wires this branch before `codex-review`, proves neither semantic reviewer is invoked, appends the Chrome failure artifact, transitions to `review-failed`, and preserves the active pin. Hashes-only evidence is never submitted as semantic source review.

- [ ] **Step 6: Verify and commit**

Run: `node --test test/source-diff.test.js test/semantic-evidence.test.js test/codex-verifier.test.js && npm run check && git diff --check`

Commit: `feat: build canonical semantic review evidence`

### Task 4: Strictly validate Chrome analysis and honest provenance

**Files:**

- Modify: `extension/chrome-review-contract.js`
- Modify identically: `review/chrome-review-contract.js`
- Create: `review/chrome-review.js`
- Create: `review/chrome-provenance.js`
- Create: `test/chrome-review-contract.test.js`
- Create: `test/chrome-review.test.js`
- Create: `test/chrome-provenance.test.js`

**Interfaces:**

```js
parseChromeAnalysis(rawText, { suppliedFiles, suppliedLocations, maxBytes })
// -> deeply frozen ChromeAnalysis

bindChromeReviewResult({ request, rawText, browserObservation, componentObservation, completedAt })
// -> ChromeReviewResult
```

- [ ] **Step 1: Write failing adversarial parser tests**

Cover duplicate JSON keys, trailing prose, code fences, extra fields, accessors/proxies, oversized/deep output, invalid UTF-8, unsupported schema version, invented file/hunk references, URL/action/command fields, `no-blocking-concern` with an `important` finding, and prototype-shaped keys.

```js
assert.throws(
  () => parseChromeAnalysis('{"outcome":"no-blocking-concern","outcome":"blocking-concern"}', context),
  /duplicate/i,
);
assert.throws(() => parseChromeAnalysis(JSON.stringify({ ...valid, openUrl: 'https://example.test' }), context), /schema/i);
```

- [ ] **Step 2: Run the three focused test files and confirm missing-module failures**

- [ ] **Step 3: Implement one dependency-free exact JSON/schema contract usable by browser and Node**

The two contract files must remain byte-identical, dependency-free ESM. The parser must scan duplicate keys before `JSON.parse`, reject non-plain structures, enforce exact properties and all length/depth/count limits, validate references against the supplied evidence, canonicalize the accepted object, and deep-freeze the result. Browser-side validation is defense-in-depth; `review/chrome-review.js` imports the trusted-bootstrap copy and repeats validation after the native boundary. Every focused test asserts both contract hashes are equal.

- [ ] **Step 4: Implement provider-specific provenance without a fake PID**

```js
const provenance = Object.freeze({
  reviewerId: 'chrome-language-model',
  provenanceKind: 'observed-local-components',
  modelIdentityAssurance: 'not-attested',
  inferenceBinding: 'not-established',
  browserObservation,
  componentObservation,
});
```

Reject model-supplied identity fields. Preserve the independent Codex `codex-process-evidence` requirement unchanged.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/chrome-review-contract.test.js test/chrome-review.test.js test/chrome-provenance.test.js && npm run check && git diff --check`

Commit: `feat: validate Chrome semantic analysis`

### Task 5: Append V2 semantic receipts without rewriting V1 history

**Files:**

- Create: `review/receipt-layout.js`
- Create: `test/receipt-layout.test.js`
- Create: `test/fixtures/receipts/v1/README.md`
- Modify: `review/receipt-store.js`
- Modify: `review/redaction.js`
- Modify: `review-receipts/README.md`
- Modify: `test/receipt-store.test.js`
- Modify: `test/redaction.test.js`

**Interfaces:**

- `receiptLayoutFor(policySnapshot, eventRecord): ReceiptLayout` returns the exact allowed files and validators for that receipt's own policy snapshot and immutable event kind.
- V2 adds `semanticReviewsHash` to `receipt.json`. Before a Chrome terminal artifact exists—including the receipt recording entry into `chrome-semantic-review`—it must be `null` and the semantic-review directory must be absent. The first subsequent `eligible` or `review-failed` event must hash the required `semantic-reviews/chrome-language-model.json` artifact, and every later event for that review carries the same artifact forward.
- `ReceiptStore.verifyChain()` accepts an intact V1 prefix followed by V2 reviews while validating each receipt under its recorded policy.

The V2 Chrome artifact has exactly the trusted fields specified by the amendment: `schemaVersion`, `reviewerId`, `evidenceKind`, `reviewerRequirement`, `provenanceKind`, `modelIdentityAssurance`, `inferenceBinding`, `reviewId`, `invocationId`, `runtimeGeneration`, `activeBundleDigest`, `candidateBundleDigest`, `policySnapshotHash`, `inputDigest`, `promptDigest`, `schemaDigest`, `adapterDigest`, `coverageStatus`, `availabilityStatus`, `executionStatus`, `reasonCode`, `startedAt`, `completedAt`, `browserObservation`, `componentObservation`, `analysis`, `analysisDigest`, and `eligibilityEffect`. Only `analysis` originates with the model; trusted code assigns every other field.

- [ ] **Step 1: Create a golden V1 fixture and failing mixed-chain tests**

Generate the fixture once with the pre-V2 code, record its file hashes in `test/fixtures/receipts/v1/README.md`, and assert the fixture verifies after V2 support lands. Add a V1→V2 chain test and assert no V1 directory gains a semantic-review file. For V2, assert `available`, `staged`, `deterministic-review`, `codex-review`, and the entry `chrome-semantic-review` event have `semanticReviewsHash: null` and no semantic-review directory; the following `eligible` or `review-failed` event atomically introduces the artifact and every later event carries it forward under its bound hash.

- [ ] **Step 2: Run `node --test test/receipt-layout.test.js test/receipt-store.test.js test/redaction.test.js` and verify the mixed-chain cases fail**

- [ ] **Step 3: Implement exact version-selected layouts**

```js
export function receiptLayoutFor(policy, eventRecord) {
  if (policy.schemaVersion === 1) return V1_LAYOUT;
  if (policy.schemaVersion === 2) {
    return eventRecord.semanticReviewsHash === null ? V2_PRE_CHROME_LAYOUT : V2_CHROME_BOUND_LAYOUT;
  }
  throw new TypeError('Unsupported receipt policy version');
}
```

Read `policy-snapshot.json` and the fixed-shape event record first, verify both against the frozen registry, then validate the exact layout. A null hash with a semantic artifact, a non-null hash without one, or any later event that drops/changes its already-bound Chrome artifact is a custody break. Do not select a schema from mutable current configuration or a filename.

- [ ] **Step 4: Add narrow semantic-review sanitization and terminology checks**

Allow only the amendment's fields and fixed reason codes. The V2 code list includes the amendment's enumerated failure categories plus `terminal-receipt-interrupted` for the crash window defined in Tasks 6 and 8; no raw exception can become a reason code. Reject raw prompts/source, profile paths, arbitrary browser dumps, URLs, commands, candidate/model metadata, and the phrases `Gemini-attested`, `verified Gemini weights`, `cryptographic model attestation`, `independent proof`, and `safe to activate`.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/receipt-layout.test.js test/receipt-store.test.js test/redaction.test.js && npm run check && git diff --check`

Commit: `feat: retain versioned semantic review receipts`

### Task 6: Add the durable one-invocation journal and narrow result/cancel lane

**Files:**

- Create: `bootstrap/chrome-review-journal.js`
- Create: `review/chrome-review-bridge.js`
- Create: `test/chrome-review-journal.test.js`
- Create: `test/chrome-review-bridge.test.js`
- Modify: `native-host/sidecar-protocol.js`
- Modify: `bootstrap/host.js`
- Modify: `test/sidecar-protocol.test.js`
- Modify: `test/bootstrap-host.test.js`
- Modify: `test/review-runtime-races.test.js`

**Interfaces:**

```js
ChromeReviewBridge.request({ binding, packet, deadline }): Promise<ChromeReviewResult>
ChromeReviewBridge.handleSettlement(message): boolean
ChromeReviewBridge.close(reasonCode): Promise<void>
ChromeReviewJournal.recoveryState(): 'empty' | 'pending' | 'terminal-unreceipted' | 'receipted'
ChromeReviewJournal.markReceipted(receiptHash): Promise<void>
```

The journal stores only trusted request bindings and status—never source text or model output—at `runtime/chrome-review-pending.json` before the request is emitted.

- [ ] **Step 1: Write failing protocol and race tests**

Define exact messages `review.chromeReady`, `review.chromeResult`, and `review.chromeCancel`. Bind every one to `reviewId`, `candidateDigest`, `policyDigest`, `invocationId`, `runtimeGeneration`, `inputDigest`, `promptDigest`, `schemaDigest`, and `adapterDigest`.

Test unsolicited, duplicate, stale, cross-review, cross-candidate, cross-policy, cross-port, cross-restart, post-timeout, and post-cancel responses. Test that `review.start`, navigation, decision grants, paths, tools, commands, and extra fields cannot use the narrow lane. Add crash fixtures for pending, terminal-unreceipted, receipt-committed-before-journal-mark, and fully receipted states.

- [ ] **Step 2: Run the focused files and confirm the current `busy` gate drops valid result/cancel messages**

- [ ] **Step 3: Implement atomic journal custody**

Write a canonical owner-only pending record to a temporary sibling, fsync it, and rename before emitting `review.chromeReady`. Completion or cancellation replaces it with a terminal fixed-code record containing `receiptCommitted: false` before resolving the bridge. After the permanent receipt commits, `markReceipted(receiptHash)` atomically records its bound hash. On restart, a pending record becomes `interrupted-restart`; a terminal-unreceipted record is exposed for Task 8 reconciliation; neither is resumed and no invocation ID is reused.

- [ ] **Step 4: Implement the single-purpose busy-gate exception**

```js
const settlement = parseChromeSettlement(value);
if (settlement) return chromeBridge.handleSettlement(settlement); // one issued invocation only
if (closed || busy) return Promise.resolve();
```

The bridge validates exact bindings before it can resolve the pending promise. It cannot invoke the coordinator, start another review, issue a nonce, navigate, or mutate policy.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/chrome-review-journal.test.js test/chrome-review-bridge.test.js test/sidecar-protocol.test.js test/bootstrap-host.test.js test/review-runtime-races.test.js && npm run check && git diff --check`

Commit: `feat: bind one Chrome review invocation`

### Task 7: Add the visible no-tool Chrome adapter and controls

**Files:**

- Create: `extension/chrome-review-adapter.js`
- Create: `test/chrome-review-adapter.test.js`
- Modify: `extension/sidepanel-controller.js`
- Modify: `extension/sidepanel.js`
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.css`
- Modify: `test/extension-contract.test.js`

**Interfaces:**

```js
createChromeReviewAdapter({ languageModel, sendResult, sendCancel, onState, clock, setTimer, clearTimer })
// -> { inspect(request), prepare(), run(), cancel(reasonCode), destroy(reasonCode) }
```

- [ ] **Step 1: Write failing fake-`LanguageModel` lifecycle tests**

Prove zero `LanguageModel` calls on installation, startup, panel opening, and update discovery. After the bound `review.chromeReady` packet arrives, permit exactly one bounded `availability()` feature-detection call while proving zero `create()` or `prompt()` calls. When preparation is required, assert the visible disclosure reads exactly **Chrome may download and store an on-device model. Preparation does not run analysis.** before the enabled **Prepare Chrome reviewer** button. Prove that button calls `create()` only from its direct click, sends no candidate prompt, destroys the preparation session, and does not call `run()`. Prove **Run local analysis** creates a separate fresh session and calls `prompt()` once.

- [ ] **Step 2: Add failure and cancellation tests**

Cover `unavailable`, `downloadable`, `downloading`, `available`, unknown availability, rejected preparation, `QuotaExceededError`, timeout, abort during creation/prompting, `pagehide`, native disconnect, generation change, and emergency stop. Assert every created session is destroyed exactly once and a late result is discarded. The emergency-stop test must prove the existing prominent Stop invokes adapter abort, sends one bound `review.chromeCancel` with fixed `emergency-stop`, terminalizes the journal/bridge, causes the coordinator to finalize a permanent `review-failed` receipt, and still performs its existing conversation-interrupt behavior without deleting prior evidence.

- [ ] **Step 3: Implement the documented Prompt API calls with dependency injection**

```js
const modalities = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
const availability = await languageModel.availability(modalities);
const session = await languageModel.create({
  ...modalities,
  initialPrompts: [{ role: 'system', content: FIXED_CHROME_SYSTEM_PROMPT }],
  signal: controller.signal,
  monitor,
});
const raw = await session.prompt(request.packet, {
  signal: controller.signal,
  responseConstraint: CHROME_ANALYSIS_SCHEMA,
});
```

Use no tools, functions, sampling loop, repair prompt, session history, page content, conversation text, storage, remote API, or alternate model. Always call `session.destroy()` in `finally`.

- [ ] **Step 4: Add accessible preparation/run/cancel states without exposing model prose**

Add buttons **Prepare Chrome reviewer**, **Run local analysis**, and **Cancel analysis**. When preparation is required, render the exact resource-consequence disclosure **Chrome may download and store an on-device model. Preparation does not run analysis.** immediately before Prepare; the button stays disabled until that state and disclosure are visible. Preserve keyboard order, visible focus, the exact failure card, conversation input, conversation Stop, and the emergency Stop behavior. Route the emergency Stop through one controller method that first invalidates the active Chrome invocation/generation and initiates bound cancellation, then invokes the existing conversation interrupt; neither half waits for the other before the UI becomes stopped. Render fixed state labels only; never place raw candidate or model text in the DOM.

- [ ] **Step 5: Prove the manifest and fallback boundary are unchanged**

Assert the permission arrays are unchanged, host permissions remain empty, `service-worker.js` still only opens the side panel, and production source contains no `fetch`, localhost, `9931`, `llama`, `gpt-oss`, Eloquent/Gemma process invocation, cloud endpoint, content-script, tabs, cookies, history, debugger, or scripting call.

- [ ] **Step 6: Verify and commit**

Run: `node --test test/chrome-review-adapter.test.js test/extension-contract.test.js && npm run check && git diff --check`

Commit: `feat: add visible Chrome review controls`

### Task 8: Require finalized Chrome review before human eligibility

**Files:**

- Modify: `review/review-state.js`
- Modify: `review/review-coordinator.js`
- Modify: `test/review-state.test.js`
- Modify: `test/review-coordinator.test.js`
- Modify: `test/review-runtime-races.test.js`

**Interfaces:**

- `ReviewCoordinator.startReview()` retains its public promise but now awaits the constructor-bound `chromeReview(request)` after Codex finalization.
- The narrow bridge settles that dependency while the outer lifecycle router remains busy.
- `eligible` and both human decision nonces exist only after the V2 Chrome artifact is finalized and reread from the receipt store.

- [ ] **Step 1: Write failing exact-state and nonce tests**

```js
const pending = coordinator.startReview();
await chromeBridge.whenRequested();
assert.equal(coordinator.state, 'chrome-semantic-review');
assert.equal(nonceStore.issued.length, 0);
chromeBridge.resolve(favorableBoundResult);
const eligible = await pending;
assert.equal(eligible.state, 'eligible');
assert.equal(nonceStore.issued.length, 2);
```

Add failures for every nonfavorable Chrome terminal state, favorable Chrome after deterministic/Codex failure, cleanup/finalization failure after a favorable callback, restart with a pending journal, changed evidence/policy/adapter/runtime generation, replayed results, and any attempted human nonce/click override after a required gate fails. Add the incomplete-input branch before Codex and assert neither `codexReview` nor the Chrome adapter is invoked, the trusted inconclusive Chrome artifact is finalized with `reasonCode: incomplete-input`, and the active pin remains unchanged. Add an emergency-stop race proving the bridge/journal becomes terminal, the review finalizes as `review-failed`, and late model completion cannot restore eligibility.

Add a crash matrix for a terminal journal record whose semantic receipt is absent, present but not yet marked in the journal, or fully marked. Recovery must append exactly one permanent failed semantic artifact with fixed `reasonCode: terminal-receipt-interrupted` when absent, never reconstruct a favorable result or issue a nonce, then atomically mark the journal with the committed receipt hash. If the matching receipt already exists, verify its hash and only mark the journal. Repeated recovery is idempotent; a conflicting receipt or journal binding is `custody-broken`.

- [ ] **Step 2: Run the focused coordinator/state/race tests and verify they fail at the current `codex-review -> eligible` shortcut**

- [ ] **Step 3: Inject the V2 policy and Chrome dependency without weakening Codex custody**

```js
await this.#move('chrome-semantic-review');
const chrome = await this.#d.chromeReview({
  binding: this.#semanticBinding,
  evidence: clone(this.#semanticEvidence),
  policy: clone(this.#d.policy),
});
if (!this.#boundChromeResult(chrome)) {
  await this.#move('review-failed', chrome.reasonCode);
  return this.#view();
}
```

Before moving to `codex-review`, branch on `IncompleteChromeReviewRequest` and finalize its trusted not-run semantic artifact plus `review-failed`; never hand its hashes-only metadata to either semantic reviewer. Keep the Codex verifier PID/evidence sample and final cleanup check exactly separate. Change its comment from “grant eligibility” to “satisfy the Codex prerequisite.”

- [ ] **Step 4: Finalize and reread the Chrome artifact before issuing nonces**

Require `outcome === 'no-blocking-concern'`, `coverageStatus === 'complete-input-supplied'`, exact bindings, successful sanitization, terminal bridge cleanup, and a matching retained analysis digest. After `finalizeEvent()` returns, call `markReceipted(receipt.receiptHash)`; a failure before that mark is reconciled by the idempotent startup rule above. Model unavailability or disagreement ends only the attempt as `review-failed`; evidence corruption remains `custody-broken`.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/review-state.test.js test/review-coordinator.test.js test/review-runtime-races.test.js && npm run check && git diff --check`

Commit: `feat: require Chrome semantic review for eligibility`

### Task 9: Rebuild the sealed V2 control plane and dry-run installer

**Files:**

- Modify: `review/capability-diff.js`
- Modify: `scripts/build-initial-bundle.js`
- Modify: `scripts/install-macos.js`
- Modify: `scripts/verify-install-plan.js`
- Modify: `test/capability-diff.test.js`
- Modify: `test/build-initial-bundle.test.js`
- Modify: `test/install-macos.test.js`
- Modify: `README.md`
- Modify: `docs/migration-runbook.md`

**Interfaces:**

- Ordinary candidates may include trusted-control paths only when their bytes equal the active pinned versions.
- A change to the adapter, prompt, schema, parser, policy, receipt validator, protocol, dialog, or activation code returns `control-plane-migration-required`.
- `buildInstallPlan()` remains dry-run by default and contains the exact V2 trusted-bootstrap, stable-extension, policy, schema, and adapter digests.

- [ ] **Step 1: Write failing frozen-control-plane and installer tests**

Mutate each trusted control family independently and assert hard failure. Assert a normal conversation-only candidate with identical control-plane bytes can still reach review. Assert the generated runtime contains the actual canonical semantic evidence builder and contains none of the old declaration-only `diff` sentence.

- [ ] **Step 2: Run the focused build/capability/install tests and verify the new V2 inventory assertions fail**

- [ ] **Step 3: Expand the exact sealed graph**

Add every V2 policy/schema, evidence, contract, receipt, bridge, journal, adapter, and coordinator file to the appropriate trusted-bootstrap or stable-extension inventory. Verify all relative imports terminate inside that graph, require `review/chrome-review-contract.js` and `extension/chrome-review-contract.js` to be byte-identical, and bind both paths to that one source digest in the install plan.

- [ ] **Step 4: Generate V2 runtime wiring from exact digests**

The generated `runtime-entry.js` loads V2 explicitly, constructs the semantic evidence once, binds the Chrome bridge and journal, retains the isolated Codex verifier, and records provider-specific provenance. Do not add a model server, localhost request, browser flag mutation, or model download action.

- [ ] **Step 5: Keep every installation action behind the existing exact reviewed-hash gate**

Exercise dry-run construction and stored-plan verification only. Tests must prove no filesystem installation target, Chrome registration, stable extension, or live process changes without the existing explicit migration arguments and a separately approved reviewed plan hash.

- [ ] **Step 6: Verify and commit**

Run: `node --test test/capability-diff.test.js test/build-initial-bundle.test.js test/install-macos.test.js && npm run check && git diff --check`

Commit: `feat: prepare sealed Chrome review runtime`

### Task 10: Prove the complete mocked lifecycle and authority boundary

**Files:**

- Create: `test/fixtures/fake-chrome-language-model.js`
- Create: `test/chrome-semantic-review.integration.test.js`
- Create: `docs/chrome-semantic-review-test-receipt.md`
- Create: `scripts/verify-receipt-chain.js`
- Modify: `package.json`

**Interfaces:**

- Adds `check:chrome-review` for the complete fake-adapter lifecycle.
- Adds or extends `verify:receipts` for mixed V1/V2 chain verification.
- Uses no Chrome process, model, network, installer, migration, or candidate activation.

- [ ] **Step 1: Write a failing integration matrix with the fake adapter**

Cover the complete success path and every failure category from the amendment: API absent, setup required/declined, unavailable, quota, timeout, cancellation, page close, restart, connection loss, incomplete input, malformed/extra/duplicate output, unfavorable/inconclusive analysis, provenance drift, sanitization failure, custody failure, stale/duplicate/cross-boundary result, emergency stop, late completion, and terminal-journal/permanent-receipt crash recovery before and after the receipt commit.

- [ ] **Step 2: Add authority invariants to every case**

Assert unchanged active pin, no nonce before three finalized stages, no model-authored command/path/URL/permission/state, no fallback call, no new listener, no transcript/page input, one terminal receipt, and intact historical V1 verification.

- [ ] **Step 3: Add exact package scripts**

```json
{
  "check:chrome-review": "node --test test/chrome-semantic-review.integration.test.js test/review-runtime-races.test.js",
  "verify:receipts": "node scripts/verify-receipt-chain.js"
}
```

- [ ] **Step 4: Run the complete automated gate**

Run:

```sh
npm run check
npm run check:chrome-review
npm run verify:receipts
git diff --check
git status --short --branch
git remote -v
```

Expected: all automated checks pass; receipt verification names an intact mixed-chain tail; the only source changes are the task's intended files; no remote appears.

- [ ] **Step 5: Commit the mocked proof**

Commit: `test: prove Chrome semantic review boundary`

### Task 11: Run one human-present inert Chrome Dev capability check, then stop

**Files:**

- Create: `docs/chrome-language-model-capability-probe.md`
- Update after the check: `docs/chrome-semantic-review-test-receipt.md`
- Local ignored evidence: `review-receipts/runtime-comparisons/<timestamp>-chrome-language-model-capability/`

**Interfaces:**

- Uses the current unpacked V1 development side panel's own DevTools `Window` context. Tom pastes one hash-reviewed self-contained script into that target's DevTools Console; the script injects ephemeral **Prepare**, **Run inert probe**, and **Cancel** buttons into the current document and removes them plus every probe binding at completion.
- The script sends inert fixed text only and contains no Chrome messaging/native-host API call. The V1 side panel's ordinary pre-existing native port is recorded as an observed boundary but is never read from, written to, closed by, or used to transport the probe. No review or conversation turn may be active when the script is injected.
- It does not inspect a candidate, accept anything, install anything, persist code, reload/replace the extension, or alter registration.
- Requires a fresh direct click from Tom before `LanguageModel.create()` and again before the inert `prompt()` if preparation was required.

- [ ] **Step 1: Author and review the exact inert probe before opening Chrome**

The document must contain the complete self-contained DevTools Console script and its SHA-256. The final capability receipt combines two explicitly separate sources: the existing collector supplies Chrome executable/version/signing observation and repository inspection supplies the current manifest permission arrays; the injected script records only its side-panel URL/origin, `LanguageModel.availability()` result, preparation state/progress, `contextWindow`, structured-output success/failure, abort/destroy outcome, and fixed timestamps/hashes. Its prompt classifies a literal inert record into the V2 schema and includes no repository, candidate, conversation, page, cookie, credential, native-port payload, or model-service data. Source review must prove the script contains no `chrome.runtime`, `connectNative`, `sendMessage`, `fetch`, XHR, WebSocket, storage, navigation mutation, or DOM-reading operation beyond creating/removing its own fixed probe subtree.

- [ ] **Step 2: Stop and show Tom the exact probe, expected resource consequence, and receipt fields**

Do not create or prepare a model session until Tom approves this specific human-present check.

- [ ] **Step 3: With Tom present, inspect the existing side-panel DevTools context without reloading or replacing the extension**

First confirm from the fixed side-panel status that no review or conversation turn is active. Select that exact side-panel target in Chrome DevTools, verify its extension URL and current manifest permissions, and have Tom paste the already reviewed script into its Console. Confirm `globalThis.LanguageModel` and run only `availability()` using the exact modalities; the injected script must not call `create()` until a subsequent button click. If the API is unavailable in that context, remove the probe subtree, record the fixed failure code, and stop.

- [ ] **Step 4: Let Tom click the ephemeral preparation/run controls**

If preparation is needed, show it separately and destroy the preparation session when ready. The inert run must use one fresh session, `responseConstraint`, `AbortSignal`, and unconditional `destroy()`. Exercise cancellation on a second inert invocation only if the first check establishes the API safely.

- [ ] **Step 5: Have Tom close/reopen the panel and exit/relaunch Chrome Dev, then inspect the retained capability receipt**

Do not automate either lifecycle action. Before each close/exit, record only the probe's fixed terminal state and bound runtime generation; after each reopen/relaunch, verify the former invocation is terminal and cannot resume. Verify no session or candidate packet persisted, no analysis auto-ran, no adapter-originated cloud/localhost request occurred, and model identity remains labeled `not-attested`. Record browser-managed acquisition separately from inference behavior and label inference locality only as `documented-on-device; no adapter network observed`, not as cryptographic or process-level proof.

- [ ] **Step 6: Run final read-only verification and commit only tracked documentation**

Run:

```sh
npm run check
npm run check:chrome-review
npm run verify:receipts
git diff --check
git status --short --branch
git remote -v
```

Commit: `docs: record Chrome model capability check`

Stop here. Do not load the prepared stable extension, change the native-host manifest, migrate V1, run a real candidate review, or begin the old Task 12. The next artifact is a separately reviewed exact migration plan and explicit human authorization for that mutation.

## Final plan gate

- [ ] The four reproduced loader forms fail while the documentation makes only a bounded lexical claim.
- [ ] V1 policy and receipts retain their original bytes, graph, hashes, and meaning.
- [ ] V2 policy requires `deterministic-review -> codex-review -> chrome-semantic-review -> eligible`.
- [ ] Codex and Chrome consume the same complete immutable evidence independently.
- [ ] The Chrome adapter starts only from a fresh visible user action and always destroys its one-shot session.
- [ ] The result/cancel lane can settle only one issued invocation and cannot start work or grant authority.
- [ ] No human nonce exists before both semantic receipts and deterministic evidence are finalized.
- [ ] Chrome provenance says `modelIdentityAssurance: not-attested` and never borrows Codex PID evidence.
- [ ] The exact failure UI remains fixed and model/candidate prose reaches no executable or navigable sink.
- [ ] Permissions and host permissions remain unchanged; no browser/page authority, application transport listener, cloud endpoint, `gpt-oss`, Eloquent, Gemma, or alternate-model fallback exists.
- [ ] The sealed V2 plan is dry-run only and makes no live installation or registration change.
- [ ] The human-present check uses inert evidence, produces a sanitized local capability receipt, and stops before migration.
