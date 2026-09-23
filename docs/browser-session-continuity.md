# Browser Session Continuity

## Decision

Resonant Sidecar treats the browser session—not the current webpage—as the durable relationship.

Once the human connects a named browser lane, ordinary navigation and tab switching must not require another human connection handshake. Sidecar preserves the conversation and browser-lane session, refreshes disposable page context when the active document changes, reports loss of a browser-control capability as scoped degradation, and reserves `disconnected` for loss of the Sidecar-to-agent channel.

This is a product requirement and lifecycle model. It is not evidence that every part of the flow is implemented by the current prototype.

## Why this matters

A mature browser sidecar remains present while the human browses. The panel does not disappear, reset the conversation, or ask the human to reconnect whenever a page navigates. That continuity comes from separating long-lived browser relationships from short-lived document state.

```text
Browser window
├── Side panel UI                         long-lived
├── Extension coordinator                 restartable
├── Native-host / agent transport         long-lived connection
├── Browser-control session               long-lived per lane or tab
└── Current document context              replaced on navigation
```

Navigation may destroy a document's DOM, frames, and JavaScript execution contexts. It must not implicitly destroy the Sidecar conversation, Hermes session, native-host channel, or named browser-lane connection.

## Trust ownership

Chrome owns and mediates the human's relationship with the browser. The human is already authorized to navigate, open and close tabs, change pages, and choose which browsing surface is active. Sidecar should accompany that ordinary browsing lifecycle through Chrome's supported extension surfaces rather than treating every navigation as a new trust ceremony.

Sidecar owns the relationship between its interface and the selected agent or agents. That includes:

- establishing and recovering the local agent transport;
- preserving agent and conversation identity;
- routing human messages and agent lifecycle events;
- tracking which browser lane and target are current;
- replacing page-specific context when Chrome reports a target or document change;
- reporting genuine loss of agent or browser connectivity truthfully.

These relationships must remain distinct:

```text
human ↔ Chrome/browser          browsing and target selection
human ↔ Sidecar                 companion presence and interaction
Sidecar ↔ agent                 session, transport, and event continuity
agent ↔ page capability         separately bounded observation or action
```

Following the active tab is a continuity function. It does not, by itself, grant the agent permission to read page contents, inspect cookies or history, use credentials, or act on the page. Those capabilities remain governed by the supported browser-control transport and its explicit permission and approval boundaries.

A target-change signal should carry only the identity and lifecycle information required to follow the human's browsing context. It must not silently broaden the data available to Sidecar or the agent.

The governing trust distinction is:

> Sidecar does not need to reauthorize its presence when the human changes pages, and the agent does not inherit the human's unrestricted browser authority merely because Sidecar remains present.

## Identity and lifetime model

Sidecar must keep the following identities distinct:

| Identity | Meaning | Expected lifetime |
|---|---|---|
| `browserLaneId` | Named browser route such as `chrome-stable` or `chrome-dev` | Until explicit disconnect, browser exit, or transport loss |
| `windowId` | Browser window containing the browsing surface and panel | Until the window closes or is replaced |
| `tabId` | Stable browser identity for a tab | Across ordinary top-level navigation; until close or replacement |
| `documentEpoch` | One loaded top-level document and its frame/execution-context graph | Until navigation or document replacement |

`documentEpoch` is a logical Sidecar concept; its implementation may use browser lifecycle events, CDP loader/frame identifiers, or another verified generation marker.

## Durable and disposable state

| State | Survives navigation in the same tab? | Survives switching tabs? |
|---|---:|---:|
| Sidecar conversation | Yes | Yes |
| Hermes session/thread | Yes | Yes |
| Native-host connection | Yes | Yes |
| Named browser-lane connection | Yes | Yes |
| Browser window identity | Yes | Usually |
| Selected tab identity | Yes | Changes to the newly active tab |
| DOM and frame handles | No | No; target-specific |
| JavaScript execution contexts | No | No; target-specific |
| Page snapshot and semantic cache | No | No; refresh for the active target |
| In-flight operation bound to the old document | Reconcile or stop | Reconcile, pause, or stop by explicit policy |

No object originating inside a document may be assumed valid after `documentEpoch` changes.

## Lifecycle flows

