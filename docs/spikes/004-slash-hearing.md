# Spike 004 — ACP hears slash (2026-09-23, ~03:30–04:00 EDT)

**Question.** Before building any panel button bar: does `hermes acp`
execute slash commands sent as ordinary turn text, or does it need a
sidecar-side parser? (V1 boundary says no parser — a leading `/` is
ordinary message text. So the agent must do the hearing.)

**Method.** Throwaway ACP drivers in
`~/.hermes/cache/scratch/sidecar-004/`
(`slash-probe.mjs`, `handoff-probe.mjs`, `batch-probe.mjs`,
`name-probe.mjs`, `list-probe.mjs`). One throwaway session per probe,
nine slash verbs total, all as bare turn text. Nothing committed to the
repo except this record.

## Result: VALIDATED — the agent hears slash

| Verb | Verdict | Note |
|---|---|---|
| `/status` | ✅ Executed | Full live readout: macOS, Hermes v0.21.4, 170 sessions / 43,754 messages, gateway PIDs, Nous key expiry ~40 min |
| `/handoff` (bare) | ✅ Executed | Usage + named doors, **including `/handoff sidecar`** — the panel is a first-class door |
| `/new`, `/reset` | ✅ Executed | Fresh session honestly reported "history cleared" |
| `/retry`, `/undo` | ✅ Heard, correctly no-op'd | Fresh session, nothing to redo — correct no-op, not confusion |
| `/queue` | ✅ Executed | "Queued. (1 queued)" |
| `/title` | ✅ Heard, needs input | Requires a name argument — a button must fill, not fire |
| `/save` | ❌ Not a primitive | Correctly declined; offered export / memory / Spine instead |
| `/steer` | ⚠️ Unclear | Never cleanly executed in the probe (see guard note) |
| `/voice` | ⚠️ Half-heard | Refused as "CLI-internal", then read live voice config back flawlessly (see voice law) |

Supporting facts: one-shot flags `hermes -z/--resume/--continue`
exist (fallback path if ACP ever fails); bare `/handoff` replies with
the live session id plus an anchor offer; every probe turn registered a
conversation in the desktop app's conversation list (audit ledger).

## Finding 1: the injection guard sees ghosts (flagged, not buried)

The `/steer` and `/queue` replies narrate rejecting a smuggled memory
block that **was never sent** — probe text was bare. The guard
confabulated on clean input. Queue still executed; steer never visibly
did. Buttons for these two wait until the guard stops hallucinating
attackers.

## Finding 2: voice law (settled)

**Hermes plays; Chrome never touches.** Voice must NOT be piped through
Chrome — it sources from desktop, CLI, or gateway, anywhere audio can
play, so the agent works from any machine. The `/voice` probe confirmed
the config spine is set in stone: xAI STT/TTS live, Edge fallback
present, TTS voice literally named `ara`. The panel stays silent by
design. `/voice` as a panel button is therefore OUT — mode toggles live
in Hermes-owned surfaces.

## Finding 3: `session/list` exists (dropdown unblocked)

`session/list` over ACP returns live sessions with `sessionId`, `title`,
`cwd`, `updatedAt` — observed live, including session
`e4387c25-…` titled "Check conversational transport status".
(`session/sessions` and `list_sessions` return `Method not found` —
only `session/list` is real.) The deferred "last five sessions" picker
now has its primitive. Not built in this spike; buttons first.

## Button-bar shortlist resulting from this spike

IN: handoff, status, retry, undo, new, reset (+ queue, title as
fill-not-fire). OUT: save (doesn't exist), steer (guard), voice
(Hermes plays), approve/deny (no dangerous flow in a webpage),
restart/update (gateway surgery), model/reasoning/personality (later),
sethome/thread (gateway-native). Stop stays panel-native interrupt and
must never share a label with the CLI killer `stop`.
