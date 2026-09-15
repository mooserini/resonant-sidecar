# Visible Review and Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visible, fail-closed local update lifecycle that stages one clean committed Resonant Sidecar bundle, verifies it without executing candidate authority, binds activation to one explicit human decision, verifies the resulting macOS process tree, and rolls back on failure while retaining permanent receipts.

**Architecture:** Replace the working-tree native-host launcher with a small trusted bootstrap registered directly with Chrome Dev. The bootstrap proxies the existing conversation protocol to the pinned active bundle over stdio and separately owns candidate staging, deterministic verification, isolated Codex analysis, receipt finalization, nonce-bound human decisions, atomic activation, restart recovery, and rollback. Replaceable bundles live in a project-local version store; canonical evidence lives in a project-local append-only hash chain. No component opens a sidecar network listener, and no candidate code decides its own eligibility.

**Tech Stack:** Chrome Manifest V3 side panel; semantic HTML/CSS/JavaScript; dependency-free Node.js 22+ ESM and `node:test`; Git plumbing; Codex CLI 0.153.2 noninteractive execution; macOS `/usr/bin/osascript`, `/usr/bin/sample`, `/usr/bin/codesign`, `ps`, `lsof`, and `sysctl`; SHA-256 canonical JSON receipts.

**Spec:** `docs/superpowers/specs/2026-09-14-visible-review-refresh-design.md`

## Global Constraints

- Do not push, add a Git remote, publish, merge `mooserini/WebMCP-Safecar`, or use any remote source.
- Keep the currently working V1 attached until the migration task reaches its explicit human checkpoint.
- The only candidate source is the current local Git `HEAD`, and all bundle inputs must be committed and clean.
- Keep Chrome Native Messaging and child-process stdio as the only sidecar transports. The bootstrap, active host, and sidecar Codex process must own no TCP listener.
- Do not add Chrome host permissions or page, tab, cookie, history, clipboard, credential, CDP, browser-automation, shell-command, or approval-grant authority.
- Availability detection never executes candidate code. Deterministic review may execute allowlisted JavaScript only as a test subject inside the trusted fixed harness; it never invokes candidate entry points, lifecycle scripts, executables, dependency installers, or candidate-selected commands.
- Treat candidate source, docs, comments, tests, fixtures, and filenames as untrusted data. They never supply prompts, dialogs, buttons, report paths, policy, verifier arguments, or activation behavior.
- A deterministic failure cannot be overridden. A malformed or unfavorable Codex attestation also fails closed.
- The macOS helper presents fixed trusted strings and relays only a nonce-bound choice. It never determines eligibility or activation.
- Generated runtime state and receipts remain local and outside source commits. Track only their schemas, policies, code, tests, and explanatory README files.
- Never record raw environments, cookies, history, page or conversation text, tokens, clipboard contents, hardware serials, or secret-bearing command arguments.
- Finalized failure and activation-failure receipts are never modified or removed by application code, Quick Clean, emergency stop, or routine maintenance.
- Every implementation task is committed separately after its focused tests pass. Do not stage pre-existing `review-receipts/` evidence in source-code commits.

---

### Task 1: Canonical policy and complete-bundle identity

**Files:**
- Create: `policy/review-policy.v1.json`
- Create: `policy/codex-attestation.v1.schema.json`
- Create: `review/canonical-json.js`
- Create: `review/bundle-manifest.js`
- Create: `test/canonical-json.test.js`
- Create: `test/bundle-manifest.test.js`
- Create: `test/fixtures/bundles/minimal-pass/extension/manifest.json`
- Create: `test/fixtures/bundles/minimal-pass/native-host/host.js`
- Create: `test/fixtures/bundles/minimal-pass/package.json`

**Interfaces:**
- Consumes: trusted policy JSON, a read-only staged bundle root, and an explicit allowlisted bundle inventory.
- Produces: `canonicalJson(value): string`, `sha256Bytes(value): string`, `sha256Json(value): string`, `buildBundleManifest({ root, files, sourceCommit, schemaVersion }): Promise<BundleManifest>`, and `assertBundleManifest(value): BundleManifest`.
- `BundleManifest` is `{ schemaVersion, sourceCommit, files: [{ path, bytes, sha256, mode }], bundleDigest, capabilities, dependencies }` with normalized POSIX relative paths sorted bytewise.

