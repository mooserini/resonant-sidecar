# Spike 005 — command bar + white-label panel (2026-09-23, ~04:00–05:40 EDT)

**Question.** Can the panel grow a quirky command control that sends only
typed protocol messages (no sidecar slash-parser, per V1), and can the
panel wear the agent's own name and face instead of hardcoded product
branding — without tripping the bootstrap's shape gates?

**Method.** Isolated branch `spike/command-bar` off `main` (post-PR-#7
merge `3442f15`); live copies backed up to
`~/.hermes/cache/scratch/sidecar-004/` before every copy-in and
cold-launcher-verified after. Full `npm test` on the final bytes.

## Result: VALIDATED live — 1482/1482, face on the wire

Commits (branch `spike/command-bar`):

- `de7fc93` — glyph button + 8-verb menu (proven ACP verbs only)
- `ad0b762` — refinements: unbracketed glyph, hidden dead capture,
  icon-only Stop, `RESONANT_AGENT_NAME` displayName seam
- `e5db010` — SOUL.md name fallback + agent avatar plumbing
- `bf7d0e4` — proxy shape-gate declaration for the new keys
- `c48f2a7` — bronze sigil extension icons + icon-only-action contract

### 1. The `c/|\ds>` glyph and the menu

One button in the composer, next to capture: `c/|\ds` — CMDS with a
slash moustache (brackets dropped; the M carries the joke alone). Tap
opens a popover menu of 8 verbs, each with a hint. No parser anywhere:
**fire** verbs (`status, retry, undo, new, reset`) send instantly
through the normal turn path and appear in the transcript as typed;
**fill** verbs (`handoff, queue, title`) drop `/handoff ` etc. into the
composer and hand over the keyboard. Omitted verbs and their reasons
are written in the code comments (see 004 shortlist).

Refinements from live screenshots: dead capture button hidden (still
declared-disabled for the contract test); Stop is icon-only `×`, same
square footprint, dimmed red — no panic-brake energy, screen-reader
name and interrupt behavior untouched.

### 2. White-label seam: name and face ride `session.ready`

Resolution order for the masthead name: `RESONANT_AGENT_NAME` env, then
the `You are <Name>` line of `~/.hermes/SOUL.md` (where soul authors
put it — proven against the live soul file: yields `Ara` with no env
set), then the panel default. ACP exposes only the programmatic
`hermes-agent`, and no config key holds a pet name, so the soul is the
source by design — shippers who wrote a soul get their name for free.

Avatar: `RESOANT_AGENT_AVATAR` file, capped at 512 KB, `image/*` only,
inlined as a data URL on `session.ready`. No canonical avatar slot
exists anywhere, so the user-scoped host is the only honest carrier.
The letter sigil stays until a real face arrives.

Live receipt (cold launcher, 2026-09-23): `session.ready` carried
`displayName: "Ara"` and exactly **147,442 avatar chars** — the
256 px (110,565 B) runtime copy of `Ara-Voss-48.png`
(1284×1275), Tom's photorealistic Ara portrait, to the digit.
Originals untouched on disk; earlier bronze-bust avatar retired.

### 3. The shape gate caught the seam (fixed, not gutted)

`e5db010` broke 2 `bootstrap-host` reaping tests: `session.ready`
timed out. Root cause: `bootstrap/native-proxy.js conversationEvent`
declares `session.ready` as `['threadId']` and nothing else, so the new
keys were rejected as `Invalid child event` and readiness never crossed
the proxy. The dev launcher bypasses the proxy, which is why live
worked while the suite failed. Fix (`bf7d0e4`): both keys declared as
optional strings on `session.ready`; the gate still rejects everything
else. The caution caught a real contract violation — the keys were,
formally, smuggled bytes until declared.

### 4. Bronze sigil extension icons

Tom's bronze N-collared medallion (950×950) ships as
`extension/icons/sigil-{16,32,48,128}.png` (sips-resized), wired as
`action.default_icon` and top-level `icons`. The gray toolbar **R**
retires. Manifest contract evolved honestly: the permission test now
asserts the action carries *only* `default_icon` (no popup/badge) and
that every icon path exists on disk. Permissions unchanged
(`nativeMessaging, sidePanel, storage`; no host permissions).

Design note filed: bronze wins the 16 px toolbar (round metallic seal
stays legible on dark chrome); the flat b&w character mark is the
better lineage piece for large surfaces (README, installer,
empty-state). The N-collar is the Nous nod in both — the bronze reads
as a coin *honoring* the house.

### 5. Live-copy receipts (2026-09-23, verified by hash + cold launch)

Branch → installed copies, all MATCH (`shasum -a 256`, 12-hex):

- `sidepanel.html` `8af550869504`, `sidepanel.css` `4f25c3e99f8d`,
  `sidepanel.js` `3564351520bf`, `manifest.json` `51c8cac0b988`
- `icons/sigil-{16,32,48,128}` live (`1f1029ba…`, `c4e96227…`,
  `c0af93e6…`, `6a7fd124…`)
- Launcher: workspace → worktree, `RESONANT_AGENT_NAME='Ara'`,
  `RESOANT_AGENT_AVATAR` → `agent-avatar-ara-256.png`

Activation notes: manifest change needs a real extension reload at
`chrome://extensions` (panel reopen is not enough); the face/name apply
on next panel connect.

Full `npm test`: **1482/1482 pass** on `c48f2a7` (~5 min).
