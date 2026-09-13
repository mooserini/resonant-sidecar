# Zero-Tool Continuity Receipt

Date: 2026-09-13  
Host: Uncle-Russet.local  
Browser: Google Chrome Dev 155.0.8048.0, local `Agent` profile  
Scope: native transport proof and visible Chrome side-panel continuity

## Result

PASS — genuine Chrome Native Messaging frames crossed the local native-host process into a real authenticated Codex app-server session. The deterministic process harness resumed one durable thread across two host processes. The unpacked Chrome Dev side panel then completed three visible turns, including exact recall after the panel was closed, the native host exited, and the panel was reopened.

- Codex thread: `01a09cdc-fa36-7bf0-9f2c-67c2256f3545`
- Native-host processes: 2
- Same thread after restart: yes
- Completed turns: 3
- Observed tool or approval events: 0
- Network listener used by the sidecar: none
- Chrome extension ID: `algfplhdbapdaoimggafkgmpmnadfppl`
- Native-host allowed origin: `chrome-extension://algfplhdbapdaoimggafkgmpmnadfppl/`

| Turn | Codex turn ID | Status | Reply SHA-256 |
| --- | --- | --- | --- |
| 1 | `01a09cdc-faa5-7eb1-ad45-df5fe4bd289e` | completed | `1afc73e07986a0444e7c0c6597933b433f4ecd86863ae4754be1cbadbdbc4a53` |
| 2 | `01a09cdd-0e50-7911-a1e7-3efe9977f0b8` | completed | `1b49c0b89c8d721fe66a9a80fc221aa40f155d53889e3743547b42320963eec8` |
| 3 | `01a09cdd-270e-7ad1-81c8-9a0f99f6b38e` | completed | `f62ffe4e0f54d8bb560a603cb403a1391689ff66f8966e42e2608b083f5868bd` |

## Visible Chrome Dev run

The panel was opened from the extension action and reported `Ready — Local Codex session ready.` The run used a disposable test token; only reply hashes are retained here.

| Turn | Check | Visible result | Reply SHA-256 |
| --- | --- | --- | --- |
| 1 | Store exact test token | `stored` | `87b04e58961f9a99d853d4046a0b5b793e7c3e4bbd21f5aca8fb17c20cdb1d8b` |
| — | Close side panel | Native-host process exited | — |
| — | Reopen side panel | Fresh native host reported ready; transcript was blank by design | — |
| 2 | Recall exact test token | exact match | `6f06a9795e2d684294e7003a0abcf07ab38ebdda25e561f652ac301c192eacde` |
| 3 | Reverse the remembered token | exact transformation | `55e26a766ad4280264c03e999a3231a9a281508131f4ab9e98fa8a05ffb299d2` |

While the panel was open, the observed process chain was:

```text
Chrome Dev
  -> native-host/host.js
     -> codex app-server
```

`lsof -nP -iTCP -sTCP:LISTEN` showed no matching sidecar, native-host, or Codex listener. The user-scoped native manifest was inspected after installation: mode `0600`, launcher mode `0700`, transport `stdio`, and exactly one allowed extension origin.

Chrome Dev's macOS directory chooser required a human long-press gesture before it accepted the unpacked-extension directory. That deliberate installation boundary was satisfied by the user; subsequent attachment and testing were automated.

Command:

```sh
npm run smoke:real
```

Transport under test:

```text
Chrome-compatible length-prefixed JSON frames
  -> native-host/host.js
  -> codex app-server JSONL over stdio
```

## Boundary

The smoke test fails if it observes a non-conversational item or any approval request. That is a test invariant, not a general hard guarantee that a future Codex model can never begin a read-only tool operation before the client observes its event. V1 is deliberately a conversation-continuity prototype, not the completed capability-control system.
