# Visible V1 Migration Runbook

Status: preparation only. No migration, Chrome registration change, extension
reload, application launch, or live receipt was performed by Task 11.

## Hard stop

Task 12 must first run the automated integration suite and show the complete
read-only migration plan. Stop there. Do not run `--migrate`, change the unpacked
extension directory, reload Chrome Dev, or open the side panel until Tom
explicitly approves that exact plan and install hash.

Approval of a different plan, source commit, extension ID, current-install hash,
or bundle digest is not approval of the displayed plan. Re-run the dry run after
any change.

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
hashes, the committed source hash, every pinned payload/bootstrap/extension file
with destination/hash/mode, and one overall install hash. It must mark the
stable-path identity `unverified` and registration
`unchanged-pending-stable-id-proof`. The caller-provided ID is an expected ID,
not proof of the ID Chrome will derive for the new unpacked path. The plan must
not name Chrome Stable, a network endpoint, or a working-tree
`native-host/host.js` as the proposed registered executable.

## Approved preparation command shape

Only after approval, copy the exact values from the still-current plan:

```sh
node scripts/install-macos.js \
  --migrate \
  --extension-id EXTENSION_ID \
  --expected-current-hash REVIEWED_CURRENT_SHA256
```

Despite the historical `--migrate` flag name, Task 11 implements a preparation
phase only. The installer re-reads both current registration files and refuses if their
combined hash changed. It builds from clean committed local `HEAD` through
fixed Git plumbing, never a remote, working-tree byte, package lifecycle hook,
candidate entry point, dependency installer, or candidate-selected command.

The one-time transaction creates:

- owner-only mode `0700` on the existing project-local `runtime/` custody root;
- `runtime/versions/BUNDLE_DIGEST/` with the sealed complete V1 payload and
  canonical manifest;
- `runtime/active/pin.json` with the first active digest;
- `~/Library/Application Support/Resonant Sidecar/trusted-bootstrap/` with the
  separately pinned closed trust graph and generated concrete runtime adapter;
- `~/Library/Application Support/Resonant Sidecar/extension/` as the stable
  unpacked-extension path;
- `runtime/migration-recovery/CURRENT_HASH/` with the previous launcher,
  previous native-host manifest, and their exact before evidence;
- `runtime/migration-receipts/CURRENT_HASH/` with immutable before, migration,
  and file-verification records;
- a proposed Chrome Dev native-host manifest in the reviewed plan only.

The preparation never replaces the current launcher or Chrome Dev native-host
manifest. `migration-files-prepared` means the new pinned bytes and modes match
the plan and the old registration still has the reviewed current hash. It is
not a claim about the stable-path extension ID or a live process tree. Those
claims belong to Task 12.

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
4. Even if it matches, stop before registration replacement. Task 11 contains
   no completion path for that authority change. Task 12 must show the exact
   registration bytes and receive human approval before switching them.
5. Only after that separately approved switch may the side panel run the Task 12
   zero-tool continuity turns, process evidence, listener check, full Chrome Dev
   exit, relaunch, and repeated continuity check.

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

Task 11 preparation never replaces registration, so a preparation failure
leaves the original V1 launcher and manifest authoritative. Verify their
combined hash still equals the reviewed current hash before doing anything in
Chrome Dev.

The durable recovery sources are:

```text
runtime/migration-recovery/REVIEWED_CURRENT_SHA256/native-host
runtime/migration-recovery/REVIEWED_CURRENT_SHA256/native-host-manifest.json
runtime/migration-recovery/REVIEWED_CURRENT_SHA256/current-installation.json
```

Do not copy them by hand during Task 11. They are evidence for a later
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

## Receipt and debugging locations

- Canonical update receipts: `review-receipts/`
- One-time migration receipts: `runtime/migration-receipts/CURRENT_HASH/`
- Original V1 recovery custody: `runtime/migration-recovery/CURRENT_HASH/`
- Interrupted transaction marker: `runtime/migration-journal.json`
- Human-readable failure report: the `report.md` inside the canonical receipt
  directory selected by `latest-failure.json`

Failure and rollback evidence is never routine-cleanup material. Do not remove
it even after a later successful refresh.