- [ ] **Step 1: Write failing canonicalization and bundle-identity tests**

```js
test('bundle digest is independent of traversal order and rejects symlinks', async () => {
  const first = await buildBundleManifest({ root, files: ['package.json', 'native-host/host.js'], sourceCommit: COMMIT, schemaVersion: 1 });
  const second = await buildBundleManifest({ root, files: ['native-host/host.js', 'package.json'], sourceCommit: COMMIT, schemaVersion: 1 });
  assert.equal(first.bundleDigest, second.bundleDigest);
  await symlink('/tmp/outside', path.join(root, 'extension', 'escape'));
  await assert.rejects(() => buildBundleManifest({ root, files: [...first.files.map(f => f.path), 'extension/escape'], sourceCommit: COMMIT, schemaVersion: 1 }), /symbolic link/i);
});
```

- [ ] **Step 2: Run `node --test test/canonical-json.test.js test/bundle-manifest.test.js` and confirm missing-module failures**
- [ ] **Step 3: Implement RFC-8785-style object-key ordering for the supported JSON subset, SHA-256 helpers, strict path normalization, regular-file-only inventory, byte counts, modes, per-file hashes, and the bundle digest**

```js
export async function buildBundleManifest({ root, files, sourceCommit, schemaVersion }) {
  const entries = [];
  const orderedPaths = [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  for (const relativePath of orderedPaths) {
    const safePath = assertSafeRelativePath(relativePath);
    const info = await lstat(path.join(root, safePath));
    if (!info.isFile()) throw new TypeError(`Bundle input is not a regular file: ${safePath}`);
    const bytes = await readFile(path.join(root, safePath));
    entries.push({ path: safePath, bytes: bytes.length, sha256: sha256Bytes(bytes), mode: info.mode & 0o777 });
  }
  const unsigned = { schemaVersion, sourceCommit, files: entries, capabilities: readDeclaredCapabilities(root), dependencies: readDependencyIdentity(root) };
  return { ...unsigned, bundleDigest: sha256Json(unsigned) };
}
```

- [ ] **Step 4: Add policy data that pins schema version 1, the existing three Chrome permissions, zero host permissions/listeners/lifecycle scripts, approved bundle paths, trusted test commands, receipt fields, state transitions, and the Codex attestation shape; rerun the focused tests**
- [ ] **Step 5: Run `npm run check` and commit `feat: define canonical review policy and bundle identity`**

### Task 2: Sanitized append-only custody ledger

**Files:**
- Create: `review/redaction.js`
- Create: `review/receipt-store.js`
- Create: `review-receipts/README.md`
- Create: `test/redaction.test.js`
- Create: `test/receipt-store.test.js`

**Interfaces:**
- Consumes: structured allowlisted evidence, the exact policy snapshot, and an explicit project-local `review-receipts` root.
- Produces: `sanitizeEvidence(value, policy): object`, `ReceiptStore.verifyChain(): Promise<ChainStatus>`, `ReceiptStore.finalizeEvent(input): Promise<CanonicalReceipt>`, `ReceiptStore.resolveLatestFailure(): Promise<string | null>`.
- A canonical receipt is immutable and contains `receiptId`, `reviewId`, `eventType`, `outcome`, `previousReceiptHash`, evidence hashes, policy hash, verifier identities, active/candidate digests, optional `humanDecisionRef`, and `createdAt`.

- [ ] **Step 1: Write failing tests for secret rejection, deterministic hashing, atomic finalization, chain traversal, missing-history detection, and immutable failure receipts**