### 1. Connect a browser lane

1. The human selects or authorizes a named browser lane.
2. Sidecar establishes the local Sidecar-to-Hermes relationship.
3. Hermes establishes or discovers the supported browser-control transport for that lane.
4. Sidecar records connection state without treating a URL as the connection identity.
5. Sidecar reports the lane as ready only after the transport is verified.

Human-visible handshake scope:

```text
human approval → browser lane
```

Not:

```text
human approval → URL → every subsequent URL → every subsequent document
```

### 2. Navigate within the active tab

Example:

```text
Tab 47: example.com → wikipedia.org
```

Expected behavior:

1. The tab retains its browser identity when the browser does so.
2. The browser or control transport reports navigation/document replacement.
3. Sidecar increments or replaces `documentEpoch`.
4. Sidecar invalidates DOM, frame, execution-context, and page-snapshot state.
5. An operation bound to the old document is stopped or reconciled according to its contract.
6. Hermes refreshes page context before the next page-bound operation.
7. The panel, conversation, Hermes session, and browser-lane connection remain intact.

The user is not asked to reconnect.

### 3. Switch active tabs

Example:

```text
Active tab: 47 → 83
```

Expected behavior:

1. The browser-facing coordinator observes the active-target change.
2. Sidecar updates the selected tab identity without changing the browser lane.
3. Hermes reuses an existing target session or selects/attaches to the new target through the supported transport.
4. Sidecar obtains fresh document context for the new target.
5. The panel and conversation remain continuous.

Target selection is internal lifecycle work, not a new human handshake.

### 4. Create, close, or replace a tab

- **Create:** observe the new identity; do not select it unless the browser makes it active or the human explicitly chooses it.
- **Close:** invalidate all tab- and document-scoped state; select the browser's next active tab when available.
- **Replace:** transfer only state whose contract explicitly survives replacement. Never transfer document handles.
- **No usable target:** keep the browser lane connected and show a bounded `no active page` state rather than claiming transport failure.

### 5. Close and reopen the panel

The panel UI may be destroyed when closed. Conversation and browser continuity must therefore not depend exclusively on in-memory variables in the panel page.

On reopen:

1. reconnect to the local coordinator;
2. restore the durable Hermes session/thread identifier;
3. read the current browser-lane and active-target state;
4. reconstruct the visible lifecycle state;
5. avoid replaying completed operations as though they were new.

The current prototype closes its native-host process when the panel disconnects and resumes conversation by stored thread identifier. A future implementation may retain a longer-lived coordinator, but that change must remain explicit and reviewed.

Proven September 2026 (trying-loop spikes 001–003, no full-suite gate):

- Hermes ACP sessions **outlive the native pipe**. Killing the host process (panel close, browser quit, SIGKILL) does not kill the Hermes session.
- `session/resume` succeeds **across processes**: a fresh `hermes acp` process resumes a session created by a dead one, with history intact.
- A successful resume reply carries models and payload but **no `sessionId` field**. The grant is implicit: the requested id stands. Clients must not demand `sessionId` on the resume path.
- Resume **replays history** as `session/update` chunks with no live turn. The panel must swallow replayed chunks, never paint them as new transcript cards.
- The side-panel document can **outlive its native pipe**: hiding the panel disconnects the port without reloading the page, so no new connect is attempted on show. The panel reconnects (fresh `session.open` with the stored thread id) when visible again after a failure state, and error states report honest `Unavailable` instead of stranding the header on `Connecting`.

### 6. Genuine connection loss and capability degradation

Sidecar has more than one continuity channel. Losing one channel must not erase
healthy state owned by another. In particular, a browser-control failure may
remove page inspection or interaction while the local coordinator,
conversation, and visible failure receipt remain available.

A new connection or visible recovery flow is appropriate for the affected
channel when:

- the browser process exits;
- the native-host port is destroyed;
- the MCP or CDP transport disconnects;
- the extension or controlling component reloads;
- another debugger or browser tool takes exclusive control;
- the selected browser lane becomes unavailable or incompatible;
- the human explicitly disconnects.

Recovery is capability-scoped:

- **Valid and compatible change:** append a receipt and continue without user
  authentication.
