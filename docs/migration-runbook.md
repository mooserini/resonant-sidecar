# Sealed V2 Preparation and Migration Runbook

Status: live V1 remains attached. Chrome-review Tasks 1–11 are locally complete.
The next operator plan is `docs/superpowers/plans/2026-09-15-v1-to-v2-migration.md`.
This runbook is still the installer/recovery text. It does not by itself
authorize `--migrate`, a registration switch, or a candidate review.

## Hard stop

Do not run `--migrate` until Tom approves the binding dry-run from the 2026-09-15
plan (Chrome Dev quit, clean HEAD after that plan commit, `--extension-id`
`dcgoknilbkadmmiahhgefnckiiihgekp`). That ID is the derived unpacked ID of the
stable path, not the live V1 ID `algfplhdbapdaoimggafkgmpmnadfppl`. Approval of
the inert capability probe, of Task 10, or of a preview hash taken before the
plan commit is not approval of `--migrate`.

The old visible-review-refresh Task 12 remains blocked. `--migrate` still does
not replace registration. Do not hand-copy launcher or manifest bytes.

Approval of a different plan, source commit, extension ID, current-install hash,
Codex executable identity, bundle digest, inventory, or install hash is not
approval of the displayed plan. Re-run the dry run after any change.

## Read-only plan

Chrome Dev must be closed before collecting the final migration plan. Confirm
the checkout is the intended local repository and clean, then use the exact
32-letter unpacked extension ID already displayed by Chrome Dev:

```sh
git status --short
git remote -v
node scripts/install-macos.js --extension-id EXTENSION_ID > /tmp/resonant-sidecar-migration-plan.json
node scripts/verify-install-plan.js /tmp/resonant-sidecar-migration-plan.json
```

The last command is a structural verifier only; it does not write. The plan
must name `Google Chrome Dev`, exactly one *proposed*
`chrome-extension://EXTENSION_ID/` origin, the current launcher and manifest
bytes and hashes, the committed source hash, the inspected concrete non-symlink
Codex executable path/hash/mode, the owner-only `0700` review home, every pinned
payload/bootstrap/extension/baseline file with destination/hash/mode, and one
overall install hash. The verifier also checks the initial active pin, completed
recovery state, and installation witness as one self-consistent VersionStore
baseline. It must mark the
stable-path identity `unverified` and registration
`unchanged-pending-stable-id-proof`. The caller-provided ID is an expected ID,
not proof of the ID Chrome will derive for the new unpacked path. The plan must
not name Chrome Stable, a network endpoint, or a working-tree
`native-host/host.js` as the proposed registered executable.

The plan format and selected review policy are V2. Bundle manifest format stays
`schemaVersion: 1`; these versions describe different contracts. Its exact
49-source control inventory contains 38 trusted-bootstrap files, 8
stable-extension files, and 3 installer files. The sealed bootstrap has 40 files
including generated `package.json` and `runtime-entry.js`. All relative imports
close inside their declared graph. The Node and browser Chrome contracts must
have identical bytes and one shared digest; policy, Chrome schema, adapter, and
graph digests are also bound into the reviewed install hash.

The generated runtime selects V2 for both coordinator and receipt store, builds
canonical semantic evidence once, and supplies the same packet to the Chrome
bridge/journal and isolated Codex verifier. Project-receipt bookkeeping is a
separate copy. Browser executable and adapter hashes are measured; unavailable
version/signing and component details remain explicitly unavailable. Plan
construction performs no model preparation, invocation, download, browser flag
change, or localhost request. A changed adapter, prompt, schema, parser, policy,
receipt, protocol, dialog, or activation file requires control-plane migration;
ordinary candidates cannot authorize that change.

## Approved preparation command shape

Only after approval, copy the exact values from the still-current plan:

```sh
node scripts/install-macos.js \
  --migrate \
  --extension-id EXTENSION_ID \
  --expected-current-hash REVIEWED_CURRENT_SHA256 \
  --reviewed-install-hash REVIEWED_INSTALL_SHA256
```

