# Spike 001 — Hermes direct talk (VALIDATED, Sept 2026)

Question: given `hermes acp --check OK`, when the repo `native-host/host.js`
is driven directly (no Chrome) with `session.open {agent: hermes}` plus
`turn.start`, then assistant text streams back with no tools.

Method: throwaway driver speaking Chrome Native Messaging framing straight
to `native-host/host.js`. No repo files touched.

Result: `session.ready` with a real thread id, `turn.started`, deltas
spelling the requested nonce, `turn.completed`. Zero tool turns. End to end
~27s against the local model behind the wheel — transport is model-agnostic.

Standing value: this direct-drive shape is the trying-loop. Skip the
43-file suite; drive `host.js`, watch events.