```js
test('a removed historical receipt breaks custody and blocks append', async () => {
  const store = new ReceiptStore({ root, clock, randomUUID });
  const first = await store.finalizeEvent(event('available'));
  await store.finalizeEvent(event('review-failed'));
  await chmod(first.directory, 0o700);
  await rm(first.directory, { recursive: true });
  assert.equal((await store.verifyChain()).state, 'custody-broken');
  await assert.rejects(() => store.finalizeEvent(event('available')), /custody/i);
});
```

- [ ] **Step 2: Run `node --test test/redaction.test.js test/receipt-store.test.js` and confirm missing-module failures**
- [ ] **Step 3: Implement a structured allowlist and explicit rejection patterns for environment dumps, authorization/cookie headers, bearer tokens, connection strings, API-key shapes, transcript/page-text keys, unrelated home paths, and secret-bearing argv**
- [ ] **Step 4: Implement staging under `review-receipts/.pending/<uuid>`, schema/redaction validation, canonical hashes, `receipt.sha256`, atomic rename to `<timestamp>_<review-id>/`, read-only modes, best-effort `/usr/bin/chflags uchg`, hash-chain verification, and nonauthoritative `latest-failure.json` rebuilding. Each canonical directory contains `report.md`, `receipt.json`, `attestation.json`, `policy-snapshot.json`, project evidence, and `os/before|verification|after` evidence**

```js
async finalizeEvent(input) {
  const chain = await this.verifyChain();
  if (chain.state !== 'intact') throw new CustodyError(chain.reason);
  const sanitized = sanitizeEvidence(input, this.policy);
  const receipt = canonicalReceipt(sanitized, chain.tailHash);
  await writePendingDirectory(receipt);
  await verifyPendingDirectory(receipt);
  await rename(receipt.pendingPath, receipt.finalPath);
  await makeReadOnlyAndImmutable(receipt.finalPath);
  return receipt;
}
```

- [ ] **Step 5: Document that generated receipts are local evidence rather than source artifacts, preserve the existing comparison directories untouched, run the focused tests plus `npm run check`, and commit `feat: add tamper-evident local review receipts`**

### Task 3: Read-only local Git candidate discovery and quarantine

**Files:**
- Create: `review/git-runner.js`
- Create: `review/candidate-source.js`
- Create: `test/candidate-source.test.js`
- Create: `test/fixtures/fake-git.js`

**Interfaces:**
- Consumes: repository root, active bundle digest, trusted bundle-input allowlist, and injected Git runner.
- Produces: `inspectLocalCandidate({ repoRoot, activeDigest, policy }): Promise<AvailabilityResult>` and `stageLocalCandidate({ repoRoot, reviewId, quarantineRoot, policy }): Promise<StagedCandidate>`.
- `AvailabilityResult` never executes or copies candidate code; it reports only `unavailable | available | blocked`, commit, digest, and a trusted reason code.

- [ ] **Step 1: Write failing tests for clean committed `HEAD`, bundle-input dirtiness, unchanged bundle digest, untracked bundle inputs, no remote use, and archive extraction containment**

```js
test('uncommitted bundle input cannot become an available candidate', async () => {
  git.status = ' M native-host/host.js\n';
  const result = await inspectLocalCandidate({ repoRoot, activeDigest: 'old', policy, git });
  assert.deepEqual(result, { state: 'blocked', reason: 'bundle-inputs-dirty' });
  assert.equal(git.calls.some(call => call.args.includes('fetch')), false);
});
```

- [ ] **Step 2: Run `node --test test/candidate-source.test.js` and confirm missing-module failures**
- [ ] **Step 3: Implement argument-array-only Git calls for `rev-parse HEAD`, `status --porcelain=v1 --untracked-files=all -- <allowlist>`, and `show <commit>:<path>`; reject submodules, symlinks, path traversal, special files, and a candidate digest equal to the active digest**
- [ ] **Step 4: Stage allowlisted bytes into `runtime/quarantine/<review-id>/bundle` with owner-only permissions, write a trusted staging manifest outside the candidate directory, reread every file to confirm the manifest digest, and never invoke candidate package scripts**
- [ ] **Step 5: Run the focused tests and `npm run check`; commit `feat: stage clean local candidates in quarantine`**

