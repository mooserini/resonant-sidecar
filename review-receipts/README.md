# Local custody evidence

Generated receipts are machine-local evidence, not source artifacts. Only this
README is tracked. Never add generated receipts, checkpoints, pending writes, or
convenience pointers to Git.

`runtime-comparisons/` and `repository-comparisons/` retain their historical
meaning and remain untouched. They do not participate in canonical chain
traversal. A future explicit import ceremony would append a new canonical
receipt; it would not rewrite or silently adopt those historical directories.

## Producer interface

Construct `ReceiptStore` with an absolute, explicit project-local `review-receipts`
root. It defaults to the exact `policy/review-policy.v1.json` snapshot. A trusted
caller may select the exact registered V2 snapshot; altered/unknown snapshots
are rejected. Readers validate every receipt against its own recorded policy,
allowing an immutable V1 prefix followed by V2 reviews. Appending V1 after V2 or
changing policy within a review is rejected. Trusted adapters can inject `clock`, `randomUUID`, `rename`,
and `immutable` (an asynchronous function receiving the finalized directory).
The default immutable adapter runs `/usr/bin/chflags -R -P uchg` on macOS only,
explicitly refusing symbolic-link traversal.

`finalizeEvent` consumes:

```js
{
  reviewId, eventType, outcome,
  verifierIdentities: [{ name, version }],
  activeBundleDigest, candidateBundleDigest,
  projectEvidence: {
    activeVersion, candidateVersion, sourceHashes, dependencyLock, testResults
  },
  osEvidence: { before, verification, after },
  attestation,       // optional; null until available, otherwise v1 schema
  humanDecisionRef,  // optional SHA-256 reference, never the decision nonce
  semanticReview    // V2 only; optional exact trusted Chrome terminal envelope
}
```

Each project/OS evidence slot is a structured object. Empty objects mean no
evidence collected for that phase yet. Bundle digests may be null when no bundle
is known. The ledger validates event names against the policy; lifecycle
transition authorization belongs to the trusted orchestrator. Outcomes are policy
state names or `passed`, `failed`, or `sanitization-failed`.

Structured fields are allowlisted in `review/redaction.js`; check records also
use contextual field and type schemas, with scalar expected/actual values.
Named records reject environment-style identifiers, common environment names,
and names denoting credentials or excluded raw data. Recognized raw-environment
representations, process-output/page/conversation fields, credential patterns,
unknown fields, getters, cyclic objects, and unrelated home paths are rejected. All
home-absolute paths are currently excluded: producers must use project-relative
paths and sanitized file identities. `argv`/`command` arrays must exactly match a
trusted policy test command. Attestation prose is bounded and scanned, but its
provenance still depends on the trusted producer; no string filter can determine
whether arbitrary innocuous prose was copied from a page.

A sanitization rejection appends one trusted `review-failed` event with outcome
`sanitization-failed`, null bundle digests, empty evidence, and sanitizer identity.
It retains none of the input, including its review ID, and then rejects the call
with a fixed `SanitizationError`. Schema failures reject without an append.
V1 retains its historical fixed `sanitization-failure` review ID and sanitizer
version 1. V2 uses sanitizer version 2 and the first unused
`sanitization-failure-v2-<n>` review ID, starting at 1 and checking all existing
V1/V2 review IDs. This prevents anonymous failures from colliding across policy
versions or with an existing ordinary review.
Callers should not append a duplicate failure for a `SanitizationError`.
That generic fallback cannot terminalize the original Chrome invocation: it
retains no rejected binding fields. The trusted coordinator must sanitize the
Chrome result before finalization and, when needed, construct a bound failure
envelope from its own lifecycle state with null analysis/digest. It must never
recover bindings from a rejected payload.

## Canonical bytes and layout

Each event receives a distinct directory. UTC timestamp colons become hyphens;
the clock advances at least one millisecond beyond the previous event, including
when its injected clock repeats or moves backward.

```text
<timestamp>_<review-id>/
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
    before/evidence.json
    verification/evidence.json
    after/evidence.json
  semantic-reviews/                  # V2 only, after Chrome terminal binding
    chrome-language-model.json
  receipt.sha256
```

