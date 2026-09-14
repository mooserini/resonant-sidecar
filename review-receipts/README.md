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
root. It defaults to the exact `policy/review-policy.v1.json` snapshot and rejects
different policies. Trusted adapters can inject `clock`, `randomUUID`, `rename`,
and `immutable` (an asynchronous function receiving the finalized directory).
The default immutable adapter runs `/usr/bin/chflags -R uchg` on macOS only.

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
  humanDecisionRef   // optional SHA-256 reference, never the decision nonce
}
```

Each project/OS evidence slot is a structured object. Empty objects mean no
evidence collected for that phase yet. Bundle digests may be null when no bundle
is known. The ledger validates event names against the policy; lifecycle
transition authorization belongs to the trusted orchestrator. Outcomes are policy
state names or `passed`, `failed`, or `sanitization-failed`.

Structured fields are allowlisted in `review/redaction.js`. Raw environments,
process output, page/conversation text fields, credential literals, unknown
fields, getters, cyclic objects, and unrelated home paths are rejected. All
home-absolute paths are currently excluded: producers must use project-relative
paths and sanitized file identities. `argv`/`command` arrays must exactly match a
trusted policy test command. Attestation prose is bounded and scanned, but its
provenance still depends on the trusted producer; no string filter can determine
whether arbitrary innocuous prose was copied from a page.

A sanitization rejection appends one fixed `review-failed` event with outcome
`sanitization-failed`, null bundle digests, empty evidence, and sanitizer identity.
It retains none of the input, including its review ID, and then rejects the call
with a fixed `SanitizationError`. Schema failures reject without an append.
Callers should not append a duplicate failure for a `SanitizationError`.

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
  receipt.sha256
```

JSON uses `review/canonical-json.js` with no trailing newline. `receipt.sha256`
is the SHA-256 of the exact `receipt.json` bytes followed by a newline. A receipt
links to the previous receipt's exact hash. `policySnapshotHash` hashes the exact
canonical policy bytes. `projectEvidenceHash` hashes a canonical map from each
`project/*` filename **plus `attestation.json` and `report.md`** to that file's
SHA-256; this binds all review prose without extending the policy receipt fields.
`osEvidenceHash` hashes the analogous map of all three OS files. No generated
evidence file is omitted from the hash closure. `report.md` is generated from
safe receipt metadata; callers cannot supply raw Markdown.

Finalization writes exclusive owner-only files under `.pending/<uuid>`, flushes
files and directories, verifies schema/redaction/hash closure, advances the
custody witness, and atomically renames the completed directory. New final files
become `0444`, directories `0555`, with best-effort macOS user-immutable flags.
Verification also checks the required modes and refuses symlinks, hard-linked
files, extra files/directories, malformed schemas, and altered canonical bytes.
There is no application API for modifying, deleting, or repairing old receipts.

## Custody status and local witnesses

`verifyChain()` returns `{state: 'intact', count, tailHash, receipts}` or
`{state: 'custody-broken', reason}`. Returned receipt objects additionally contain
their `directory` and `receiptHash`. Readers and writers serialize through a
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