### Task 4: Deterministic eligibility verifier

**Files:**
- Create: `review/capability-diff.js`
- Create: `review/deterministic-verifier.js`
- Create: `test/capability-diff.test.js`
- Create: `test/deterministic-verifier.test.js`
- Create: `test/fixtures/bundles/reject-permission/extension/manifest.json`
- Create: `test/fixtures/bundles/reject-listener/native-host/host.js`
- Create: `test/fixtures/bundles/reject-lifecycle/package.json`

**Interfaces:**
- Consumes: staged bytes, active manifest, policy snapshot, trusted source-tree test harness, and injected command runner.
- Produces: `compareCapabilities({ active, candidate, policy }): CapabilityDelta` and `runDeterministicReview({ staged, active, policy, trustedHarness }): Promise<DeterministicResult>`.
- `DeterministicResult` is structured, sanitized, and includes named checks with exact command identity, exit status, and output digest—not unrestricted stdout/stderr.

- [ ] **Step 1: Write failing table-driven tests for added Chrome permissions, host permissions, listeners, lifecycle scripts, executable bits, command/approval behavior, weakened sandbox, changed receipt/dialog control, dependency drift, syntax failure, and trusted-test failure**
- [ ] **Step 2: Run `node --test test/capability-diff.test.js test/deterministic-verifier.test.js` and confirm missing-module failures**
- [ ] **Step 3: Implement manifest/dependency comparison and conservative static detectors; any new effective capability yields a hard-fail code requiring a separate permission migration**

```js
const HARD_FAILURES = new Set([
  'chrome-permission-added', 'host-permission-added', 'listener-added',
  'lifecycle-script-added', 'executable-added', 'approval-authority-added',
  'sandbox-weakened', 'trusted-control-modified', 'dependency-integrity-missing',
]);
```

- [ ] **Step 4: Run only trusted commands defined by the pinned policy, with fixed argv, scrubbed environment, read-only candidate tree, bounded output/time, and no shell; include syntax, unit, protocol, continuity, interruption, negative-policy, schema, and sanitization checks**
- [ ] **Step 5: Prove candidate-provided tests cannot replace the trusted harness, run focused tests plus `npm run check`, and commit `feat: enforce deterministic candidate eligibility`**

### Task 5: One-shot isolated Codex attestation

**Files:**
- Create: `review/codex-verifier.js`
- Create: `review/codex-prompt.js`
- Create: `test/codex-verifier.test.js`
- Create: `test/fixtures/fake-codex-exec.js`

**Interfaces:**
- Consumes: active/candidate manifests, bounded diff, policy snapshot, sanitized deterministic result, trusted attestation schema, and injected process runner.
- Produces: `runCodexReview(input): Promise<CodexAttestationResult>` and `buildCodexReviewPrompt(input): string`.
- Invokes the installed CLI by absolute path with global options before the subcommand: `-a never -s read-only exec --ephemeral --ignore-user-config --ignore-rules --strict-config -C <sealed-input-dir> --output-schema <trusted-schema> --output-last-message <private-temp-output> -`, with no `--search` or additional directories.

- [ ] **Step 1: Write failing tests that inspect exact argv/environment and reject prose, malformed JSON, unknown keys, oversized output, nonzero exit, tool/approval events, and an unfavorable attestation**

```js
assert.deepEqual(invocation.args.slice(0, 9), [
  '-a', 'never', '-s', 'read-only', 'exec',
  '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
]);
assert.equal(invocation.args.includes('--search'), false);
assert.equal(invocation.env.CODEX_HOME, trustedCodexHome);
```

- [ ] **Step 2: Run `node --test test/codex-verifier.test.js` and confirm missing-module failures**
- [ ] **Step 3: Implement a trusted prompt that labels every candidate-derived section as untrusted evidence, requests only the schema, and asks for behavioral differences, dependency changes, unexplained files, and policy concerns without offering activation authority**
- [ ] **Step 4: Materialize only bounded inputs in a temporary owner-only directory, use a minimal allowlisted environment, parse JSONL events for forbidden tool/approval activity, validate the final response against the trusted schema, hash it, then erase the temporary output after receipt finalization**
- [ ] **Step 5: Run focused tests and one controlled verifier smoke against the unchanged known-good fixture; capture only sanitized command/version/result hashes in a local receipt; run `npm run check` and commit `feat: add isolated Codex candidate attestation`**

