# Resonant Sidecar

Resonant Sidecar is a local Chrome Dev side panel for one durable Codex CLI conversation. It is an intentionally narrow prototype: text enters the panel, crosses Chrome Native Messaging, and reaches `codex app-server` over stdio. Assistant text returns over the same path.

## V1 boundary

- No TCP, WebSocket, SSH, or localhost listener.
- No `tabs`, page-content, cookie, history, clipboard, or host permission.
- No saved transcript. The extension stores only the Codex thread ID in `chrome.storage.session`.
- No sidecar slash-command parser. A leading `/` is ordinary message text.
- Codex starts read-only with approval policy `never` and explicit zero-tool test instructions.
- Any observed tool item or approval request fails the smoke test; approval requests are declined.
- The Stop button maps only to `turn/interrupt` for the active turn.

This prototype proves conversational transport and continuity. It does not yet implement the planned single-use bootstrap secret, CDP enable switch, per-capability approval UI, cache cleaning, or a process-level kill switch. The Stop button interrupts a Codex turn; it is not yet an operating-system kill control.

## Architecture

```text
Chrome Dev MV3 side panel
  ↕ Chrome Native Messaging frames
user-scoped Node native host
  ↕ JSONL over child-process stdio
codex app-server
```

Chrome launches the native host only when the side panel connects. Closing the panel disconnects the native port and closes that host process. The Codex thread itself is durable and can be resumed by its ID.

## Test locally

Requirements: macOS, Chrome Dev, Node.js 22 or newer, and an authenticated Codex CLI.

```sh
npm run check
npm run smoke:real
```

The deterministic real smoke test starts one native host, creates a Codex thread, completes a turn, stops the host, starts a second host, resumes the same thread, and completes two context-dependent turns. It prints thread/turn IDs and SHA-256 reply receipts rather than a transcript.

## Current V1 attachment

1. Open `chrome://extensions` in the intended local Chrome Dev profile.
2. Enable Developer mode and choose **Load unpacked**.
3. Select the absolute `extension/` directory in this checkout.
4. Copy the 32-character extension ID Chrome displays.
5. Preview the original V1 native-host registration without changing files:

   ```sh
   node scripts/install-macos.js --extension-id EXTENSION_ID
   ```

6. Do not run a migration command yet. The original V1 stays attached until the
   Task 12 human checkpoint shows the exact plan and Tom approves that exact
   plan.

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

Do not run that command before the Task 12 checkpoint. The preparation pins the
complete V1 payload in the project-local version store, installs a separate
closed trusted-bootstrap graph, creates a stable unpacked-extension directory,
creates an owner-only Codex review home, seeds a self-consistent active pin,
recovery state, and installation witness, and preserves the old launcher and
manifest read-only. Immediately before its first write, the installer rebuilds
the plan from clean committed `HEAD`, re-inspects the concrete non-symlink Codex
executable and current registration, and requires the regenerated install hash
to equal `REVIEWED_INSTALL_SHA256`. It does **not** change
the live Chrome Dev native-host registration. An unpacked extension loaded from
a new path is not assumed to retain its ID: Task 12 must load the stable path,
record the ID Chrome Dev actually displays, and stop unless it exactly matches
the reviewed expected ID. Only a later, separately reviewed registration step
may point Chrome Dev at the pinned bootstrap. Nothing targets Chrome Stable or
adds a listener, capability, or Chrome permission.

The bundle builder performs a declaration/capability comparison against the
canonical policy; it does not claim to have compared live behavior. Its lexical
gate closes the declared trusted import graph to pinned relative files and
explicit, runtime-recognized `node:` built-ins. It also rejects non-literal
dynamic imports and executable uses of ambient loaders or string-code
generators such as `require`, `createRequire`, `eval`, and the `Function`
family. The pinned `review/trusted-harness.js` deliberately uses Node's VM
module API with its own fixed linker and disabled string/Wasm generation. The
trusted bootstrap remains reviewed trusted code, not a general JavaScript
sandbox; the lexical gate is one input to exact-hash human approval, not a
claim that arbitrary semantic code generation is impossible.

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

The native-host manifest authorizes exactly `chrome-extension://EXTENSION_ID/`. See Chrome's [Native Messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) and OpenAI's [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) for the underlying protocols.

## Development

The project has no runtime package dependencies. Unit and process-level tests use Node's built-in test runner.

```sh
npm test
npm run check
```

This checkout is local-only. It has no configured Git remote and is not approved for publication.
