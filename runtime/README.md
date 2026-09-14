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
afterward. Pins and versions reside on the same filesystem. A permanent
owner-only single-link `.store-lock.json` inode carries a kernel `flock` lease;
its historical JSON contents are inert. The file is never unlinked or renamed.
Node keeps the locked descriptor for the entire operation, and the kernel
releases it on descriptor close or process crash. Concurrent starters cannot
reclaim or replace each other's lock.
Stale temporary files are retained and never treated as versions or authority.

This macOS implementation acquires `flock` through a short-lived fixed
`/usr/bin/perl -MFcntl=:flock -e <trusted source>` helper, then retains the shared
open-file description in the Node parent after the helper exits. No shell,
package install, candidate source, or ambient environment is involved. The
interpreter must be a concrete root-owned executable, version 5.34.1, with
SHA-256 `85e5621137742a37be052f58800372b2005f91f609ad55019832214b5d9e61bc`.
Identity is checked before and after invocation; exact fixed output and exit
status are checked. Missing/mismatched interpreter, invalid file custody, or
15-second acquisition timeout fails closed. An OS update changing the pinned
Perl binary requires a separate trusted-bootstrap update. Other platforms are
unsupported by this lock implementation.

`activate` returns `pending-verification`. Only that store instance can resolve
the pending host for the trusted coordinator's live verification.
`completeActivation` records mechanical completion after the coordinator's
checks; it does not manufacture an activated receipt. When attached to a live
bootstrap, a guard prevents completion before a trusted in-place refresh has
reaped the old proxy group, started the exact pending bundle, and received its
framed session readiness. Standalone store mechanics remain available for
initial offline provisioning. Restart before completion
requires `recover`, which restores the prior active pin (including null on an
interrupted initial install). All journal phases recover by rollback.
`rollback` requires matching failed review/digest and a bounded receipt ID.
It verifies the previous bundle independently and preserves failed-candidate
bytes even if those bytes are corrupt. A corrupt previous version prevents
restoration and leaves the journal intact.
Failure and candidate identities remain in the journal; later transactions
archive prior journals under `history/`. Nothing here deletes versions, prior
state, failure receipts, or decision records.

The stable bootstrap imports trusted protocol modules outside version bundles.
`runBootstrap` receives a future coordinator and concrete Node, Codex, workspace,
and optional home paths. It uses fixed lifecycle requests and framed stdio for
existing conversation messages. Its trusted `refreshPending(decision)` method
preserves the Chrome connection and pending transaction, resumes only the
known session (never starts a turn), and returns digest, review ID, host path,
PID and PGID for post-refresh evidence. The coordinator then calls
`completeActivation`. No raw browser message can invoke refresh. Disconnect,
readiness failure, or cancellation stops the group and recovers the prior pin;
new bootstrap instances still perform startup recovery.
Its active child leads a process group; normal
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