### Task 6: macOS ownership and listener evidence collector

**Files:**
- Create: `review/macos-evidence.js`
- Create: `review/process-ownership.js`
- Create: `test/macos-evidence.test.js`
- Create: `test/process-ownership.test.js`
- Create: `test/fixtures/macos/ps.txt`
- Create: `test/fixtures/macos/lsof.txt`
- Create: `test/fixtures/macos/codesign.txt`

**Interfaces:**
- Consumes: allowlisted relevant PIDs, expected Chrome signing identity, expected parent-child roles, a phase (`before | verification | after`), and an injected fixed-command runner.
- Produces: `collectMacOSEvidence(input): Promise<MacOSEvidence>` and `verifyOwnershipTopology(evidence, policy): OwnershipVerdict`.

- [ ] **Step 1: Write failing fixture-driven tests for valid Chrome -> bootstrap -> active host -> Codex ancestry, isolated verification topology, absent processes after Chrome exit, unexpected listener ownership, wrong Chrome Team ID, unrelated-process exclusion, and forbidden-field rejection**
- [ ] **Step 2: Run `node --test test/macos-evidence.test.js test/process-ownership.test.js` and confirm missing-module failures**
- [ ] **Step 3: Implement absolute-path invocations with argument arrays for `ps`, `lsof`, `codesign`, `sample`, `sw_vers`, and `sysctl`; capture PID/PPID/PGID/start/elapsed/path/hash/cwd/signing/fd/listener/boot-session facts only**
- [ ] **Step 4: Sanitize `sample` and argv before persistence, distinguish Chrome-owned loopback CDP from sidecar transport, and hard-fail if bootstrap, active host, or sidecar Codex owns a TCP listener**
- [ ] **Step 5: Run the fixture tests, a read-only live sample with Chrome Dev closed, and `npm run check`; record the live sample under existing local runtime comparisons and commit `feat: verify macOS sidecar process custody`**

### Task 7: Trusted bootstrap and versioned runtime store

**Files:**
- Create: `bootstrap/host.js`
- Create: `bootstrap/native-proxy.js`
- Create: `bootstrap/version-store.js`
- Create: `bootstrap/recovery-state.js`
- Create: `test/bootstrap-host.test.js`
- Create: `test/version-store.test.js`
- Create: `test/recovery-state.test.js`
- Create: `runtime/README.md`

**Interfaces:**
- Consumes: Chrome Native Messaging frames, active/previous pins, accepted bundle digest, and persisted activation recovery state.
- Produces: `VersionStore.installVersion(staged)`, `VersionStore.activate(decision)`, `VersionStore.rollback(failure)`, `VersionStore.resolveActiveHost()`, `recoverInterruptedActivation(state)`, and a bootstrap native host that proxies conversation frames over stdio.
- Project-local generated layout: `runtime/active/`, `runtime/previous/`, `runtime/versions/<digest>/`, `runtime/quarantine/<review-id>/`, and `runtime/recovery-state.json`.

- [ ] **Step 1: Write failing tests for active resolution, exact-digest installation, path containment, atomic active/previous swaps, crash recovery at every activation boundary, rollback, and refusal to activate without a consumed matching decision nonce**
- [ ] **Step 2: Run `node --test test/bootstrap-host.test.js test/version-store.test.js test/recovery-state.test.js` and confirm missing-module failures**
- [ ] **Step 3: Implement the version store using owner-only directories, fsync-before-rename, canonical pins, same-filesystem atomic renames, and digest re-verification before every resolve/activate/rollback action**
- [ ] **Step 4: Implement the stable bootstrap as the Chrome-registered host: reserve stdout for Chrome frames, handle trusted lifecycle messages itself, spawn the pinned active `native-host/host.js` as a framed stdio child, proxy only existing conversation messages/events, and terminate all children on Chrome disconnect or SIGTERM**

