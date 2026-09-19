# Fort Knox runtime lock v1 — historical snapshot

This directory is an inert, byte-for-byte archive of `bootstrap/runtime-lock.js`
as it existed at source commit `1160898`.

- Source-introducing commit: `5749c5c6927c92e5e4a47cff24e8665ebae8b2c2`
- Git blob: `264842bdada572342a43107471e755e55b587591`
- Archived-file SHA-256: `31302beb77dd81908a9873cb00f9e3ff07b1167f6524914c5cde6af190486a12`
- Byte-for-byte equality was verified with `cmp` against `git show 1160898:bootstrap/runtime-lock.js`.

The snapshot is evidence, not an active implementation. It is deliberately outside
the trusted bootstrap import graph and must not be imported, bundled, or used as
a fallback. See `docs/history/fort-knox-runtime-lock-v1.md` for the design and
retirement decision.
