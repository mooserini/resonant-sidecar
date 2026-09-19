# Fort Knox runtime lock v1

Status: retired from active imports; preserved as historical evidence.

## Provenance

The v1 runtime lock entered the repository in commit
`5749c5c6927c92e5e4a47cff24e8665ebae8b2c2` (`fix: preserve activation
binding and recovery`). The exact implementation at modernization base commit
`1160898` is preserved under `archive/fort-knox-runtime-lock-v1/runtime-lock.js`.
Its Git blob is `264842bdada572342a43107471e755e55b587591`, and the archived file's
SHA-256 is `31302beb77dd81908a9873cb00f9e3ff07b1167f6524914c5cde6af190486a12`.
The archive was verified byte-for-byte against Git history.

## What v1 protected

V1 was intentionally conservative. It combined four concerns in one active
module:

1. a permanent, owner-only lock inode checked for symlink, ownership, mode,
   link-count, inode, and device changes;
2. a kernel `flock` acquired through macOS system Perl and retained through the
   parent's shared open-file description;
3. bounded helper execution with a stripped environment, fixed output, empty
   stderr, and a timeout;
4. exact helper identity through path, ownership, permissions, executable bit,
   Perl version, and one frozen SHA-256 digest.

The permanent inode and kernel-lock design fixed real split-lock and crash
recovery hazards. Those custody guarantees remain current requirements.

## Why the active design changed

A routine macOS update replaced `/usr/bin/perl` with different bytes while
preserving its immutable system path, safe ownership and permissions, compatible
`Fcntl::flock` behavior, valid Apple signature, and designated identity
`com.apple.perl`. The exact-byte gate therefore rejected a legitimate compatible
platform update and transitively broke ordinary application tests.

That was not a sloppy lock. It was overengineering at its finest: the design
proved more than the product needed, then treated ordinary vendor maintenance as
an authority violation.

V2 separates the concerns:

- `runtime-lock-core.js` owns lock-file custody and the bounded kernel-lock
  protocol;
- `runtime-lock.js` owns the production macOS identity policy;
- ordinary tests inject a real kernel-backed provider without the host-specific
  Apple identity gate;
- the platform lane verifies the production provider on supported macOS;
- release verification requires both lanes.

Production identity now fails closed unless `/usr/bin/perl` remains a safe,
root-owned, non-symlinked executable and `codesign` verifies the Apple anchor and
identifier `com.apple.perl`. Compatibility is proven by the bounded `flock`
protocol rather than by a frozen Perl version or byte hash. Routine compatible
Apple updates can therefore continue without weakening lock custody.

## Historical boundary

The archive is intentionally absent from active imports, the trusted bootstrap
control-plane inventory, and all routine test paths. It must never become a
fallback implementation. Git history remains the authoritative source record;
the archive exists to make the retired rationale reviewable without reviving it.