Despite the historical `--migrate` flag name, the installer implements a preparation
phase only. Immediately before its first write, the installer regenerates the
whole plan from clean committed local `HEAD`, re-reads both current registration
files, re-inspects the concrete Codex executable, and refuses unless the new
install hash is exactly `REVIEWED_INSTALL_SHA256`. That hash binds the source,
bundle, trusted bootstrap, generated runtime entry, executable identity,
inventory, baseline, and proposed registration bytes. Fixed Git plumbing reads
the committed tree; it never invokes a remote, working-tree byte, package
lifecycle hook, candidate entry point, dependency installer, or
candidate-selected command.

The one-time transaction creates:

- owner-only mode `0700` on the existing project-local `runtime/` custody root;
- `runtime/versions/BUNDLE_DIGEST/` with the sealed complete bundle and
  canonical manifest;
- `runtime/active/pin.json`, `runtime/recovery-state.json`, and
  `runtime/installations/migration-v1.json` as one resolvable initial baseline;
- `~/Library/Application Support/Resonant Sidecar/trusted-bootstrap/` with the
  separately pinned closed trust graph and generated concrete runtime adapter;
- `~/Library/Application Support/Resonant Sidecar/extension/` as the stable
  unpacked-extension path;
- `~/Library/Application Support/Resonant Sidecar/codex-review-home/` with mode
  `0700`, dedicated to the pinned verifier;
- `runtime/migration-recovery/CURRENT_HASH/` with the previous launcher,
  previous native-host manifest, and their exact before evidence;
- `runtime/migration-receipts/CURRENT_HASH/` with a separately verified chained
  before/prepared/file-verification record set;
- a proposed Chrome Dev native-host manifest in the reviewed plan only.

The `migration-v1.json` basename is the preserved installation-witness format,
not a claim that the newly prepared runtime uses review policy V1.

The preparation never replaces the current launcher or Chrome Dev native-host
manifest. `migration-files-prepared` means the new pinned bytes and modes match
the plan and the old registration still has the reviewed current hash. It is
not a claim about the stable-path extension ID or a live process tree. Those
claims require the later separately approved live checkpoint.

The migration receipt chain is distinct from canonical lifecycle receipts in
`review-receipts/`. Each migration receipt binds the reviewed install hash,
source commit, current registration bytes/hashes, bundle and trusted-bootstrap
digests, generated runtime-entry digest, exact inventory hash, and predecessor.
It is preparation provenance, not an update-review approval or behavioral proof.
The bundle gate is likewise a declaration/capability comparison; real protocol
and continuity behavior remains a separately approved integration check.

Before any Chrome Dev step, verify the prepared on-disk chain against the exact
reviewed plan retained from the approval checkpoint:

```sh
node scripts/verify-install-plan.js --stored-chain /tmp/resonant-sidecar-migration-plan.json
```

The command is read-only. It requires the fixed `before`, `migration`, and
`after` JSON/sidecar pairs; owner-only receipt-directory custody; sealed regular
files owned by the current user with no symlinks or hardlinks; canonical JSON
bytes; exact sidecar hashes; an intact predecessor chain; and exact registration,
inventory, source, and install-hash binding to the structurally verified plan.
It repeats the full directory inventory plus every root/file identity and mode at
the final boundary. Root and file identities bind nanosecond change and
modification timestamps across the verification window, so an observed
concurrent or transient add, removal, swap, chmod, or hardlink fails closed. Its
JSON output names
the install hash, receipt root, and final receipt hash. A failure is a hard stop:
do not open or load the stable extension, do not change registration, and do not
repair or delete evidence. Retain the reviewed plan and the named
`runtime/migration-receipts/CURRENT_HASH/` directory for collaborative review.

## Human Chrome Dev steps

After the preparation command reports `liveVerification: pending-human-checkpoint`:

1. Open Chrome Dev `chrome://extensions` in the intended on-device Agent
   profile.
