# Chrome semantic review: automated evidence

This is a fake-model boundary proof. It does not establish real Chrome API
availability, browser integration, inference locality, model accuracy, exact
model identity, or prompt-injection resistance. The human-present inert
capability check is a separate checkpoint recorded later in this file. No
installation, migration, registration, candidate activation, publication, or
push is part of either proof.

## Reproduce

```sh
npm run check
npm run check:chrome-review
npm run verify:receipts
git diff --check
git status --short --branch
git remote -v
```

Run the two test gates sequentially. Concurrent full-suite execution is outside
this claimed gate: during the correction, concurrent runs each failed the existing
emergency-Stop race test during cleanup. A separate fixture-only diagnostic held
an append lock for 4.5 seconds, reproducing the mechanism: the test's four-second
Chrome-ready wait expired, then shutdown recovery observed `busy` and reported
`Completion receipt custody broken`, masking the wait timeout. That mechanism
was reproduced; attribution of the original concurrent failures to it remains
an inference. Their logs are retained, and neither production behavior nor race
test timing was changed. Passing sequential gates are required for this receipt.

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
| Receipt custody | Original V1 golden bytes, a valid V1-to-V2 lifecycle, mixed-chain verification, semantic-artifact tamper detection, supplied-root verification without mutation; extra/replaced golden directory symlinks, golden hardlinks, unexpected inventory, and directory substitution at sealing |

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

With no arguments, `verify:receipts` validates the committed golden V1 source
against the exact 28-file inventory and its directory topology (with only an
optional empty `.pending` directory). Links, special files, missing paths, and
unexpected entries fail before permission changes. It snapshots validated bytes
through held file descriptors, reconstructs only fixed expected paths in a
private disposable root, and validates that entire copy before restoring the
documented Git-unrepresentable modes. Recursive sealing uses `fchmod` on held,
no-follow-opened inodes, with ancestor identity and inventory checks before
descent and use; cleanup likewise changes only held temporary directory inodes.
The regression suite substitutes a copied directory at the permission-change
boundary and checks that external modes and bytes remain unchanged.

The command then appends fixed V2 receipt fixtures through the real writer, using
fixed timestamps and a collision-free fixture ID sequence through its existing
UUID hook, and names the reproducible intact mixed tail. The output labels its source
`disposable-mixed-fixture` and its proof `receipt-chain`. It cleans that temporary
root after verification. These checks do not claim an atomic snapshot or an OS
security boundary against arbitrary concurrent same-user filesystem changes.

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

Reproducible disposable mixed-fixture tail (eight events, policies 1 and 2):
`5edc6cee621128bf1956ebfa4f47a6c0e8ad3c4132bad96e35b67f8fb81d163b`.
The earlier Task 10 command used random receipt IDs; its recorded tail was a
single-run result, not a reproducible fixture identity. Supplied-root verification
and production receipt ID generation are unchanged.

## Claim boundary

Chrome analysis is labeled `modelIdentityAssurance: not-attested` and
`inferenceBinding: not-established`. Receipt hashes establish retained-byte
integrity. They do not establish semantic truth or exact inference provenance.
The bootstrap remains an exact reviewed and pinned source identity with bounded
lexical defense in depth; these tests do not prove arbitrary JavaScript safe.

Exact local RED/GREEN commands, counts, hashes, and commit identities belong in
the ignored Task 10 report and TAP receipts.

## Human-present inert capability check

Date: 2026-09-15. Probe document commit: `fdef7c327369a4fe5e451acf7f7644d2be365d84`.
Worktree: `$HOME/Developer/Uncle-Russet/resonant-sidecar/.worktrees/visible-review-refresh`.
This checkpoint does not load the prepared V2 extension, change native-host
registration, migrate V1, review a candidate, or push.

Tom approved the exact frozen Console script hash
`0684a6e86be943271d5f3abdc08a72fd086b0695f6dcde9d5690e68b461f0956`
and its resource consequence before any `LanguageModel.create()` or `prompt()`.

### Target

- Browser: Google Chrome Dev 155.0.8048.0, local Agent profile (`Profile 3`)
- Already-loaded unpacked V1 extension ID: `algfplhdbapdaoimggafkgmpmnadfppl`
- Loaded path: `$HOME/Developer/Uncle-Russet/resonant-sidecar/extension`
- Side-panel URL observed by the script:
  `chrome-extension://algfplhdbapdaoimggafkgmpmnadfppl/sidepanel.html`
