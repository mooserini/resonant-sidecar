# V1 → V2 Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the working Chrome Dev Agent-profile sidecar from the V1 working-tree native host to the sealed V2 pinned runtime without a silent registration swap, without a GitHub remote, and without a real candidate Review-and-Refresh until that later mutation is separately approved.

**Architecture:** Preparation writes sealed V2 bytes beside live V1. Chrome Dev keeps launching the current V1 launcher until a later, separately reviewed registration switch. The stable unpacked path is a new directory, so it gets a new Chrome extension ID. The proposed native-host origin must be that future ID, not the live V1 ID. Live Chrome Prompt API use after the switch is the existing visible adapter, not a new probe script.

**Spec:** `docs/superpowers/specs/2026-09-14-visible-review-refresh-design.md` and amendment `docs/superpowers/specs/2026-09-14-chrome-native-semantic-review-amendment-design.md`

**Runbook:** `docs/migration-runbook.md` remains the operator text. This plan is the exact next ledger. Do not revive the old visible-review-refresh Task 12 as if `--migrate` still replaced registration.

**Prerequisite:** Chrome-native semantic-review Tasks 1–11 are locally complete at `f20d6c1` (`docs: record Chrome model capability check`). That capability receipt does not authorize installation.

## Global constraints

- Do not push, add a Git remote, publish, load Chrome Stable, or change `extension/manifest.json` permissions. They stay `nativeMessaging`, `sidePanel`, `storage` with empty host permissions.
- Do not run `--migrate` until Tom approves the **binding** dry-run's exact `installHash`, `expectedCurrentHash`, `sourceCommit`, and `--extension-id`.
- `--migrate` is preparation only. It must not replace `~/Library/Application Support/Resonant Sidecar/native-host` or the Chrome Dev native-host manifest.
- There is currently **no** installer completion path for the registration switch. Hand-copying launcher/manifest bytes is forbidden. The switch is Task 5–6.
- Do not reload, replace, or disable the live V1 unpacked extension at `~/Developer/Uncle-Russet/resonant-sidecar/extension` until after a successful registration switch and continuity check.
- Do not open the stable-path side panel until the observed ID matches the reviewed expected ID **and** registration has been switched under Task 6.
- Keep `Llama.app`, `gpt-oss`, Eloquent/Gemma, port `9931`, WebMCP actuation, CDP control, and every fallback model out.
- Treat destination-exists, journal-present, and verify-chain failure as hard stops. No automatic retry, delete, or repair.
- Generated runtime, migration receipts, and dry-run JSON stay ignored. Track only this plan, runbook edits, tests, and installer code.

## Binding ruling: proposed origin is the stable-path ID

Chrome assigns unpacked IDs without a manifest `key` by SHA-256 of the absolute directory path, mapping the first 16 digest bytes to the `a–p` alphabet (`nibble + 'a'`). That function already reproduces the live V1 ID:

| Path | Derived ID |
| --- | --- |
| `$HOME/Developer/Uncle-Russet/resonant-sidecar/extension` | `algfplhdbapdaoimggafkgmpmnadfppl` (live Agent-profile ID) |
| `$HOME/Library/Application Support/Resonant Sidecar/extension` | `dcgoknilbkadmmiahhgefnckiiihgekp` (stable path; not yet loaded) |

Using the live V1 ID as `--extension-id` would write a proposed origin that the stable path cannot present. After `--migrate`, destinations exist and a second migrate with a new ID is refused (`Migration destination exists`). Therefore the binding dry-run and `--migrate` use:

```text
--extension-id dcgoknilbkadmmiahhgefnckiiihgekp
```

Live V1 origin `chrome-extension://algfplhdbapdaoimggafkgmpmnadfppl/` stays on disk until Task 6. If Chrome later displays any ID other than `dcgoknilbkadmmiahhgefnckiiihgekp` for that exact stable path, stop. Do not switch registration.

Cost if wrong: one extra human ID check still gates the switch; a mismatch leaves V1 authoritative and prepared files as evidence, not as a live host.

## Non-binding preview (do not approve these)

Taken 2026-09-15 while Chrome Dev PID 87164 was still running, at HEAD `f20d6c1`, with `--extension-id dcgoknilbkadmmiahhgefnckiiihgekp`. Structural `verify-install-plan.js` passed. **Committing this plan changes `sourceCommit` and therefore `installHash`.** These values are orientation only:

