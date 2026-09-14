# Resonant Sidecar Visible Review and Refresh Design

Date: 2026-09-14

Status: Approved for local implementation on 2026-09-14; no publication or push authorized

## Purpose

Add a visible, fail-closed update lifecycle to Resonant Sidecar without giving the extension, native host, verifier, macOS helper, or candidate bundle authority to approve its own replacement.

The system must make newer JavaScript and dependency versions available for review without silently overwriting the running version. It must preserve durable project- and OS-level evidence explaining what was reviewed, what was accepted, what actually ran, and why a review or activation failed.

## Existing verified baseline

The current local implementation is commit `2e685ed61aa0115cc23c49a372ff34739584c044` on branch `prototype/zero-tool-sidecar`.

It currently provides:

- A Chrome MV3 side panel.
- Chrome Native Messaging to a user-scoped Node host.
- `codex app-server` over child-process stdio.
- Exact text forwarding and durable Codex thread resumption.
- A turn interrupt control.
- No application TCP, HTTP, WebSocket, SSH, or SSE listener.
- No page, tab, cookie, history, clipboard, or credential access.
- No runtime package dependencies.
- Twenty-five passing checks covering framing, protocol validation, native-host registration, session continuity, interruption, and refusal of unsolicited approvals.

The current launcher executes `native-host/host.js` directly from the working checkout. That is acceptable for the initial prototype but is the condition this design replaces: edits to the checkout must become candidates, not silently become the next runtime.

The local checkout has no configured Git remote. The private GitHub repository `mooserini/WebMCP-Safecar` is an unrelated React/Express prototype with no shared Git merge base. It is not an update source and must not be mechanically merged into this implementation.

## Goals

1. Detect a newer complete local bundle without changing the active bundle.
2. Let the human explicitly start review through **Review and Refresh**.
3. Verify a staged candidate against an immutable policy snapshot and pinned dependency set.
4. Use deterministic checks for eligibility and a separate Codex CLI process for structured analysis.
5. Keep the final accept or reject decision with the human.
6. Bind one acceptance to one review ID, candidate digest, and single-use response nonce.
7. Activate atomically, verify the resulting live process tree, and roll back on failure.
8. Preserve permanent, sanitized, hash-chained receipts inside the project.
9. Open the ChatGPT/Work/Codex desktop application for collaborative debugging without creating or starting an agent turn.

## Non-goals

- Publishing to an extension store or GitHub.
- Silent background updates or unattended acceptance.
- Remote update discovery in the first implementation.
- CDP attachment, WebMCP tools, page inspection, browser automation, or capability approvals.
- Merging the unrelated GitHub SafeCar prototype.
- Proving human presence cryptographically.
- Making local evidence indestructible against the machine owner, disk failure, or deletion of the whole project.
- Implementing a permission-expansion migration flow. A capability expansion fails ordinary review and requires a separately designed ceremony.

## Authority model

No process is the authority.

```text
Candidate bundle -> supplies bytes only
Deterministic verifier -> determines policy eligibility
Codex CLI verifier -> produces bounded structured analysis
macOS helper -> displays state and relays a selected action
Human -> accepts or rejects one identified candidate
Bootstrap -> enforces the bound decision without discretion
```

The macOS helper is a presentation service. It cannot alter the verdict, candidate digest, permission set, report destination, or allowed buttons. The Codex verifier cannot accept, activate, or modify the candidate. The bootstrap can enforce valid state transitions but cannot manufacture human consent.

A standard macOS dialog is a consent signal, not cryptographic proof that a particular human clicked it. Stronger human-presence mechanisms may be evaluated later without changing the receipt or candidate model.

## Components

### Trusted bootstrap

A deliberately small, locally installed bootstrap owns:

- Active-version resolution.
- Candidate staging.
- Invocation of deterministic checks.
- Invocation of the isolated Codex verifier.
- Receipt finalization.
- Validation of a human decision bound to the review.
- Atomic activation and rollback.

The bootstrap does not interpret conversation text and does not possess browser-page or agent-tool authority. Changes to the bootstrap itself require a separate visible review because it is the enforcement boundary.

### Versioned bundle store

The replaceable payload is a complete bundle, not an individual `host.js` file. It includes the extension assets, native-host JavaScript, protocol modules, installer metadata, dependency manifests, and policy compatibility declaration.

Logical layout:

```text
runtime/
  active/
  previous/
  versions/<bundle-digest>/
  quarantine/<review-id>/
```