```js
const route = parseBootstrapMessage(message);
if (route.channel === 'lifecycle') await coordinator.handle(route.message);
else proxy.send(route.message);
```

- [ ] **Step 5: Prove the bootstrap and child own no listener and Chrome disconnect reaps both the active host and Codex descendant; run `npm run check` and commit `feat: add trusted bootstrap and versioned runtime`**

### Task 8: Review state machine, nonce decisions, activation, and rollback

**Files:**
- Create: `review/review-coordinator.js`
- Create: `review/review-state.js`
- Create: `review/decision-nonce.js`
- Create: `test/review-state.test.js`
- Create: `test/review-coordinator.test.js`
- Create: `test/decision-nonce.test.js`

**Interfaces:**
- Consumes: candidate source, verifiers, receipt store, version store, macOS collector, trusted clock/randomness, and explicit lifecycle messages.
- Produces: `ReviewCoordinator.checkAvailability()`, `.startReview()`, `.acceptReview(decision)`, `.rejectReview(decision)`, `.resumePendingActivation()`, plus strict transition and single-use nonce enforcement.

- [ ] **Step 1: Write failing state-table tests for every permitted transition and every forbidden shortcut, including restart expiry, candidate/policy change, nonce replay, deterministic failure, malformed Codex output, custody break, post-activation failure, and rollback failure**

```js
test('acceptance is bound to one review, digest, policy, action, and nonce', async () => {
  const eligible = await coordinator.startReview();
  await assert.rejects(() => coordinator.acceptReview({ ...eligible.decision, candidateDigest: 'changed' }), /binding/i);
  await coordinator.acceptReview(eligible.decision);
  await assert.rejects(() => coordinator.acceptReview(eligible.decision), /consumed/i);
});
```

- [ ] **Step 2: Run `node --test test/review-state.test.js test/review-coordinator.test.js test/decision-nonce.test.js` and confirm missing-module failures**
- [ ] **Step 3: Implement the full append-only transition sequence: `available -> staged -> deterministic-review -> codex-review -> eligible -> human-accepted -> activating -> activated`, plus `review-failed`, `rejected`, `activation-failed -> rolling-back -> rolled-back`, and `custody-broken`**
- [ ] **Step 4: Require a cryptographically random single-use nonce bound to review ID, candidate digest, policy digest, action, and expiry; persist only its digest; finalize one receipt per transition; keep active service available during review; block refresh but not the active pin after custody failure**
- [ ] **Step 5: Implement restart recovery: machine/browser restart preserves pins and receipts, invalidates stale unconsumed human decisions, and resumes only a fully bound activation transaction. After extension reload, the new bootstrap reads `recovery-state.json`, verifies the live `after` process tree and zero-listener rule before appending `activated`; on failure it restores `previous`, verifies the restored tree, and writes permanent failure/rollback receipts. Run all focused tests and `npm run check`; commit `feat: orchestrate receipt-bound review and rollback`**

### Task 9: Fixed macOS presentation and safe desktop handoff

**Files:**
- Create: `presentation/macos-dialog.js`
- Create: `presentation/desktop-handoff.js`
- Create: `test/macos-dialog.test.js`
- Create: `test/desktop-handoff.test.js`

**Interfaces:**
- Consumes: trusted presentation enum, trusted report path already contained in a finalized receipt, and nonce binding.
- Produces: `showReviewDialog(model): Promise<DialogChoice>`, `openReviewReport(path)`, and `openChromeDeveloperProject()`.
- Desktop target is fixed to project name `Chrome Developer`, project ID `78e19937-a254-4343-847d-171e0f1673d0`, and path `$HOME/chrome`.