JSON uses `review/canonical-json.js` with no trailing newline. Verification reads
Buffers, rejects invalid UTF-8, compares exact canonical encoded bytes, and hashes
the actual persisted bytes. `receipt.sha256`
is the SHA-256 of the exact `receipt.json` bytes followed by a newline. A receipt
links to the previous receipt's exact hash. `policySnapshotHash` hashes the exact
canonical policy bytes. `projectEvidenceHash` hashes a canonical map from each
`project/*` filename **plus `attestation.json` and `report.md`** to that file's
SHA-256; this binds all review prose without extending the policy receipt fields.
`osEvidenceHash` hashes the analogous map of all three OS files. No generated
evidence file is omitted from the hash closure. `report.md` is generated from
safe receipt metadata; callers cannot supply raw Markdown.

### Version-selected Chrome evidence

`receiptLayoutFor(recordedPolicy, eventRecord)` validates the frozen policy
snapshot and exact event shape before selecting its allowed files/directories.
V1 retains its original fields and bytes. V2 derives its event fields from the
same recorded `receiptFields` plus `semanticReviewsHash`; neither approved
policy file is rewritten. The V2 hash is SHA-256 of the exact canonical bytes of
`semantic-reviews/chrome-language-model.json`, not a filename or current config.

For available, staged, deterministic-review, codex-review and entry into
chrome-semantic-review, the hash is null and the semantic-reviews directory is
absent. The immediately following same-review eligible or review-failed event
must atomically introduce the artifact. The sole earlier exception is
review-failed immediately after deterministic-review for incomplete-input:
coverage and reason are incomplete-input, execution is not-run, and eligibility
is candidate-withheld. This records oversized evidence without running a model.
Earlier failures in other prerequisites can have a null hash and no artifact.

The first artifact and terminal record must match the review, active bundle,
candidate bundle and policy identities of the Chrome-entry event (or the
permitted deterministic-review predecessor for incomplete input). Chrome entry
creates a per-review pending obligation. An intervening staged/review-entry
event cannot replace it; only a bound eligible/review-failed event settles it.
A custody-broken event can retain the pending obligation but cannot erase it or
make a later terminal event bypass the immediate-predecessor requirement.

After binding, every later event for that review carries identical artifact
bytes and hash. Omitting semanticReview from later producer input carries the
verified artifact forward, including after restart. Explicit replacement or
null rejects the append. Artifact/event review, bundle and policy bindings must
match; later events cannot drop or change the bound artifact even if all local
event hashes are recomputed. Full lifecycle transition authorization remains
with the trusted coordinator.

The artifact permits exactly the amendment's 28 fields:
schemaVersion, reviewerId, evidenceKind, reviewerRequirement, provenanceKind,
modelIdentityAssurance, inferenceBinding, reviewId, invocationId,
runtimeGeneration, activeBundleDigest, candidateBundleDigest,
policySnapshotHash, inputDigest, promptDigest, schemaDigest, adapterDigest,
coverageStatus, availabilityStatus, executionStatus, reasonCode, startedAt,
completedAt, browserObservation, componentObservation, analysis, analysisDigest,
eligibilityEffect. Only analysis originates with the model. Every digest binding
is required even for not-run/incomplete-input evidence. Runtime generation is
a nonnegative safe integer; invocation identity uses the
trusted request's 1–128 character ASCII letters/digits/dot/underscore/colon/hyphen
contract and begins with a letter or digit. A valid completed
analysis requires its matching digest; unavailable/invalid output uses null
analysis and null digest. Terminal-receipt interruption always retains null
analysis/digest and cannot reconstruct favorable model output.

Fixed failure reasons are api-absent, setup-required, setup-declined,
unavailable, timeout, cancellation, panel-closure, browser-restart,
connection-loss, incomplete-input, malformed-output, unfavorable-analysis,
inconclusive-analysis, provenance-drift, sanitization-failure, custody-failure,
and terminal-receipt-interrupted. Transport reasons must be explicitly mapped
to these codes by trusted lifecycle code. Success uses null reason and
prerequisite-satisfied; failures use candidate-withheld. Availability is one of
available, api-absent, setup-required, setup-declined, unavailable, not-checked;
execution is completed, failed or not-run.

The accepted reason/status combinations are exact:

| Reason | Availability | Execution | Analysis |
| --- | --- | --- | --- |
| null | available | completed | no-blocking-concern |
| api-absent, setup-required, setup-declined, unavailable | same value as reason | not-run | null |
| incomplete-input | not-checked | not-run | null |
| malformed-output | available | failed | null |
| unfavorable-analysis | available | completed | blocking-concern |
| inconclusive-analysis | available | completed | inconclusive |
| terminal-receipt-interrupted | available or not-checked | failed | null |
| timeout, cancellation, panel-closure, browser-restart, connection-loss, provenance-drift, sanitization-failure, custody-failure | available | failed | null |
| those same eight interruption/failure reasons | any of the six allowlisted availability states | not-run | null |

Coverage is complete-input-supplied for every row except incomplete-input, which
requires incomplete-input. Completed analyses require their matching digest;
all null analyses require a null digest. The success row alone satisfies the
prerequisite; every other row withholds the candidate. A not-run interruption
can preserve the last known availability while waiting for user initiation;
failed inference requires available. A terminal-receipt interruption can instead
record not-checked when the pre-crash availability is not retained.

Semantic sanitization rejects unknown fields, raw diagnostics, recognizable
prompt/source/command/URL/path forms, and forbidden provenance/safety claims.
It rechecks the exact analysis schema, honest allowlisted observations, timing,
status consistency and digest binding. The result binder owns membership in
the supplied source and hunk set, because raw source is not retained here.
String scanning cannot prove the origin of innocuous prose or detect every
semantic equivalent of a command. The envelope comes only from trusted code,
the model gets only the analysis schema, and retained prose is never executable.

Human readers should describe the result as Chrome on-device semantic analysis,
observed browser provenance and observed model component metadata. Exact
inference model identity is not attested; inference binding is not established.
Hashes prove retained byte integrity, not semantic truth or inference origin.

Finalization writes exclusive owner-only files under `.pending/<uuid>`, flushes
files and directories, verifies schema/redaction/hash closure, advances the
custody witness, and atomically renames the completed directory. Sealing holds
verified no-follow file and directory handles across rename, checks inode and
ancestor identities, and changes permissions through those handles. It never
uses pathname chmod. New final files become `0444`, directories `0555`, with
best-effort macOS user-immutable flags. The sealed layout and bytes are reverified
before and after the immutable adapter, before finalization can return success.
Verification also checks the required modes and refuses symlinks, hard-linked
files, extra files/directories, malformed schemas, and altered canonical bytes.
There is no application API for modifying, deleting, or repairing old receipts.

## Custody status and local witnesses

`verifyChain()` returns `{state: 'intact', count, tailHash, receipts}` or
`{state: 'custody-broken', reason}`. Returned receipt objects additionally contain
their `directory` and `receiptHash`, and `semanticReview` when Chrome evidence
is bound (the latter is not an extra on-disk event field). Readers and writers serialize through a
local `.append-lock`; a concurrent or interrupted operation yields `busy` to
verification and refuses appends. A stale lock is never automatically removed.

`.custody-head` is a **noncanonical monotonic witness**, containing only count
and tail hash. It can detect deletion of the newest receipt or all canonical
receipts. It never supplies receipt contents, rebuilds history, or overrides
canonical hashes. After the first append, a missing/mismatched witness fails
closed. An interrupted write, pending evidence, or witness mismatch blocks new
appends. The ledger does not silently complete or undo interrupted transactions.

An observed custody break writes a fixed `.custody-broken` latch. Restoring the
old bytes does not clear the recorded break. Verification therefore can write
this safety marker and a temporary reader lock, while never changing canonical
evidence. The witness is advanced before rename so a crash cannot expose an
unwitnessed receipt as intact; interruptions may require explicit future recovery.

`latest-failure.json` is a rebuildable convenience pointer. `resolveLatestFailure()`
verifies the chain, recreates that pointer from canonical failure events, and
returns the immutable `report.md` path or null. Corrupt, absent, or interrupted
pointer writes do not alter custody. Orphan `.failure-next-*` files are ignored
and are never promoted to evidence.

The machine owner can deliberately remove flags, rewrite all local state, or
delete the entire project/root. Complete root loss cannot be distinguished from
a new ledger without an external anchor. This implementation offers application
refusal and local tamper evidence, not external anchoring or disk-loss recovery.
It adds no listener, browser authority, activation, cleanup, or erasure flow.