Chrome continues to use a stable unpacked-extension path. Accepted contents are replaced only during explicit activation, with the previous version retained for rollback. The native launcher resolves the same approved bundle rather than executing arbitrary working-tree JavaScript.

### Candidate source

The first update source is the local Resonant Sidecar Git checkout. A candidate must:

- Be a committed Git state.
- Have a clean candidate worktree for all bundle inputs.
- Differ from the active pinned digest.
- Declare a supported review-schema version.
- Include exact dependency integrity data whenever runtime dependencies exist.

Uncommitted edits may be developed and tested normally, but they cannot be presented as an activatable update. GitHub and other remote sources are excluded until their provenance and signature policy receive a separate design.

### Deterministic verifier

The deterministic verifier runs from the trusted side, not from candidate code. It performs the enforceable checks:

- Candidate manifest and schema validation.
- Complete file inventory and SHA-256 digest.
- Source commit and clean-tree verification.
- Dependency lock and integrity verification.
- Detection of new lifecycle scripts, executables, listeners, permissions, or capabilities.
- Static syntax checks.
- Unit, protocol, integration, continuity, interruption, and negative-policy tests.
- Comparison against the active policy snapshot.
- Sanitization validation before receipt finalization.

Candidate-provided tests may supplement trusted tests but cannot replace or weaken them.

### Isolated Codex CLI verifier

After deterministic checks complete, a separate one-shot Codex CLI process reviews the candidate read-only. It is not the conversation agent and is not launched from the candidate bundle.

The verifier starts with a read-only sandbox, approval policy `never`, no browser attachment, no MCP servers, no live web search, and no writable candidate or receipt directory. Candidate source, comments, documentation, test names, and fixture text are untrusted review inputs rather than instructions to the verifier.

It receives only:

- The active and candidate manifests.
- The bounded source diff.
- The policy snapshot.
- Sanitized deterministic test results.
- The required structured-attestation schema.

It returns structured analysis identifying behavioral differences, dependency changes, unexplained files, and policy concerns. Prose outside the schema is rejected. A favorable Codex result cannot override a deterministic failure, and an unfavorable or malformed result makes the candidate ineligible.

### macOS presentation helper

The initial implementation may use `/usr/bin/osascript` for native dialogs and report-opening actions. A later signed AppKit or SwiftUI helper may improve process identity and presentation. Neither form becomes an authority.

The helper receives a fixed display model from the bootstrap and returns a selected action bound to a one-time nonce. Candidate code cannot supply dialog text, buttons, paths, or verdicts.

### ChatGPT/Work/Codex desktop handoff

The debugging destination is the pinned local desktop project **Chrome Developer**, identified by project ID:

```text
78e19937-a254-4343-847d-171e0f1673d0
```

The helper may invoke:

```sh
codex app /Users/thomaskenny/chrome
```

This opens the desktop application at the project. It does not choose a model, create a task, submit a prompt, or start an agent turn. Inside that project, the human chooses an existing task for accumulated context or begins a clean task.

Task histories are collaborative workspaces, not canonical evidence. The receipt ledger remains authoritative when conversation summaries, context windows, or interpretations change.

## Review and activation state machine

```text
available
  -> staged
  -> deterministic-review
  -> codex-review
  -> eligible
  -> human-accepted
  -> activating
  -> activated
```

Failure states:

```text
staged | deterministic-review | codex-review -> review-failed
activating -> activation-failed -> rolling-back -> rolled-back
any integrity check -> custody-broken
human decision -> rejected
```

Each transition produces a new immutable event receipt. Earlier receipts are never edited to reflect later state.

### Availability

Availability detection is read-only. It compares the active pin with an eligible local committed candidate and may display **Update available**. Detection neither runs candidate code nor changes the active version.

### Review

Pressing **Review and Refresh** stages the candidate in quarantine and begins verification. The active bundle continues serving the current session. The Accept control does not exist until all required checks pass.

### Human acceptance

Acceptance is valid only when it includes:

- Review ID.
- Candidate bundle digest.
- Policy-snapshot digest.
- Exact allowed action.
- Single-use response nonce.

The bootstrap consumes the nonce once. Restarting the browser, changing the candidate, changing policy, or expiring the review requires a new review and a new decision.

### Activation

The bootstrap preserves the active version as `previous`, switches the stable runtime path to the accepted version, and refreshes the extension/native-host connection. It then captures the live OS evidence required by the policy.

An accepted candidate is not recorded as activated until the post-refresh live process and behavior checks pass.

### Rollback

If post-activation verification fails:

1. Stop the failed candidate runtime.
2. Restore the prior active pin.
3. Restart only through the normal visible path.
4. Verify the restored ownership tree and behavior.
5. Finalize permanent activation-failure and rollback receipts.
6. Display only the retained report location and permitted navigation actions.

## Project-local custody ledger

All evidence lives beneath the human- and machine-visible directory:

```text
review-receipts/
```

One review or later lifecycle event uses:

```text
review-receipts/<timestamp>_<review-id>/
  report.md
  receipt.json
  attestation.json
  policy-snapshot.json
  project/
    active-version.json
    candidate-version.json
    source-hashes.json
    dependency-lock.json
    test-results.json
  os/
    before/
    verification/
    after/
  receipt.sha256
```

Every canonical `receipt.json` contains:

- Receipt and review IDs.
- Event type and outcome.
- Previous canonical receipt hash.
- Project-evidence hash.
- OS-evidence hash.
- Policy-snapshot hash.
- Verifier identities and versions.
- Active and candidate bundle digests.
- Human-decision reference when applicable.
- Creation timestamp.

Each immutable receipt points to the previous receipt hash. A mutable convenience index may be rebuilt from canonical receipts and is not an authority.

The exact policy snapshot is preserved rather than merely its version number. This allows later debugging to distinguish software regression from a historical assumption that turned out to be wrong.

Existing `runtime-comparisons/` and `repository-comparisons/` evidence remains alongside formal review receipts and may seed the first custody baseline.

## OS-level evidence

The macOS collector captures allowlisted evidence in three phases:

- `before`: the known-good active Chrome -> native host -> Codex ownership tree.
- `verification`: the isolated candidate-test topology, labeled as a test rather than live attachment.
- `after`: the actual refreshed Chrome -> native host -> Codex ownership tree.

Allowlisted evidence includes:

- PID, parent PID, process group, start time, and elapsed time.
- Executable path and SHA-256 digest.
- Working directory.
- macOS code-signing identifier, authority, and Team ID where available.
- Sanitized `sample` output for relevant processes.
- Relevant file descriptors and anonymous transport endpoints.
- TCP listeners owned by relevant processes.
- macOS version, architecture, and boot-session UUID.
- The Codex session-file identity without transcript contents.

The collector must not capture raw process environments, cookies, browser history, conversation text, tokens, arbitrary clipboard contents, hardware serial numbers, or secret-bearing command arguments.

PIDs, descriptors, and socket identifiers are per-run receipts, not durable identities. Chrome's signing Team ID is a durable constraint; a build-specific CDHash is recorded as evidence but may legitimately change across Chrome updates.

Chrome-owned loopback CDP state is recorded separately from sidecar transport. The native host and sidecar Codex process must own no TCP listener.

## Failure presentation

A failed review fails closed. The sidecar and macOS surfaces display no diagnostic prose, partial stack trace, retry advice, or agent interpretation.

Permitted presentation:

```text
Review failed

[Open review report] [Continue in Codex] [Dismiss]
```

- **Open review report** opens the immutable local `report.md`.
- **Continue in Codex** opens the **Chrome Developer** desktop project without starting a task or turn.
- **Dismiss** closes the presentation surface.

If opening a report is unavailable, the exact local report path is displayed instead. The reason for failure lives only in the retained report bundle.

## Retention and tamper evidence

Successful, rejected, failed, activated, and rolled-back receipts remain as provenance. Finalized failure and activation-failure receipts are permanent from the application's perspective:

- No sidecar, updater, Quick Clean, or ordinary maintenance operation may remove or modify them.
- Finalization occurs only after schema and redaction validation.
- The directory is written atomically, made read-only, and may receive the macOS user-immutable flag.
- Missing or changed historical evidence creates a permanent chain-break condition; history is never silently repaired.
- A chain break blocks future refreshes while allowing the currently pinned version to keep operating.

The system cannot prevent the machine owner from deliberately clearing file flags, rewriting all local evidence, deleting the project, or losing the disk. External anchoring or backup may be added later. The first implementation guarantees application refusal and visible detection, not magical indestructibility.

Mutable convenience pointers such as `latest-failure.json` may identify a receipt but are never canonical. Deleting or changing a pointer does not delete or change evidence.

## Redaction policy

Permanent receipts use structured allowlists. Raw diagnostic output is transient and must pass sanitization before finalization.

At minimum, sanitization rejects:

- Environment-variable dumps.
- Authorization headers and bearer tokens.
- Cookie values.
- Database connection strings.
- API keys and credential-shaped literals.
- Conversation or page text.
- Home-directory material unrelated to the reviewed processes.

A receipt that cannot be proven sanitized fails finalization and leaves the candidate inactive. Its minimal sanitization-failure receipt contains no rejected payload.

## Capability and dependency rules

Ordinary review permits implementation and dependency changes only when the effective authority remains within the approved policy.

The following changes make the candidate ineligible for **Review and Refresh**:

- New Chrome permissions or host permissions.
- New page, tab, cookie, history, clipboard, credential, CDP, or browser-automation access.
- A new application listener or remote transport.
- New command-execution or approval-grant behavior.
- A weaker sandbox or approval policy.
- New install lifecycle scripts or unpinned executable dependencies.
- Candidate control over verifier, receipt, dialog, or activation behavior.

Such changes require a separate permission-migration design and cannot be approved by relabeling them as an update.

## Desktop debugging flow

The project may retain a non-canonical local preference identifying the last selected debugging task. The helper must still open the **Chrome Developer** project and let the human choose whether to continue an existing task or start clean.

The system must not:

- Search globally by task title.
- Select the most recent task automatically.
- Treat a matching working directory as project membership.
- Send a debugging prompt automatically.
- Copy a receipt into conversation history automatically.
- Assume one project task contains another task's transcript.

The human may say, for example, "Review the latest failure." The selected agent can then resolve `latest-failure.json` and inspect the immutable receipt using its granted filesystem authority.

## Cleanup behavior

Quick Clean, when later implemented, may clear browser session data and disposable sidecar state only within its explicitly approved scope. It must exclude:

- Canonical review receipts.
- Failure and rollback evidence.
- Policy snapshots.
- Active and previous version pins needed for recovery.
- Desktop project and task bindings.

Cleanup and emergency stop are separate actions. Emergency stop ends active runtime behavior; it does not erase evidence or browser data.

## Verification strategy

### Unit checks

- Candidate-manifest and policy-schema parsing.
- Bundle digest determinism.
- Clean committed-candidate enforcement.
- Dependency-integrity enforcement.
- Capability-delta rejection.
- Single-use decision-nonce consumption.
- Receipt hash chaining and chain-break detection.
- Redaction allowlist and secret-pattern rejection.
- Immutable state-transition validation.

### Process integration checks

- Passing candidate remains quarantined until human acceptance.
- Failing candidate never changes the active pin.
- Malformed Codex attestation fails review.
- Candidate tests cannot suppress trusted tests.
- Accepted candidate starts through the stable launcher.
- Post-activation failure restores the prior pin.
- Chrome exit terminates the native host and its Codex child.
- Native host and sidecar Codex own no listener before or after refresh.

### UI checks

- Update availability is visible but non-blocking.
- Review begins only from an explicit action.
- Acceptance is unavailable before complete verification.
- Failure shows only report location, desktop handoff, and dismissal.
- Dialog actions are fixed by trusted policy rather than candidate content.
- Desktop handoff opens **Chrome Developer** without creating or starting a task.
- Keyboard navigation and visible focus remain usable.

### Custody acceptance check

A refresh is complete only when the receipt chain contains:

1. Pre-review project and OS evidence.
2. Candidate and policy digests.
3. Deterministic test result.
4. Structured Codex attestation.
5. Human decision bound to the candidate.
6. Activation event.
7. Post-activation live OS evidence.
8. Final `activated` result or complete rollback evidence.

## Migration from the prototype

Implementation should proceed without changing the currently working V1 until the new bootstrap passes its own tests.

The migration sequence is:

1. Preserve the current local commit and existing runtime receipts as baseline evidence.
2. Build and test the bootstrap and receipt machinery without wiring activation.
3. Create the first complete versioned bundle from a clean committed state.
4. Compare its digest and behavior with the existing V1.
5. Perform a visible one-time migration from the working-tree launcher to the stable runtime path.
6. Re-register the native-host path or unpacked extension path only if required, with the exact proposed change shown first.
7. Capture pre-migration, migration, and post-migration receipts.
8. Keep the previous working launcher recoverable until the new live ownership and continuity checks pass.

## Completion criteria

The feature is complete when a human can visibly review a committed local candidate, receive deterministic and structured Codex evidence, accept exactly that candidate, refresh into a pinned version, verify the resulting live macOS ownership tree, and automatically return to the prior version on failure—without any silent overwrite, agent-initiated turn, new runtime listener, capability expansion, or loss of permanent failure evidence.