- `expectedCurrentHash`: `97999fa105e5e313a3a16ceb663109bf98a569602704c645afd6ade4543a1dda`
- preview `installHash`: `68e92fe0ced06a0ae9850f4738b6eab110d8f46c73845046b90e1d8191162e2d`
- V1 launcher SHA-256: `949d8bd55a2a548f0f1589da8ed771644f655fd41efaae1a6430de24342c05bb`
- V1 manifest SHA-256: `b512c743ed9dde0b9961af4a85c70cc7f5a0f724cbb56278de9680b58b84b704`
- Codex executable (realpath of `~/.local/bin/codex`): `$HOME/.codex/packages/standalone/releases/0.153.2-aarch64-apple-darwin/bin/codex`

Registration state in that preview: `unchanged-pending-stable-id-proof`. Stable-path identity: `unverified`.

## File and interface map

| Responsibility | Files |
| --- | --- |
| Read-only plan and preparation | `scripts/install-macos.js`, `scripts/build-initial-bundle.js`, `scripts/verify-install-plan.js` |
| Operator text | `docs/migration-runbook.md`, this plan |
| Registration switch (not present yet) | same installer scripts plus `test/install-macos.test.js` |
| Live V1 attachment (do not move) | `~/Library/Application Support/Resonant Sidecar/native-host`, Chrome Dev `NativeMessagingHosts/com.resonantmirror.sidecar.json`, unpacked `~/Developer/Uncle-Russet/resonant-sidecar/extension` |

---

### Task 1: Binding dry-run after this plan is committed

**Files:** none besides this committed plan and ignored dry-run JSON.

- [ ] **Step 1: Confirm this plan is in `HEAD`, `git status --short` is clean of tracked files, and `git remote -v` is empty**
- [ ] **Step 2: Tom quits Chrome Dev fully. Confirm no `Google Chrome Dev` PID remains**
- [ ] **Step 3: Collect the binding plan and verify it structurally**

```sh
node scripts/install-macos.js --extension-id dcgoknilbkadmmiahhgefnckiiihgekp \
  > review-receipts/runtime-comparisons/v2-migration-binding-plan.json
node scripts/verify-install-plan.js review-receipts/runtime-comparisons/v2-migration-binding-plan.json
```

- [ ] **Step 4: Stop and show Tom `sourceCommit`, `expectedCurrentHash`, `installHash`, `extensionId`, proposed origin, `registration.state`, Codex path/hash, and that `paths.trustedBootstrap` / `paths.stableExtension` are still absent**

Do not run `--migrate` in this task. Chrome remaining open, a dirty tree, or any hash other than the values just printed is not a binding plan.

### Task 2: Prepare sealed V2 bytes

**Files:** none. Uses the committed installer as-is.

- [ ] **Step 1: After Tom approves the Task 1 tuple, run exactly**

```sh
node scripts/install-macos.js \
  --migrate \
  --extension-id dcgoknilbkadmmiahhgefnckiiihgekp \
  --expected-current-hash REVIEWED_CURRENT_SHA256 \
  --reviewed-install-hash REVIEWED_INSTALL_SHA256
```

- [ ] **Step 2: Require JSON `mode: prepared`, `registration` still `unchanged-pending-stable-id-proof`, and `liveVerification: pending-human-checkpoint`**
- [ ] **Step 3: Read-only verify the stored chain against the retained binding JSON**

```sh
node scripts/verify-install-plan.js --stored-chain review-receipts/runtime-comparisons/v2-migration-binding-plan.json
```

- [ ] **Step 4: Re-read live launcher and manifest hashes and confirm they still equal the reviewed `expectedCurrentHash`. Stop. Do not open Chrome Dev yet**

If `runtime/migration-journal.json` exists afterward, treat preparation as interrupted. Do not rerun `--migrate`.

### Task 3: Prove the stable-path ID without switching registration

**Files:** none.

- [ ] **Step 1: Tom opens Chrome Dev Agent profile → `chrome://extensions`**
- [ ] **Step 2: Leave the V1 unpacked extension loaded. Load exactly `~/Library/Application Support/Resonant Sidecar/extension/` as an additional unpacked extension**
- [ ] **Step 3: Record the ID Chrome actually displays. Compare to `dcgoknilbkadmmiahhgefnckiiihgekp`**
- [ ] **Step 4: If it differs, stop. Do not open that panel, do not disable V1, do not change the native-host manifest**
- [ ] **Step 5: If it matches, still stop. Do not open the stable-path side panel. V1 remains the live conversation attachment**

### Task 4: Registration-switch command, tests first, no live write

**Files:**