2. Keep the original V1 extension and registration intact. Load exactly
   `~/Library/Application Support/Resonant Sidecar/extension/` as an additional
   unpacked extension and record the ID Chrome Dev actually displays.
3. Compare the observed ID with `extensionIdentity.expectedId`. If it differs,
   stop. Do not reload, open the side panel, or change the native-host manifest.
   A new proposed origin requires a newly generated plan and separate approval.
4. Even if it matches, stop before registration replacement. Do not open that
   panel. `--migrate` still does not change the live launcher or manifest.
5. Registration replacement is a separate installer command and a second explicit
   approval. Chrome Dev must be quit. The command writes only the reviewed
   launcher (`0700`) and Chrome Dev native-host manifest (`0600`):

```sh
node scripts/install-macos.js \
  --switch-registration \
  --extension-id dcgoknilbkadmmiahhgefnckiiihgekp \
  --expected-current-hash REVIEWED_CURRENT_SHA256 \
  --reviewed-install-hash REVIEWED_INSTALL_SHA256 \
  --observed-stable-id dcgoknilbkadmmiahhgefnckiiihgekp
```

   It refuses a mismatched observed ID, a stale current hash, a broken stored
   chain, or drift in the prepared bootstrap/extension/bundle trees. It does not
   restage those trees. V1 copies remain in `runtime/migration-recovery/`.
6. Only after that approved switch may the stable-path side panel run the
   zero-tool continuity turns, process evidence, listener check, full Chrome Dev
   exit, relaunch, and repeated continuity check. Disable the old V1 unpacked
   load first. Do not start Review and Refresh on a real candidate here.

The extension UI cannot perform these profile-level actions. A human must be
present for directory selection, any Chrome warning, extension reload, and the
first live connection.

## Expected live ownership

```text
Google Chrome Dev
└── Resonant Sidecar trusted bootstrap (registered native host)
    └── pinned active native-host/host.js
        └── codex app-server
```

The bootstrap, active host, and Codex descendant must own no TCP listener.
Chrome Dev may own only the separately identified loopback CDP port. Closing the
side panel or exiting Chrome Dev must terminate every descendant above.

## Recovery boundary

Preparation never replaces registration, so a preparation failure
leaves the original V1 launcher and manifest authoritative. Verify their
combined hash still equals the reviewed current hash before doing anything in
Chrome Dev.

The durable recovery sources are:

```text
runtime/migration-recovery/REVIEWED_CURRENT_SHA256/native-host
runtime/migration-recovery/REVIEWED_CURRENT_SHA256/native-host-manifest.json
runtime/migration-recovery/REVIEWED_CURRENT_SHA256/current-installation.json
```

Do not copy them by hand during preparation. They are evidence for a later
registration phase, not an instruction to overwrite the still-working V1
registration. A future recovery action must show hash-checking commands with
exact absolute source and destination paths from its reviewed plan.

If `runtime/migration-journal.json` remains, treat the migration as interrupted.
Its `state` is either `preparation-started` or `preparation-failed`, and its
`recovery` field is the exact evidence location to open. Do not rerun migration,
delete the journal, or remove partially prepared artifacts. Continue
collaboratively from that fixed location; the original V1 registration remains
unchanged. A failed preparation should report only this journal/recovery
location for later debugging.

An interrupted preparation can leave sealed staging destinations beside that
journal. Their presence is deliberate fail-closed crash evidence, not a signal
to retry over them. Review the journal, the separately verified migration chain,
and every planned destination before authoring a new recovery transaction. No
preparation command performs automatic rollback or cleanup of that evidence.

## Receipt and debugging locations

- Canonical update receipts: `review-receipts/`
- Separately verified migration chain: `runtime/migration-receipts/CURRENT_HASH/`
- Original V1 recovery custody: `runtime/migration-recovery/CURRENT_HASH/`
- Interrupted transaction marker: `runtime/migration-journal.json`
- Human-readable failure report: the `report.md` inside the canonical receipt
  directory selected by `latest-failure.json`

Failure and rollback evidence is never routine-cleanup material. Do not remove
it even after a later successful refresh.
