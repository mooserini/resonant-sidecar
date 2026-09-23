# Resonant Sidecar

> [!IMPORTANT]
> **Repository role: canonical active product.** Resonant Sidecar owns the
> user-facing local agent workbench, product behavior, installation, releases,
> and roadmap. **Hermes Browser Interop Lab** is its companion testing and
> research repository: it hosts narrow page-scoped fixtures, browser-channel
> compatibility experiments, and the preserved design history. The lab is not
> a second product implementation.

Experimental local prototype. MIT licensed. Not affiliated with OpenAI, Google,
or any agent vendor.

Resonant Sidecar is a local Chrome Dev side panel for one durable Hermes
conversation. Text enters the panel, crosses Chrome Native Messaging, and
reaches `hermes acp` over stdio. Assistant text returns over the same path.
The production panel is intentionally Hermes-only: it has no agent selector.

Legacy Grok and Codex transport adapters and tests remain in the repository as
compatibility evidence, not as choices in the current product surface. MCP is
for tools, not this chat path.

What stays tight is what leaves the machine: native messaging and agent stdio
are local. Only the spawned agent’s own vendor cloud is contacted. The sealed
bundle inventory is for published V2 review bytes, not for blocking a local
backend swap.

## V1 boundary

- No TCP, WebSocket, SSH, or localhost listener.
- No `tabs`, page-content, cookie, history, clipboard, or host permission.
- No saved transcript. Session storage holds only the Hermes thread id.
- No sidecar slash-command parser. A leading `/` is ordinary message text.
- Tool permission requests from Hermes are cancelled.
- The Stop button maps only to interrupt for the active turn.

This prototype proves conversational transport and continuity. It does not yet implement the planned single-use bootstrap secret, CDP enable switch, per-capability approval UI, cache cleaning, or a process-level kill switch. Stop is not an operating-system kill control.

## Architecture

```text
Chrome Dev MV3 side panel  (Hermes)
  ↕ Chrome Native Messaging frames
user-scoped Node native host
  ↕ ACP stdio
hermes acp
```

Chrome launches the native host only when the side panel connects. Closing the
panel disconnects the native port and closes that host process. The Hermes
thread id is stored in session storage and is resumed on the next connect —
proven September 2026: Hermes sessions outlive the pipe, `session/resume`
succeeds across dead processes, and the panel reconnects on show after failure
(see `docs/browser-session-continuity.md` §5 and Cross-door continuity).

## Active work (September 2026)

Branch `fix/reconnect-honest-plumbing` (this branch until merged):

- Honest `Unavailable` status on sidecar errors instead of a stuck `Connecting`.
- Auto-reconnect when the panel becomes visible again after a failure.
- Completed Hermes resume handshake: resume replies carry no `sessionId`, so the requested id stands; replayed history chunks with no live turn are swallowed, never painted.
- Verified live end to end: panel message → full Chrome Dev quit → reopen resumes the same session; `/handoff` carries the session panel → desktop → Discord with verbatim recall.
- Full `npm test`: 1482/1482 pass. Trying-loop spikes 001–003 recorded in `docs/spikes/`.

## Test locally

Requirements: macOS, Chrome Dev, Node.js 22 or newer, and authenticated Hermes
(`hermes acp --check`).

```sh
npm run check
npm run check:runtime-lock
npm run check:release
```

`npm run check` is the ordinary application gate and uses a real kernel-backed
test lock without host-specific Apple identity verification.
`npm run check:runtime-lock` verifies the production macOS lock provider.
`npm run check:release` is the release gate and requires both lanes.

The separate `npm run smoke:real` command is a legacy compatibility smoke test
for the Codex app-server adapter and requires an authenticated Codex CLI. It
does not test the Hermes-only production surface. It prints thread/turn IDs and
SHA-256 reply receipts rather than a transcript.

## Historical sealed V2 preparation — not the current roadmap

> [!NOTE]
> The current product direction is the capability-first browser relationship in
> [Browser Session Continuity](docs/browser-session-continuity.md), with
> [Context Canvas](sketches/README.md) as the selected interface shell. The
> sealed V2 migration machinery below remains preserved and testable, but it is
> not the next operator action and must not be run unless that path is explicitly
> revived after the first Hermes-only, read-only product slice is assessed.

Keep the working V1 attachment and registration intact. This checkout now
contains the V2 Chrome semantic-review control plane; do not load its changed
`extension/` directory into Chrome as if it were the historical V1 attachment.
Preview the plan using the already-observed extension ID without changing files:

   ```sh
   node scripts/install-macos.js --extension-id EXTENSION_ID
   ```

The Chrome-review Task 10 mocked gate and Task 11 inert capability check do not
authorize installation. The superseded migration proposal remains preserved in
`docs/superpowers/plans/2026-09-15-v1-to-v2-migration.md`; it is historical
engineering evidence, not current authorization. The old Task 12 candidate
Review-and-Refresh is likewise not on the active roadmap.

