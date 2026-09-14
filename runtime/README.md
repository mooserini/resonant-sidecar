# Local runtime custody

Generated contents are ignored. This README is the only tracked runtime file.
Tests use disposable project roots; this task does not register or activate a
Chrome native host or change the installed extension.

`versions/<digest>/` holds `bundle/` and its canonical `manifest.json`. Source
modes belong to the bundle identity; installed files are sealed 0400 inside
0500 directories. Quarantine is never executed. `active/pin.json` and
`previous/pin.json` are canonical JSON pins, not symlinks. No pointer accepts a
path supplied by the browser or candidate. A null pin means no active version.

The trusted coordinator supplies `consumeDecision(decision)`. It must consume
the single-use human response and return exactly the decision plus
`consumed: true`, or reject. The store checks review ID, digest, policy digest,
action, and nonce; it also persists used nonce hashes and binds each installed
review ID to its digest in `installations/`. This interface does not
create human consent. Install only stages sealed bytes into the version store.

Activation journals the prior active and prior previous pins before switching
either pin. Every file is fsynced before rename; the parent directory is fsynced
afterward. Pins and versions reside on the same filesystem. The process lock
fails closed while its owner lives; a dead owner's lock can be reclaimed.
Stale temporary files are retained and never treated as versions or authority.

`activate` returns `pending-verification`. Only that store instance can resolve
the pending host for the trusted coordinator's live verification.
`completeActivation` records mechanical completion after the coordinator's
checks; it does not manufacture an activated receipt. Restart before completion
requires `recover`, which restores the prior active pin (including null on an
interrupted initial install). All journal phases recover by rollback.
`rollback` requires matching failed review/digest and a bounded receipt ID.
Failure and candidate identities remain in the journal; later transactions
archive prior journals under `history/`. Nothing here deletes versions, prior
state, failure receipts, or decision records.

The stable bootstrap imports trusted protocol modules outside version bundles.
`runBootstrap` receives a future coordinator and concrete Node, Codex, workspace,
and optional home paths. It uses fixed lifecycle requests and framed stdio for
existing conversation messages. Its active child leads a process group; normal
Codex descendants inherit that group. Disconnect/signals terminate and then
kill the group, including descendants that outlive its leader. There is no
listener, shell launcher, inherited environment, or candidate-selected command.
Frames and queues are bounded; child stderr is discarded with a fixed bound.
Direct bootstrap invocation emits a framed configuration failure until the
later migration task provides a trusted launcher.

These checks enforce application custody, not isolation against the machine
owner rewriting the trusted bootstrap or racing its filesystem with same-uid
authority. Node filesystem APIs do not provide an openat-based directory
capability boundary. Separate runtime OS evidence checks remain required.
