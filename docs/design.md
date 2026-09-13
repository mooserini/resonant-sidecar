# Resonant Sidecar: Zero-Tool Conversation Design

## Purpose

Build the smallest local Chrome Dev side panel that can start or resume one Codex CLI thread, send exact user text, stream assistant text, and interrupt an active turn. The first proof is three conversational turns with no tool calls.

## Trust boundary

```text
Chrome Dev side panel
  -> Chrome Native Messaging port
  -> local native host process
  -> `codex app-server` over stdio JSONL
  -> OpenAI account already authenticated by Codex CLI
```

No TCP listener is created. Chrome launches the native host and communicates through framed stdin/stdout. The native host launches `codex app-server`, whose default transport is stdio. The host manifest permits exactly one unpacked extension origin.

## V1 capabilities

- Open from the Chrome extension action.
- Establish a local native-messaging connection only while the side panel is open.
- Start a Codex thread on the first submitted message.
- Store only the Codex thread identifier in `chrome.storage.session` so a side-panel reload during the same browser run can resume it.
- Send user text unchanged, including leading slash characters.
- Stream commentary and final-answer text into one chronological transcript.
- Interrupt the active Codex turn with a conspicuous Stop button.
- Show connection, turn, interruption, and error states as text as well as color.

## Explicitly excluded from V1

- CDP attachment or page inspection.
- Tool approvals, command execution, file modification, or browser automation.
- Cookie, cache, history, tab-content, URL, credential, or clipboard access.
- A TCP, WebSocket, HTTP, SSH, or externally reachable listener.
- Persistent transcript storage, telemetry, analytics, or remote assets.
- Sidecar-defined slash commands.
- Multi-agent routing.

## Message contracts

Chrome-to-host messages:

```json
{ "type": "session.open", "threadId": null }
{ "type": "turn.start", "text": "Exact human text" }
{ "type": "turn.interrupt" }
```

Host-to-Chrome messages:

```json
{ "type": "session.ready", "threadId": "..." }
{ "type": "turn.started", "turnId": "..." }
{ "type": "assistant.delta", "text": "...", "phase": "unknown" }
{ "type": "turn.completed", "status": "completed" }
{ "type": "error", "message": "Safe diagnostic text" }
```

The wrapper validates message shape and size. It does not interpret text. Native-protocol debug output goes to stderr only because stdout is reserved for Chrome frames.

## Session behavior

The native host initializes app-server, then starts a new thread or resumes the thread identifier supplied by the extension. A turn uses a text input item exactly as submitted. V1 starts threads with a read-only sandbox and approval policy `never`; the test prompt additionally instructs Codex not to use tools. Tool and approval events are surfaced as an error and never approved.

The Stop button sends `turn/interrupt` for the currently active thread and turn. The UI stays stopped until app-server reports the turn as interrupted or the native connection closes.

## Acceptance test

Using the unpacked extension in the on-device Chrome Dev Agent profile:

1. Submit a nonce and ask Codex to repeat it without tools.
2. Ask Codex to recall the same nonce.
3. Ask Codex to combine it with a second nonce.
4. Confirm all replies arrive in order, the same thread identifier is retained, and no tool or approval event occurred.
5. Reload the side panel and confirm the stored session identifier resumes for one further recall turn.

This demonstrates conversational continuity. It does not yet demonstrate page access, CDP control, or safe approval rendering.