The current installer is now migration-oriented. With only `--extension-id`, it
performs a read-only inspection of committed `HEAD` and the current V1 launcher
and manifest, then prints exact paths, SHA-256 digests, file modes, the one
allowed origin, and the proposed install hash. It does not write staging data,
registration, receipts, or runtime state.

A preparation transaction requires the complete explicit approval tuple from the
reviewed plan:

```sh
node scripts/install-macos.js \
  --migrate \
  --extension-id EXTENSION_ID \
  --expected-current-hash REVIEWED_CURRENT_SHA256 \
  --reviewed-install-hash REVIEWED_INSTALL_SHA256
```

Do not run that command without approval of that exact plan. The preparation pins the
complete bundle in the project-local version store, installs a separate
closed trusted-bootstrap graph, creates a stable unpacked-extension directory,
creates an owner-only Codex review home, seeds a self-consistent active pin,
recovery state, and installation witness, and preserves the old launcher and
manifest read-only. Review policy, receipt validation, and runtime wiring select
V2 explicitly; bundle manifests remain the existing format `schemaVersion: 1`.
The exact frozen control inventory is 50 source files: 39 trusted-bootstrap,
8 stable-extension, and 3 installer files. The bootstrap also seals its generated
`package.json` and `runtime-entry.js`. The plan binds the policy, Chrome schema,
adapter, and one shared digest for the byte-identical Node/browser Chrome
contracts. Ordinary conversation candidates may include control files only when
they are identical to active; changing any control family requires a separate
control-plane migration.

The generated runtime constructs one canonical semantic evidence packet through
the pinned coordinator and supplies it to Chrome and isolated Codex review. It
binds the Chrome bridge/journal and records provider-specific provenance;
unavailable browser version/signing fields and an unobserved component are
reported honestly, not inferred. Building the plan does not prepare or invoke a
model, download a component, change browser flags, or contact a local endpoint.

Immediately before its first write, the installer rebuilds
the plan from clean committed `HEAD`, re-inspects the concrete non-symlink Codex
executable and current registration, and requires the regenerated install hash
to equal `REVIEWED_INSTALL_SHA256`. It does **not** change
the live Chrome Dev native-host registration. An unpacked extension loaded from
a new path is not assumed to retain its ID: a later approved live checkpoint must load the stable path,
record the ID Chrome Dev actually displays, and stop unless it exactly matches
the reviewed expected ID. Only a later, separately reviewed registration step
may point Chrome Dev at the pinned bootstrap. Nothing targets Chrome Stable or
adds a listener, capability, or Chrome permission.

The bundle builder performs a declaration/capability comparison against the
canonical policy; it does not claim to have compared live behavior. Its lexical
gate closes the declared trusted import graph to pinned relative files and
explicit, runtime-recognized `node:` built-ins. It also rejects non-literal
dynamic imports and recognized literal, escaped-identifier, and statically
foldable computed-property forms of ambient loaders or string-code generators
such as `require`, `createRequire`, `eval`, and the `Function` family.
Arbitrary JavaScript equivalence remains outside this detector's guarantee;
the exact committed trusted-bootstrap bytes are the trust root. The pinned
`review/trusted-harness.js` deliberately uses Node's VM module API with its
own fixed linker and disabled string/Wasm generation. The trusted bootstrap
remains reviewed trusted code, not a general JavaScript sandbox; the lexical
gate is one input to exact-hash human approval, not a claim that arbitrary
semantic code generation is impossible.

After an approved preparation, verify the sealed on-disk migration chain against
the exact reviewed plan before opening Chrome Dev:

```sh
node scripts/verify-install-plan.js --stored-chain /tmp/resonant-sidecar-migration-plan.json
```

This command is read-only. It verifies the fixed receipt inventory, canonical
bytes, sidecars, modes, current-user ownership, file custody, predecessor chain,
and exact install-plan binding, then repeats the complete inventory and identity
snapshot at its final boundary. Any failure is a hard stop; keep the reviewed
plan and `runtime/migration-receipts/CURRENT_HASH/` for collaborative diagnosis.

See [docs/migration-runbook.md](docs/migration-runbook.md) for the exact human
boundary, recovery procedure, process tree, and receipt locations.

The native-host manifest authorizes exactly `chrome-extension://EXTENSION_ID/`.
See Chrome's [Native Messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
the [Agent Client Protocol](https://agentclientprotocol.com/), and OpenAI's
[Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

## Development

The project has no runtime package dependencies. Unit and process-level tests use Node's built-in test runner.

```sh
npm test
npm run check
npm run check:release
```

Generated runtime, migration receipts, and Chrome registration stay on the
operator machine. They are not part of this repository.

## Related public lab

The consent-gated Chrome experiment that started this work is
**Hermes Browser Interop Lab**. That companion repository is a page-scoped,
read-only harness (`activeTab` + `scripting`, no host permissions), browser
compatibility laboratory, and historical ledger. Resonant Sidecar is the
canonical product and the **conversational** seat from the lab's trust model:
the agent is present beside the page with **no page access**. It is not a merge
of the two projects and does not inherit the lab's `activeTab` / `scripting`
permissions.