- Declared and granted APIs: `nativeMessaging`, `sidePanel`, `storage`
- Host permissions: none
- Live manifest SHA-256: `24c3db6d6cde3b620c0307a36316e3150d59f43b3f54cf9d14ade77ff71e9db9`

The worktree `extension/` tree was not loaded. The extension was not reloaded,
replaced, or reinstalled to make this check work.

### Separate collector observation (not a LanguageModel field)

- Executable: `/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev`
- Executable SHA-256: `9d961658010224003357deb7c67048570d8b6687dcd22e8c87f367183abf3876`
- Signing identifier `com.google.Chrome.dev`, team `EQHXZ8M8AV`,
  CDHash `2d0aaeff20299688c0aa451cfd10d57713e0a783`
- Authority: Developer ID Application: Google LLC (EQHXZ8M8AV) /
  Developer ID Certification Authority / Apple Root CA; notarization stapled
- `codesign --verify --strict` exit 1: disallowed `com.apple.FinderInfo` xattr on
  `Google Chrome Framework.framework/Versions/Current/.`
  Displayed identity is recorded; strict verification is not claimed as passed.

### Console snapshots (exact 17-field allowlist)

Availability after paste, no create:

`startedAt` `2026-09-15T08:36:26.657Z`; `availability` `available`;
`state` `available`; `preparation` `not-needed`; `structuredOutput` `not-run`;
`finishedAt` `null`; `runDestroy` `not-created`.

After one trusted **Run inert probe** click:

`state` `running` at `2026-09-15T08:39:05.421Z`; `runDestroy` `pending`.

Chrome then printed its own Built-In AI / LanguageModel feedback notice. That
text is browser-originated and is not a probe receipt field.

Terminal snapshot:

```json
{"probeRevision":"resonant-sidecar.inert-capability.v1","inputSha256":"88f4231031edc2969eececefe010ebe8de434dbec7c106af1148e55413a42d63","schemaSha256":"25ef9c147e32bf985d9481d22e1e5f3ffa19859b3e72e751a7a1824631b20b00","startedAt":"2026-09-15T08:36:26.657Z","updatedAt":"2026-09-15T08:39:12.122Z","finishedAt":"2026-09-15T08:39:12.122Z","sidePanelUrl":"chrome-extension://algfplhdbapdaoimggafkgmpmnadfppl/sidepanel.html","sidePanelOrigin":"chrome-extension://algfplhdbapdaoimggafkgmpmnadfppl","availability":"available","state":"completed","preparation":"not-needed","preparationProgress":null,"contextWindow":9216,"structuredOutput":"passed","abort":"not-requested","preparationDestroy":"not-created","runDestroy":"succeeded"}
```

`structuredOutput: passed` means the returned JSON matched the inline V2 schema
shape. It is not semantic correctness, candidate authority, or production parser
acceptance. No model prose, findings, or extra fields were logged. The run
session was destroyed (`runDestroy: succeeded`). Prepare was not used.

### Lifecycle

Before close, Chrome Dev PID was 23891. Ordinary V1 native-host `host.js` and
`codex app-server` were attached because the side panel was open. The probe
script did not call `chrome.runtime`, `connectNative`, or `sendMessage`. Browser
PID 23891 also listened on `127.0.0.1:9222` (DevTools/CDP); that listener was
not opened by the probe.

After panel close and reopen: probe buttons absent; no analysis auto-ran. A
fresh native-host pair started. The panel showed Codex
`no rollout found for thread id 01a0a434-e741-7162-812c-3c7fad84b64a`. That is
V1 conversation continuity, not a LanguageModel result and not a resumed probe.

After full Chrome Dev quit and Agent-profile relaunch: Chrome PID 87164;
new native-host pair; probe buttons absent; no analysis auto-running; panel
looked like the uninitiated sidecar. Former invocation could not resume.

Ignored local evidence:
`review-receipts/runtime-comparisons/2026-09-15T08-33-14Z-chrome-language-model-capability/`.

### Labels

- `modelIdentityAssurance: not-attested`
- `inferenceBinding: not-established`
- Locality observation, not a proof:
  `documented-on-device; no adapter network observed`
- Acquisition vs inference: availability was already `available`, so this run
  did not click Prepare. Session destroy does not imply deletion of
  Chrome-managed model files.

Stop. Do not load the prepared stable extension, change the native-host
manifest, migrate V1, run a real candidate review, or begin the old Task 12.