- [ ] **Step 1: Write failing tests proving candidate strings cannot reach AppleScript, failure text is exact, report paths must resolve beneath `review-receipts`, and desktop handoff invokes only `codex app $HOME/chrome`**
- [ ] **Step 2: Run `node --test test/macos-dialog.test.js test/desktop-handoff.test.js` and confirm missing-module failures**
- [ ] **Step 3: Implement fixed `/usr/bin/osascript` scripts selected by trusted enum; parse only known button results and return the original nonce without allowing dialog text, buttons, paths, or verdicts from candidate data**

```js
const FAILURE_MODEL = Object.freeze({
  title: 'Review failed',
  buttons: ['Open review report', 'Continue in Codex', 'Dismiss'],
});
```

- [ ] **Step 4: Implement report opening with `/usr/bin/open <validated-report.md>` and desktop handoff with the absolute Codex path plus `app $HOME/chrome`; assert it never creates/selects a task, selects a model, sends text, or searches by task title**
- [ ] **Step 5: Run focused tests, manually inspect one non-mutating sample dialog, dismiss it, run `npm run check`, and commit `feat: add fixed macOS review presentation`**

### Task 10: Lifecycle protocol and side-panel controls

**Files:**
- Modify: `native-host/sidecar-protocol.js`
- Modify: `native-host/host.js`
- Modify: `extension/sidepanel-controller.js`
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.css`
- Modify: `extension/sidepanel.js`
- Modify: `test/sidecar-protocol.test.js`
- Modify: `test/native-host.test.js`
- Modify: `test/extension-contract.test.js`

**Interfaces:**
- Consumes: trusted bootstrap lifecycle events and user button actions.
- Produces browser messages `update.status`, `review.start`, `review.accept`, `review.reject`, `review.openReport`, `review.openDesktop`, and host events `update.available`, `review.started`, `review.eligible`, `review.failed`, `activation.started`, `activation.completed`, `activation.rolledBack`.
- Existing `session.open`, `turn.start`, and `turn.interrupt` remain byte-for-byte compatible.

- [ ] **Step 1: Extend protocol tests first, requiring exact keys, bounded identifiers, strict digest/nonce formats, and no candidate-controlled diagnostic text in any browser-visible failure event**
- [ ] **Step 2: Extend DOM/controller tests first for a visible non-blocking update notice, explicit `Review and Refresh`, absent/disabled Accept before eligibility, digest-bound acceptance, exact failure actions, keyboard navigation, visible focus, and the existing emergency Stop behavior**
- [ ] **Step 3: Run `node --test test/sidecar-protocol.test.js test/native-host.test.js test/extension-contract.test.js` and confirm the new assertions fail**
- [ ] **Step 4: Implement lifecycle routing through the trusted bootstrap and a compact accessible review card. On failure render only `Review failed`, `Open review report`, `Continue in Codex`, and `Dismiss`; keep detailed reasons solely in the report bundle**
- [ ] **Step 5: Run targeted tests, `npm run check`, and a keyboard-only Chrome Dev inspection without activating a candidate; commit `feat: add visible review and refresh controls`**

### Task 11: Stable installation and one-time V1 migration

**Files:**
- Modify: `scripts/install-macos.js`
- Create: `scripts/build-initial-bundle.js`
- Create: `scripts/verify-install-plan.js`
- Modify: `test/install-macos.test.js`
- Create: `test/build-initial-bundle.test.js`
- Modify: `README.md`
- Create: `docs/migration-runbook.md`

**Interfaces:**
- Consumes: exact unpacked extension ID, clean committed source, current installed manifest/launcher, and explicit `--migrate` confirmation.
- Produces: a dry-run migration plan, first complete pinned bundle, stable bootstrap launcher, stable unpacked-extension path, recovery copy of V1, and pre/migration/post receipts.

- [ ] **Step 1: Write failing tests proving dry-run is default, the registered executable becomes the trusted bootstrap rather than working-tree `native-host/host.js`, paths target Chrome Dev only, exact origin remains unchanged, and no install mutation occurs without `--migrate --extension-id <id> --expected-current-hash <sha256>`**
- [ ] **Step 2: Run `node --test test/install-macos.test.js test/build-initial-bundle.test.js` and confirm the new assertions fail**
- [ ] **Step 3: Implement initial-bundle construction from clean committed allowlisted files, behavior comparison with V1, exact proposed file/hash/path/mode report, preservation of the old launcher, and generation of `before` evidence without changing registration**
- [ ] **Step 4: Implement the explicit migration transaction: verify expected current hashes; install bootstrap and initial bundle atomically; change the native-host manifest and stable unpacked extension only when necessary; leave the old launcher recoverable; do not remove it until a later separately approved cleanup**
- [ ] **Step 5: Expand the runbook with the human Chrome Dev steps, recovery command, expected process tree, receipt locations, and the hard stop boundary. Run `npm run check` and commit `feat: prepare visible migration to pinned runtime`**

### Task 12: End-to-end acceptance, restart durability, and permanent receipts

**Files:**
- Create: `test/review-refresh.integration.test.js`
- Create: `test/fixtures/fake-active-host.js`
- Create: `test/fixtures/fake-review-candidate.js`
- Create: `scripts/verify-receipt-chain.js`
- Create: `docs/review-refresh-test-receipt.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: the completed bootstrap, fake deterministic/Codex/macOS adapters for automated tests, then the real local Chrome Dev/Codex setup only at the human checkpoint.
- Produces: repeatable automated acceptance/rollback tests, a read-only receipt-chain verifier, and a sanitized local proof of the one-time migration and one candidate review.

