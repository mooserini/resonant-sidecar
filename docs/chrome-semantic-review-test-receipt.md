# Chrome semantic review: automated evidence

This is a fake-model boundary proof. It does not establish real Chrome API
availability, browser integration, inference locality, model accuracy, exact
model identity, or prompt-injection resistance. The human-present inert
capability check remains a separate checkpoint. No installation, migration,
registration, candidate activation, publication, or push is part of this proof.

## Reproduce

```sh
npm run check
npm run check:chrome-review
npm run verify:receipts
git diff --check
git status --short --branch
git remote -v
```

`check:chrome-review` runs the complete fake `LanguageModel` integration matrix
and the existing runtime race suite. The integration uses the real side-panel
controller, Chrome adapter, native message framing/parser, lifecycle router,
bridge, durable journal, coordinator, nonce store, version store, and permanent
receipt writer/verifier. Temporary baseline and candidate bundles, deterministic
and Codex result fixtures, synthetic OS observations, and an in-memory native
Port supply the external boundaries. No Chrome process, Codex inference,
alternate model, model service, or network is used.
The unchanged version store's fixed system-Perl kernel-lock helper operates on
the temporary runtime descriptor; other process-launch paths are blocked.

The baseline active pin is seeded only in disposable temporary storage. No
candidate under review is accepted or activated. Each ordinary attempt ends
at eligibility or a permanent failed semantic receipt. Both human nonces are
checked at their issuance point against finalized deterministic, Codex, and
Chrome stages, a retained favorable analysis, and the matching journal receipt
mark. Recovery verifies retained history and never recreates decisions.
After a committed eligible receipt, startup appends one `rejected` decision-window
event while retaining the original favorable semantic artifact. A second
recovery appends nothing. There is still exactly one original semantic terminal
receipt; a favorable artifact in history does not restore a live grant.

## Matrix

| Boundary | Cases |
| --- | --- |
| Initiation and preparation | Available success, separate preparation success, API absence, unavailable/unknown availability, downloadable/downloading setup, declined preparation |
| Interruption | Quota at creation and prompting, cleanup failure, timeout, cancellation, panel closure, connection loss, emergency Stop, late completion |
| Required review gates | Incomplete input, deterministic failure, Codex failure, unfavorable and inconclusive analysis |
| Output and provenance | Malformed/trailing/duplicate/extra/unsupported/oversized output, invented references, contradictory findings, command/path/URL/permission/state/nonce/policy fields, source drift, sanitization failure, custody failure |
| Protocol | Unsolicited and duplicate output; each review, active/candidate/policy/input/evidence/prompt/schema/adapter digest, invocation, generation, deadline, channel, and restart binding |
| Crash recovery | Pending invocation at restart, terminal journal before receipt, receipt before journal mark, fully receipted invocation; each recovered twice |
| Receipt custody | Original V1 golden bytes, a valid V1-to-V2 lifecycle, mixed-chain verification, semantic-artifact tamper detection, supplied-root verification without mutation |

Every lifecycle case checks active-pin bytes, withheld premature nonces,
model-input isolation, fixed protocol actions and permissions, absent network
and listener effects, exactly one terminal semantic event, session destruction,
and historical V1 verification. The fixed emergency Stop also retains the
ordinary conversation-interrupt behavior. Source strings resembling commands,
URLs, permissions, state changes, Unicode/encoded payloads, and protocol JSON
remain untrusted evidence.

The production status vocabulary intentionally maps quota at creation to
`unavailable` and quota after prompting to `custody-failure`. Setup-required is
a visible waiting state; explicit cancellation from that state is recorded as
`cancellation`. A simulated restart with no permanent semantic receipt records
`terminal-receipt-interrupted`, as required by the crash-reconciliation rule.
These names do not claim a model ran when no execution was observed.

## Mixed receipt command

With no arguments, `verify:receipts` copies the committed golden V1 receipts
into a disposable root, restores their documented Git-unrepresentable modes,
appends fixed V2 receipt fixtures through the real writer, and names the intact
mixed tail. The output labels its source `disposable-mixed-fixture` and its
proof `receipt-chain`. It cleans that temporary root after verification.

The golden V1 fixture has the original synthetic `available -> review-failed`
sequence. Its hashes and receipt layout remain valid, but that sequence is not
a valid coordinator lifecycle. The integration therefore verifies the golden
fixture separately in every case and uses a fresh disposable V1
`available -> staged -> review-failed` prefix for coordinator execution.
Neither proof rewrites or reinterprets historical V1 bytes.

An explicit receipt directory can be checked with:

```sh
node scripts/verify-receipt-chain.js --root /absolute/project/review-receipts
```

Supplied storage is checked for symbolic/hard links and nonregular files,
copied without repair or mode normalization, and verified
in temporary storage. The underlying verifier can write a custody marker on
corruption; that marker stays in the temporary copy. The supplied tree is never
modified. Exit codes are 0 for intact, 1 for custody failure, and 2 for invalid
command usage. This proves the captured receipt bytes, not an atomic snapshot
of concurrently changing storage.

Original golden V1 tail:
`c2a28877cf698c504739dd2f3089c14b0f128c66bc8dcbc1791e292fa650aeb5`.

## Claim boundary

Chrome analysis is labeled `modelIdentityAssurance: not-attested` and
`inferenceBinding: not-established`. Receipt hashes establish retained-byte
integrity. They do not establish semantic truth or exact inference provenance.
The bootstrap remains an exact reviewed and pinned source identity with bounded
lexical defense in depth; these tests do not prove arbitrary JavaScript safe.

Exact local RED/GREEN commands, counts, hashes, and commit identities belong in
the ignored Task 10 report and TAP receipts. Real Chrome capability results
have not been collected by this task.