- **Valid but materially different change:** pause only the unexplained or
  hazardous new authority lane, explain the delta, and require acknowledgment
  before enabling it.
- **Invalid, incomplete, or incompatible state:** stop only the affected
  capability, preserve unrelated healthy functions, and offer the applicable
  retry, revert, review, repair, or disconnect path.

Only loss of the local Sidecar-to-agent channel makes the conversation itself
disconnected. Sidecar must distinguish all of these events from navigation.
`Page changed` is not synonymous with `browser disconnected`, and `browser
control unavailable` is not synonymous with `Sidecar unavailable`.

## State model

A minimal observable state hierarchy is:

```text
Sidecar-to-agent channel
  ├── disconnected
  ├── connecting
  └── connected
        └── browser-control capability
              ├── unavailable / incompatible
              ├── reconnecting
              └── available
                    ├── no active page
                    └── active target
                          ├── document loading
                          ├── document ready
                          ├── operation running
                          ├── operation completed
                          ├── operation failed
                          └── operation stopped
```

A target or document transition may move the inner state without reconnecting
the browser-control capability. A browser-control failure may move that
capability to `unavailable` without disconnecting the Sidecar-to-agent channel.

## Initial page-context product contract

Opening Sidecar may identify the active page by its visible title and site, but
it does not imply permission to read that page's contents. The default surface
must say that distinction plainly and offer an explicit **Share more from this
page…** action.

Any expanded textual context must separate two independent choices:

- **Depth:** selected text, main page content, or all visible page text.
- **Lifetime:** one request, this document, or a separately reviewed longer
  tab/site scope.

Before sharing, Sidecar should describe what Hermes will receive and what it
will not receive. The initial text-reading design excludes screenshots, hidden
DOM, form values and keystrokes, cookies, credentials, browser history, and
other tabs. The active context remains visible and removable beside the
composer. Navigation invalidates document-scoped text rather than silently
carrying the grant to a replacement document.

The governing product contract is:

> Opening Hermes identifies the active page by title and site but does not read
> its contents. The human may explicitly share selected text or textual page
> content, choose a bounded lifetime, inspect what will be sent, and revoke it
> at any time. Hermes never captures screenshots, form values, or other tabs
> through this text-sharing feature.

## Selected shell and deferred saved-site rules

The selected everyday shell is **Quiet Context Strip**. The title/site boundary,
explicit **Share more…** action, composer attachments, and one-shot camera
control are sufficient for ordinary use without making context management look
like a control booth.

The Disclosure Card is not a persistent home surface. Its explanation may be
revealed on demand from the header ellipsis under plain-language labels such as
**Page sharing settings** or **About page sharing**. Those entries explain the
standing boundary; they do not attach page content. **Share more…** remains the
separate, visible sharing action. The Context Ledger remains a useful
inspectability study but is not the mainstream interaction model.

A later settings design may support human-authored saved rules at global,
domain, or individual-page scope:

- **Never allow:** prevent page-text sharing for a matching site/page until the
  human removes the rule.
- **Always allow this named scope:** remember a specific depth and lifetime so
  the human can invoke it without repeating the full explanation.
- A deny rule wins over an allow rule when scopes overlap.
- An allow rule does not itself attach content, create ambient observation, or
  grant interaction authority; a visible human sharing action is always
  required. Any future ambient-observation model would be a separate product
  and authority decision, not a saved-site preference.

Saved site rules are deferred product direction only. Their matching semantics,
storage, synchronization, edit/revocation UI, and browser permission needs must
be separately specified and tested before implementation.

## Future one-shot visual capture

A later visual-context feature may add a camera button as an explicit per-use
attachment action. Pressing it captures one image of the currently visible
rendered page viewport and attaches that image to the Hermes conversation.
It does not enable continuing visual observation or broaden the textual
page-reading lifetime.

This control is intentionally distinct from **Share more from this page…**:

- one press produces one visible-viewport image;
- the image may be previewed or removed like any other conversation attachment;
- navigation, scrolling, or page changes never trigger another capture;
- no full-page stitching, hidden/offscreen content, video stream, background
  capture, or automatic recapture is implied;
- no persistent page-reading grant is created merely because an image was
  attached;