- [ ] **Step 1: Write failing integration tests for passing candidate quarantine, explicit acceptance, browser/bootstrap restart between acceptance and activation, successful post-check, deterministic failure, malformed Codex attestation, post-activation rollback, chain break, Chrome exit cleanup, and zero listeners**
- [ ] **Step 2: Add `check:review` and `verify:receipts` scripts, run the automated integration test, and confirm it fails until all lifecycle wiring is present**
- [ ] **Step 3: Complete only the minimal wiring required by the tests; run `npm run check`, `npm run check:review`, and `npm run verify:receipts` until all pass**
- [ ] **Step 4: Stop at the human checkpoint and show the exact dry-run migration plan. After Tom explicitly approves that exact plan, perform the visible one-time migration, reload Chrome Dev, send several zero-tool conversational turns, exit and relaunch Chrome Dev, and verify correct thread/process attachment without any sidecar-owned listener**
- [ ] **Step 5: Create one harmless committed local candidate, run Review and Refresh, verify Accept is unavailable before both reviews pass, accept the exact digest, and confirm post-activation topology. Exercise the destructive-looking failure and rollback paths only through the isolated integration fixture, not by leaving a deliberately broken commit in the live checkout**
- [ ] **Step 6: Finalize project/OS/policy/Codex/human-decision receipts, run the receipt-chain verifier, inspect `git status` so only expected local generated evidence remains outside source control, update `docs/review-refresh-test-receipt.md` with hashes and commands but no secrets, and commit `test: prove visible review refresh and rollback`**

## Final verification gate

- [ ] `npm run check` passes from a clean source checkout.
- [ ] `npm run check:review` passes without Chrome, Codex network access, or candidate execution.
- [ ] `npm run verify:receipts` reports an intact chain and names the canonical tail hash.
- [ ] A clean committed local candidate is visible but remains quarantined until explicit acceptance.
- [ ] Deterministic failure, malformed/unfavorable Codex output, expired/replayed nonce, capability change, and custody break all fail closed.
- [ ] Activation is not final until live `after` ownership and zero-listener checks pass.
- [ ] Controlled post-activation failure returns to the exact previous digest and retains both failure and rollback evidence.
- [ ] Chrome Dev exit terminates bootstrap, active host, and sidecar Codex descendants.
- [ ] The failure UI contains no diagnostic prose; report and desktop handoff actions resolve only trusted destinations.
- [ ] `codex app $HOME/chrome` opens the `Chrome Developer` project and starts no task or turn.
- [ ] Existing comparison evidence remains present and unmodified.
- [ ] `git remote -v` remains empty and no push occurs.