- Modify: `scripts/install-macos.js`
- Modify: `scripts/verify-install-plan.js`
- Modify: `test/install-macos.test.js`
- Modify: `docs/migration-runbook.md`

**Interfaces:**

- New explicit flag, name to be chosen in the task (`--switch-registration` or equivalent). It requires `--extension-id`, `--expected-current-hash`, `--reviewed-install-hash`, and the observed stable-path ID.
- Refuses unless stored migration chain verifies, live current hash still matches, observed ID equals `dcgoknilbkadmmiahhgefnckiiihgekp`, and planned launcher/manifest bytes match the reviewed plan.
- Writes only the already-reviewed launcher (`0700`) and Chrome Dev native-host manifest (`0600`). Does not restage bootstrap, extension, or version-store trees.
- Leaves V1 bytes in `runtime/migration-recovery/<currentHash>/`.
- Default without the flag remains dry-run; `--migrate` remains preparation-only.

- [ ] **Step 1: Write failing tests for missing observed ID, mismatched ID, stale current hash, missing stored chain, destination bootstrap/extension drift, and success that changes only launcher+manifest**
- [ ] **Step 2: Implement the switch against those tests. Do not invoke it against the live Chrome Dev files in this task**
- [ ] **Step 3: `npm run check` and a sequential `npm run check:chrome-review`. Commit separately**

### Task 5: Human-approved registration switch

- [ ] **Step 1: Stop and show Tom the exact switch command, planned launcher bytes/hash, planned manifest JSON (origin `chrome-extension://dcgoknilbkadmmiahhgefnckiiihgekp/`), and recovery paths**
- [ ] **Step 2: After approval, Tom quits Chrome Dev. Run the reviewed switch command once**
- [ ] **Step 3: Confirm live manifest path still names `.../Resonant Sidecar/native-host` and allowed origin is only the stable-path ID. Confirm recovery copies still hash as the pre-switch V1 bytes**

### Task 6: Live V2 attachment, then stop before a candidate review

- [ ] **Step 1: Disable the old V1 unpacked load in `chrome://extensions` (do not delete the Developer tree). Keep the stable-path extension enabled**
- [ ] **Step 2: Open the stable-path side panel. Confirm V2 chrome-review controls exist and no review is in progress**
- [ ] **Step 3: Complete several zero-tool conversational turns. Record thread/turn IDs and reply hashes, not transcript text**
- [ ] **Step 4: Confirm process tree is Chrome Dev → trusted bootstrap → pinned `native-host/host.js` → `codex app-server`, with no sidecar-owned TCP listener. Chrome Dev may still own loopback CDP**
- [ ] **Step 5: Close the panel; descendants must exit. Quit and relaunch Chrome Dev; resume the same thread; confirm the old invocation cannot resurrect a probe or a review**
- [ ] **Step 6: Optional, only with a fresh click from Tom: use the V2 **Prepare** / **Run local analysis** controls on no candidate — if the panel refuses because no review is issued, that is success. Do not start Review and Refresh on a real candidate in this plan**
- [ ] **Step 7: Update `docs/chrome-semantic-review-test-receipt.md` or a sibling live-migration receipt with hashes and commands. `git diff --check`. Commit `docs: record V2 live attachment`. Do not push**

## Final plan gate

- [ ] Binding dry-run used `dcgoknilbkadmmiahhgefnckiiihgekp` and was approved after this document's commit.
- [ ] `--migrate` left V1 registration bytes unchanged and `verify-install-plan.js --stored-chain` intact.
- [ ] Chrome-displayed stable-path ID matched the derived ID before any switch.
- [ ] Registration switch existed as tested installer code and ran only after a second explicit approval with Chrome Dev quit.
- [ ] Live attachment used the pinned bootstrap, not working-tree `native-host/host.js`.
- [ ] No sidecar-owned TCP listener; no permission/host-permission change; no Git remote; no candidate activation.
- [ ] V1 recovery copies remain readable. Old Task 12 candidate Review-and-Refresh remains a later plan.

## Recovery

Preparation or switch failure leaves V1 authoritative if the live launcher/manifest hash still equals the reviewed current hash. Evidence:

```text
runtime/migration-journal.json
runtime/migration-recovery/REVIEWED_CURRENT_SHA256/
runtime/migration-receipts/REVIEWED_CURRENT_SHA256/
```

Do not delete those trees. Do not copy recovery files onto the live registration except through the reviewed switch command or a later reviewed recovery plan with exact source and destination paths.