- any platform-required temporary capability must be disclosed and proven
  separately before implementation.

The governing visual-capture rule is:

> A screenshot is a deliberate conversation attachment, not a standing
> observation grant.

This is a recorded product direction, not authority to add a Chrome permission
or implementation to the current slice.

## Current permission boundary

The current Sidecar extension declares only:

```text
nativeMessaging
sidePanel
storage
```

It does not currently declare `tabs`, `debugger`, content scripts, or host permissions. This document does not authorize adding them.

Mature browser companions commonly combine side-panel persistence, active-tab events, navigation events, a persistent native-host port, and a browser-control attachment keyed to tab identity. Some vendor products also have privileged browser integration unavailable to ordinary extensions.

Resonant Sidecar should first prove the supported Hermes and Chrome DevTools MCP path. Any new Chrome permission requires a demonstrated gap, a separate reviewed decision, and a plain-language account of what becomes observable or controllable.

## Cross-door continuity (`/handoff`)

Continuity lives in Hermes, not in any pipe. Surfaces are doors. Verified September 2026, live:

- `/handoff <surface>` moves a live session across doors. Proven path: sidecar panel → desktop app → Discord, with a checkable secret recalled verbatim at every door.
- `/resume <session_id|number>` and `/sessions all|full|search <query>` manage named sessions per surface.
- Resume is **custody-bound**: resuming a session that belongs to a different user or chat is refused. The refusal is quiet and exact — a reasonable boundary, not a ceremony.
- The panel holds only the Hermes thread id in session storage. It never needs the transcript to continue; Hermes brings history on resume.

Open question (not yet proven): no list-recent-sessions primitive has been demonstrated over ACP. A panel-level "last five sessions" picker is deferred until session enumeration is proven or panel-side id tracking is specified.

## Known integration question

The narrow current architecture has two identifier domains:

```text
Chrome extension                 browser-control transport
----------------                 -------------------------
windowId / tabId                 CDP targetId / sessionId
```

True automatic following across manual tab switches requires a verified way to select the corresponding browser-control target. It is not yet proven that the current permission surface and Chrome DevTools MCP expose a reliable mapping or foreground-target signal.

This is a bounded interoperability question for the companion Lab:

1. Keep one named browser lane connected.
2. Navigate repeatedly within one tab and confirm no transport re-handshake is required.
3. Switch among multiple tabs manually.
4. Observe which identifiers and lifecycle events are available to Sidecar and Chrome DevTools MCP.
5. Determine whether active-target selection can be derived without new extension permissions.
6. Record unsupported or ambiguous cases rather than guessing.
7. Consider additional permission or transport designs only if the supported path cannot satisfy the requirement.

## Acceptance criteria

Browser-session continuity is demonstrated only when the same Sidecar build can show all of the following:

- A named browser lane connects once and remains connected across multiple top-level navigations.
- Navigation invalidates old document handles and refreshes page context without resetting the conversation.
- Switching tabs updates the active target without a new human handshake.
- Closing a tab produces a bounded target transition, not a false browser-disconnected state.
- Closing and reopening the panel restores truthful conversation and connection state.
- An operation bound to an obsolete document cannot silently continue against a replacement document.
- Genuine transport loss is visible and recoverable.
- Chrome Stable and Chrome Dev exercise the same Sidecar commit.
- No unapproved Chrome permission is added to make the test pass.
- Results distinguish `pass`, `fail`, `not run`, and `unverified`.

## Evidence and clean-room boundary

Chrome documents that an extension side panel can remain open while navigating between tabs. Chrome also documents that `runtime.connectNative()` keeps a native-messaging host process running until its port is destroyed, unlike one-shot `sendNativeMessage()` calls.

Comparative inspection of a locally installed mature sidecar showed the expected product pattern: a persistent native-host connection with reconnect states, active-tab and navigation listeners, tab-keyed browser-control attachment, and invalidation of page-specific state after navigation. That observation informs this lifecycle model only. No vendor source, compiled asset, visual expression, or private protocol is incorporated into Resonant Sidecar.

References:

- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)

## Governing rule

> Preserve the durable browser relationship; replace the disposable document context.

A page change is ordinary lifecycle churn. It must not be promoted into a ceremony the human has to repeat.
