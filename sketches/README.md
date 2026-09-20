# Resonant Sidecar redesign sketches

These disposable prototypes explore one product model in three visual directions. They are not extension implementation code.

Each variant intentionally emphasizes only part of the shared model. Context Canvas is the selected synthesis; an omitted control in an exploratory variant is not a competing authority rule.

## Product model shared by all three

The Sidecar is a persistent browser companion, not a connection wizard and not a general-purpose browser remote control.

### Three layers

1. **Relationship** — Sidecar keeps the selected agent, conversation, browser-lane connection, and activity history alive across ordinary navigation.
2. **Context** — Sidecar follows the selected tab/target and replaces disposable page context when navigation occurs. Context visibility is not blanket page authority.
3. **Capability** — Page access declares what Hermes may do, while Hermes's approval policy controls when Tom must be interrupted. The UI exposes both without reimplementing their enforcement.

### Interaction rule

Do not interrupt the user for routine continuity. Ask only when an operation crosses a meaningful boundary:

- **Automatic and visible:** maintain the native connection, preserve conversation, update selected-target identity, report connection and compatibility state.
- **Page access:** read-only, read/write once, or read/write for the Sidecar session.
- **Approval policy:** Minimal asks for every consequential action; Auto-accept lets Hermes Sentinel decide when approval is warranted; Full YOLO does not pause for approval inside the selected access scope.
- **Absent initially:** cookies, credentials, broad history, hidden background control, unattended browser launch, and speculative permissions.

This is least privilege without turning least privilege into least product.

### Environment-change policy

Prompt on an **authority delta**, not merely a **version delta**.

1. **Valid and compatible — continue.** When Chrome, macOS, the extension, the native host, or a system helper changes but retains a verified identity and passes the required capability checks, append a receipt and continue without user authentication. Routine Stable, Dev, beta, and operating-system updates must not produce Touch ID fatigue.
2. **Valid but materially different — pause the new authority lane.** If a verified change introduces or requests authority that is unexplained, unaccepted, unexpected, or potentially hazardous, pause only that proposed capacity. Explain the identity, capability, and authority delta in plain language, then require Tom to acknowledge it. Touch ID may ratify a durable trust or authority change; it does not exist to approve ordinary updates.
3. **Invalid, incomplete, or incompatible — contain the failure.** Stop only the affected capability, preserve the Sidecar conversation and unrelated healthy functions, and state exactly which identity, custody, protocol, or compatibility check failed. Offer the applicable recovery route: retry verification, revert, re-run review, repair the component, or disconnect it.

The user should never need to keep a finger hovering over Touch ID. Biometric confirmation is reserved for meaningful trust expansion, while verified environmental drift is monitored and documented automatically.

## Variants

| Variant | Best at | Tradeoff |
|---|---|---|
| [Quiet Companion](001-quiet-companion/index.html) | Conversation, low cognitive load, mainstream usability | Tool history is intentionally subdued |
| [Agent Workbench](002-agent-workbench/index.html) | Inspectable execution, explicit action approval, debugging confidence | Can feel technical if the activity treatment dominates |
| [Context Canvas](003-context-canvas/index.html) | Making the active-page relationship obvious and natural | Needs a secondary activity view for complex runs |

## Recommendation

Use **Context Canvas** as the primary shell. Its active-page card answers the core question — “what is Hermes looking at?” — without making the entire product a permissions dashboard.

Borrow two pieces from the other variants:

- Quiet Companion’s compact, collapsible activity disclosure for ordinary turns.
- Agent Workbench’s explicit inline approval card and inspectable run ledger, shown only while an operation is running or when the user opens Activity.

The resulting interface has four persistent zones:

1. compact product/agent header;
2. active-page context card with page access and Hermes approval policy;
3. conversation stream with inline results and approvals;
4. bottom composer with session capabilities.

Connection failures, incompatible browser state, and stopped operations appear in the same activity/result grammar instead of sending the user into a separate setup maze.

## Second-round: bounded Context Canvas

These newer sketches preserve the accepted title/site-only default and explore how explicit text sharing plus one-shot visual capture should enter the conversation. They are sibling studies; the earlier Context Canvas remains an untouched baseline.

| Variant | Primary emphasis | Best quality | Main cost |
|---|---|---|---|
| [Quiet Context Strip](004-quiet-context-strip/index.html) | Conversation-first | Calm, legible, least dashboard-like | Context provenance becomes compact |
| [Disclosure Card](005-disclosure-card/index.html) | Trust-first | Explains the privacy contract exceptionally well | Uses more vertical space |
| [Context Ledger](006-context-ledger/index.html) | Inspectability-first | Every context item is visible and removable | Slightly more tool-like |

All three include interactive studies of **Share more from this page…** and the deferred **one-shot camera attachment**. They do not imply browser APIs, permissions, or production implementation.

### Selected direction

Use **Quiet Context Strip** as the primary shell. It already carries the complete everyday model without turning context into a control booth:

- title and site are visible by default;
- page contents remain unshared;
- **Share more…** is the direct, bounded escalation;
- shared text and one-shot visual captures appear as removable composer attachments.

The Disclosure Card is not a persistent home surface. Its explanatory material may appear on demand under the header ellipsis as **Page sharing settings** or **About page sharing**. Those menu entries explain the standing boundary; they do not attach page content. **Share more…** remains the separate, visible sharing action. Context Ledger remains an inspectability study, not the mainstream shell.

The header menu may later expose **Saved site rules**—human-authored domain/page preferences such as *always allow this named sharing scope* or *never allow page-text sharing here*. This is deferred preference design and does not authorize ambient reading or automatic attachment.

## First implementation slice

Build only enough machinery to prove the product loop:

1. Open Sidecar and connect to Hermes.
2. Show the current browser lane and selected target if the supported path exposes them; show an honest unavailable state otherwise.
3. Send “Inspect this page.”
4. Render `connecting → running → completed`, with a structured read-only result.
5. Navigate or switch targets and preserve the conversation while refreshing only the page card.
6. Render `failed`, `stopped`, and `incompatible` through the same activity component.

No new Chrome permission belongs in that slice until the Lab demonstrates a concrete gap. If target following cannot be made reliable through the supported path, add only the smallest Chrome capability proven necessary and explain it in the UI and manifest.
