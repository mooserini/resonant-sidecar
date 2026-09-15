# Chrome-Native Semantic Review Amendment

Date: 2026-09-14

Status: Architectural direction approved in conversation on 2026-09-14; written amendment pending Tom's artifact review. No implementation, installation, migration, registration change, live model invocation, publication, or push is authorized by this document.

## Purpose

Add Chrome's on-device language-model capability as a second, independently produced semantic review of a Resonant Sidecar update without turning model output into authority.

This amendment preserves the original design's deterministic checks, isolated Codex CLI analysis, explicit human acceptance, atomic activation, rollback, and permanent receipts. It adds another opportunity to notice suspicious behavior while making the limits of every review claim explicit.

The operative security principle is separation of duties:

- Deterministic code establishes mechanical eligibility.
- The isolated Codex CLI supplies one bounded semantic analysis.
- Chrome's on-device language model supplies a separate bounded semantic analysis.
- The human may accept or reject only after every required prerequisite passes.
- The trusted bootstrap enforces the bound decision and cannot manufacture consent.

No participant may both propose, review, authorize, and execute the same change.

## Relationship to the approved design

This document is a binding amendment to:

```text
docs/superpowers/specs/2026-09-14-visible-review-refresh-design.md
```

Requirements in that design remain binding unless this amendment explicitly changes them. Historical V1 receipts, policy snapshots, review events, tests, and the Task 11 failure report retain their original meaning and must never be reinterpreted as if Chrome-native review had occurred.

The stopped Task 11 implementation remains preparation-only. Its five-review budget is exhausted. Work under this amendment begins with a new plan, new ledger, and new review budget. Task 12 and every live migration step remain blocked until the amended implementation passes its own gates.

## Confirmed local observations and explicit unknowns

Read-only inspection on 2026-09-14 confirmed:

- The installed target is Google Chrome Dev `155.0.8048.0`, bundle identifier `com.google.Chrome.dev`.
- The application is signed and notarized by Google LLC, Team ID `EQHXZ8M8AV`.
- Chrome Dev owns an on-device model component beneath its user data root.
- The observed component manifest names `v3Nano`, base-model version `2025.06.30.1229`, and component version `2025.8.8.1141`.
- The component directory is owner-only and contains Chrome component-verification metadata.

These observations prove that particular local artifacts existed when inspected. They do not prove which exact model weights, adapter, execution path, or process produced a future response.

The browser Prompt API deliberately abstracts the underlying model. The current public surface does not expose a cryptographic model identity, weight digest, signed inference statement, or attestation token. Therefore:

- Exact inference-model identity is **not attested**.
- Observed Chrome and component provenance is supporting evidence, not proof of inference origin.
- A model's self-description is never provenance.
- A favorable model response is never described as a signature, attestation, proof, or safety verdict.
- Changes that cannot be observed through the supported API remain outside the guarantee.

### Separately discovered local GPT resource

A read-only observation on 2026-09-14 also found an independent local model service:

- `Llama.app` owned a child `llama` process listening only on IPv4 loopback at `127.0.0.1:9931`.
- `GET /health` returned `{"status":"ok"}`.
- `GET /v1/models` advertised `ggml-org/gpt-oss-20b-GGUF:MXFP4`, owned by `llamacpp`, with status `unloaded`.
- The advertised model resolved to a local 12,109,566,624-byte GGUF file.
- The read-only requests did not submit a prompt, create an inference session, or load the model.

This is a real local capability, but it is not Chrome-native and it is not part of this amendment. Consuming it would add a separate application process, an OpenAI-compatible HTTP transport, different model and executable provenance, and a new availability lifecycle. Its presence cannot satisfy `chrome-semantic-review`, act as a fallback when Chrome review is unavailable, or silently become a third required reviewer.

If that resource is later adopted, it requires a separate design decision covering transport authentication, process and model binding, startup and shutdown ownership, endpoint substitution, request isolation, receipt labeling, and failure behavior. The current observation is discovery evidence, not authorization to invoke it.

## Authority model

Authority is divided rather than assigned to one process.

```text
Committed candidate bytes
        |
        v
Pinned bootstrap + immutable policy
        |
        +--> deterministic verifier --------------------+
        |                                               |
        +--> isolated Codex CLI semantic analysis ------+--> required evidence set
        |                                               |
        +--> pinned Chrome review adapter               |
                +--> on-device LanguageModel analysis --+
                                                        |
                                                        v
                                              eligible for human decision
                                                        |
                                                        v
                                      exact digest/nonce-bound human action
                                                        |
                                                        v
                                    bootstrap activation, verification, rollback
```

The two semantic reviewers produce untrusted assessments. They do not vote, negotiate, or clear one another's findings. The initial prompt to either reviewer must not contain the other reviewer's result.

Chrome-native review has bounded blocking influence when the immutable policy marks it as required:

- `no-blocking-concern` satisfies only the Chrome semantic-review prerequisite.
- `blocking-concern` withholds eligibility for the current attempt.
- `inconclusive`, malformed, incomplete, unavailable, interrupted, timed-out, unbound, unsanitizable, or drifted results withhold eligibility for the current attempt.

Withholding eligibility is not human rejection. It cannot alter the active version, revoke earlier receipts, change baseline permissions, or create a permanent custody break merely because the model was unavailable or unfavorable.

No semantic model may:

- Grant a capability or permission.
- Change policy, schemas, reviewer membership, input selection, or result interpretation.
- Authorize installation, activation, rollback, command execution, or remediation.
- Select or invoke tools, functions, links, files, browser pages, or native operations.
- Override deterministic failure, another required review failure, human rejection, or custody failure.
- Retry until it produces a favorable answer.

## Chrome review adapter boundary

The on-device model must be invoked from a supported, visible Chrome extension page with a `Window` context. The first implementation uses the open Resonant Sidecar side panel. It does not place model-session custody in the ephemeral service worker.

The adapter, prompt template, response schema, protocol parser, input-envelope builder, and result validator are control-plane code. During ordinary update review they run from the currently pinned active version and are outside the candidate being judged.

An ordinary candidate may not change those control-plane files. Changing them requires a separate visible control-plane migration reviewed by the previously pinned implementation and explicitly accepted by the human. A candidate is never loaded merely to review itself.

The single-extension design accepts the currently pinned extension as part of the trusted delivery path. It does not claim process isolation or cryptographic separation between extension pages that share an extension identity. If implementation cannot prevent candidate bytes from running in, messaging through, or replacing the active review adapter before acceptance, the design fails closed; a separately pinned reviewer extension or another separately approved boundary would then require its own design.

The adapter receives no page, tab, history, cookie, credential, clipboard, CDP, WebMCP, or conversation content. It gets no Chrome host permission and no new browser-automation permission. It creates no listener and uses no localhost transport.

## Explicit user initiation and model preparation

Read-only update availability detection must not create a model session, download a model, or send candidate evidence for inference.

The user explicitly initiates Chrome-native review from the visible side panel:

1. **Review and Refresh** stages the candidate and runs the prerequisite trusted checks without creating a browser model session.
2. After the bound Chrome review packet is ready, the side panel feature-detects the supported `LanguageModel` API and shows **Run local analysis**.
3. If model preparation or download is required, the UI instead shows a distinct **Prepare Chrome reviewer** action and the resource consequence. No download begins from update discovery, panel opening, startup, installation, or a native-host message.
4. A direct **Run local analysis** user action creates one fresh model session with the fixed trusted initial prompt and no tools. The design does not assume transient user activation survives the earlier native round trip.
5. The side panel displays preparation or review progress without exposing candidate-controlled diagnostic prose and provides a separate **Cancel analysis** control.
6. The session is destroyed after one terminal result or on cancellation, timeout, port loss, panel closure, browser restart, review expiry, or emergency stop.
7. A late completion after cancellation or generation change is discarded and cannot restore eligibility.

Neither trusted code nor automation may synthesize or bypass the direct user action. Preparing the model, when needed, does not accept a candidate and does not automatically begin analysis; the user returns to **Run local analysis** after preparation reaches a verified ready state.

There is no automatic cloud fallback, signed-in Gemini fallback, remote API, hidden retry, or alternate local model. The currently pinned version continues operating when Chrome-native review cannot run.

## Review input and independence

The trusted bootstrap constructs both semantic review inputs from the same immutable staged snapshot and policy snapshot. Sequencing the Chrome review after Codex is orchestration only; Chrome must receive the original evidence, not Codex's verdict or prose.

The Chrome review input is a canonical, size-bounded envelope containing only:

- Review ID and unique invocation ID assigned by trusted code.
- Active, candidate, and policy digests.
- Active and candidate manifests.
- A real bounded source diff produced by trusted code.
- Sanitized deterministic results.
- Fixed prompt and response-schema identities.
- Complete coverage metadata describing every supplied and omitted byte range.

Candidate filenames, source, comments, documentation, test names, fixtures, and strings are untrusted data. The prompt marks the evidence boundary explicitly, but prompt wording is not a security boundary.

The first implementation does not summarize an oversized diff. If the complete required review packet cannot fit the fixed input limit, Chrome returns `inconclusive` with `coverageStatus: incomplete-input` and the candidate remains ineligible. Deterministic chunking may be designed later; candidate-controlled or model-generated summarization cannot substitute for complete coverage.

The fixed review packet used by the installed runtime must contain the actual bounded source differences. The current migration template's declaration-only sentence is not a source diff and cannot support a claim of semantic source review.

## Model output contract

The model supplies only a schema-constrained analysis body:

```text
schemaVersion
outcome = no-blocking-concern | blocking-concern | inconclusive
summary
findings[]
  severity = important | caution | observation
  category = fixed allowlisted enum
  file = supplied file identity
  location = supplied hunk or null
  explanation
```

The model may not supply actions, commands, URLs, trusted digests, timestamps, adapter identity, browser identity, eligibility state, permissions, or policy changes.

The adapter retains the bounded raw UTF-8 result. Trusted code performs strict parsing, duplicate-key rejection, exact-property schema validation, size/depth/count limits, reference validation, sanitization, and canonicalization. Browser-provided structured-output constraints are a producer aid; they do not replace trusted validation.

Model output is never evaluated, imported, executed, rendered as HTML, followed as a link, forwarded as a native command, or displayed as candidate-controlled dialog text.

## Protocol binding

The trusted bootstrap creates one unpredictable invocation ID and binds it to:

- Review ID.
- Active and candidate bundle digests.
- Policy snapshot digest.
- Complete input digest.
- Prompt digest.
- Response-schema digest.
- Active adapter digest.
- Browser/runtime generation.
- Fixed deadline.

The transport accepts exactly one terminal response from the current established active-extension channel. Model-echoed hashes or nonces authenticate nothing. The adapter, not the model, wraps the analysis in the trusted response envelope.

The existing lifecycle router remains exclusive for starting reviews. A narrowly scoped response-and-cancel lane may settle only the one already-issued Chrome invocation while that router is busy. It accepts no new lifecycle command, path, candidate selection, tool request, policy change, or decision grant. Without this exception, the current busy gate would deadlock model completion and cancellation; broadening it into general native RPC is forbidden.

Unsolicited, duplicate, stale, cross-candidate, cross-policy, cross-port, cross-restart, post-timeout, or post-abort responses are rejected. A favorable callback followed by cleanup, disconnect, destruction, or finalization failure remains a failed review. Eligibility uses the final validated terminal result only.

The browser-visible protocol continues to suppress diagnostic prose. Detailed reasons are retained only in the immutable report bundle.

## Amended review state machine

The successful path becomes:

```text
available
  -> staged
  -> deterministic-review
  -> codex-review
  -> chrome-semantic-review
  -> eligible
  -> human-accepted
  -> activating
  -> activated
```

`deterministic-review`, `codex-review`, and `chrome-semantic-review` are distinct receipt events. Each required review may end in `review-failed`. Actual receipt-chain, identity-binding, or policy corruption may end in `custody-broken`.

No accept or reject nonce is issued until:

- Deterministic checks pass.
- The Codex result is terminal, favorable, sanitized, and correctly bound.
- The Chrome result is terminal, `no-blocking-concern`, sanitized, and correctly bound.
- Both results are permanently retained under the same review and evidence-set binding.
- Custody and the active session binding remain intact.

A browser or adapter restart before eligibility invalidates the Chrome result and ends the current review. A later attempt uses a new review ID and invocation ID. Historical V1 state graphs remain verified under V1 rules rather than being rewritten.

## Receipt and provenance model

The policy, receipt layout, sanitizer, and analysis schema advance together to a new explicit version. Existing V1 artifacts remain readable and immutable.

The new canonical artifact is:

```text
semantic-reviews/chrome-language-model.json
```

Its trusted envelope includes:

```text
schemaVersion
reviewerId = chrome-language-model
evidenceKind = semantic-analysis
reviewerRequirement = required
provenanceKind = observed-local-components
modelIdentityAssurance = not-attested
inferenceBinding = not-established
reviewId
invocationId
runtimeGeneration
activeBundleDigest
candidateBundleDigest
policySnapshotHash
inputDigest
promptDigest
schemaDigest
adapterDigest
coverageStatus
availabilityStatus
executionStatus
reasonCode
startedAt
completedAt
browserObservation
componentObservation
analysis
analysisDigest
eligibilityEffect
```

Trusted code assigns every binding, identity, status, time, and eligibility field. The model supplies only `analysis`.

Human-readable receipts use these exact meanings:

- **Chrome on-device semantic analysis** — the bounded model output.
- **Observed browser provenance** — locally measured Chrome executable/version/signing evidence.
- **Observed model component metadata** — locally measured component metadata, when available.
- **Exact inference model identity: not attested** — the API does not bind output to exact weights.
- **Input binding: verified by trusted adapter** — only after the envelope and channel checks pass.
- **Analysis outcome** — `no blocking concern`, `blocking concern`, or `inconclusive`.
- **Eligibility effect** — `prerequisite satisfied` or `candidate withheld`.

Receipts must never say `Gemini-attested`, `verified Gemini weights`, `cryptographic model attestation`, `independent proof`, or `safe to activate`.

Browser observations contain only allowlisted executable digest, version, signing identity, observation time, and explicit unavailable fields. Component observations state `observed`, `not-exposed`, or `not-collected`, name the metadata source, and include a version or artifact digest only when measured. They exclude browser profile contents, page text, conversation text, raw prompts, raw exceptions, arbitrary component dumps, and secret-bearing paths or values.

Receipt hashes prove the integrity of retained bytes. They do not prove semantic truth, model independence, prompt-injection resistance, or exact inference provenance.

## Resolution of the Task 11 lexical-gate overclaim

Chrome-native review does not close the demonstrated JavaScript lexical bypass and must not be described as doing so.

The revised trust claim is:

- The trusted bootstrap is an exact committed, reviewed, pinned source-and-byte identity.
- Its complete declared static import inventory is retained and verified.
- The lexical detector recognizes bounded suspicious forms as defense-in-depth evidence.
- The detector does not prove the absence of every semantically equivalent JavaScript loader or code-generation path.
- Known escaped and computed-property constructions remain explicit adversarial tests.
- Changing bootstrap or review-control code requires a separate visible control-plane ceremony; it is not an ordinary candidate update.
- Codex and Chrome semantic analyses add scrutiny, not proof.

Documentation and reports must use this bounded language. A parser may improve coverage, but no parser or model is represented as proving arbitrary JavaScript behavior safe.

## Capability constraints

This amendment adds no authority to the ordinary sidecar session:

- Chrome Dev remains the only browser target.
- Existing extension permissions remain `nativeMessaging`, `sidePanel`, and `storage` unless a later design explicitly changes them.
- Host permissions remain empty.
- No content script, debugger permission, CDP attachment, WebMCP actuation, page inspection, or browser automation is introduced.
- No TCP, HTTP, WebSocket, SSH, SSE, or localhost application listener is introduced.
- The model receives no tools or callbacks and cannot request a permission.
- Model acquisition is a visible browser-managed setup action, not an update-review side effect.
- The emergency stop aborts model work and the review transaction but does not erase evidence.

If implementation requires a new permission, separate extension, origin-trial token, persistent listener, cloud service, generalized native RPC, or browser flag beyond the already user-enabled local capability, it stops for a new design decision.

## Failure behavior

All Chrome semantic-review failures preserve the active pinned version and append a sanitized permanent receipt. They do not interrupt an ordinary active conversation except where the human presses the existing emergency stop.

The visible failure surface remains exactly:

```text
Review failed

[Open review report] [Continue in Codex] [Dismiss]
```

The report distinguishes fixed reason codes for API absence, setup required, setup declined, unavailable, timeout, cancellation, panel closure, browser restart, connection loss, incomplete input, malformed output, unfavorable analysis, inconclusive analysis, provenance drift, sanitization failure, and custody failure. Candidate or model prose never becomes the reason code.

## Verification requirements

### Deterministic and mocked-adapter checks

- Exact state-graph edges and historical V1-chain compatibility.
- No nonce issuance before all three required review stages pass and finalize.
- API absence, setup required, setup declined, unavailable, timeout, abort, panel closure, restart, and late result all leave the active pin unchanged.
- Forged, duplicate, stale, cross-review, cross-candidate, cross-policy, cross-port, and post-cancel results cannot satisfy the gate.
- Malformed, duplicate-key, oversized, truncated, incomplete, inconsistent, extra-field, or unsupported-schema output fails closed.
- Prompt injection through source, comments, documentation, filenames, fixtures, Unicode, encoded text, and forged output-shaped JSON cannot change permissions, protocol actions, policy, or state transitions.
- Candidate code cannot replace, invoke as, message through, or influence the pinned adapter before acceptance.
- A favorable Chrome result cannot clear deterministic or Codex failure.
- An unfavorable or inconclusive Chrome result cannot mutate active runtime state or permanently break custody.
- A model result never appears as HTML, executable text, a URL action, or a native command.
- Review abort and emergency stop destroy the one-shot session and reject late completion.
- Final receipt inventory, chain hashing, sanitization, and tamper detection include the new semantic-review artifact.

Mocked tests prove protocol and authority behavior only. They do not prove a real model's accuracy, identity, prompt-injection resistance, availability, or browser integration.

### Human-present Chrome Dev checks

Before live migration, a bounded visible check must separately establish:

- `LanguageModel` availability in the installed Chrome Dev extension side-panel context.
- Whether preparation/download is required and whether inference remains local after acquisition.
- Direct user-activation behavior.
- Fixed initial prompt and no-tool session creation.
- Structured-output support and trusted-side validation.
- Abort and session destruction behavior.
- Panel close, browser exit, and restart behavior.
- Observable browser/component provenance and its limits.
- No new extension permission, host permission, listener, page access, or conversation access.

That check uses inert test evidence and cannot accept, install, activate, or migrate a candidate. Results are retained as a capability receipt. Failure leaves the current V1 installation untouched.

## Explicit non-goals

- Treating Gemini Nano, Chrome, Codex, or agreement between models as an authority.
- Cryptographic model, weight, or inference attestation.
- Guaranteed semantic correctness, reviewer independence, or prompt-injection immunity.
- Replacing deterministic checks, Codex analysis, human acceptance, or rollback.
- Allowing a human click to override a failed required gate in the same review.
- Giving either model tools, execution, remediation, browsing, or permission control.
- Silent model download, cloud fallback, signed-in-account fallback, or hidden retries.
- Using the separately observed `127.0.0.1:9931` `llama.cpp`/`gpt-oss-20b` service as a reviewer or fallback.
- Letting an ordinary candidate update the adapter, prompt, schema, policy, receipt validator, dialog, or activation code that judges it.
- Closing the Task 11 loader bypass by assertion or retroactively continuing its exhausted review budget.
- Live installation, migration, stable-extension loading, native-host re-registration, Task 12 execution, publication, or push during specification and planning.

## Amended completion criteria

The amended review design is complete only when a human can start one visible review of one committed candidate and the system can prove that:

1. The candidate remained quarantined while all reviews ran.
2. Deterministic, Codex, and Chrome semantic reviews consumed the same bound evidence snapshot independently.
3. The Chrome review ran through the currently pinned active adapter in a visible, user-initiated, no-tool, one-shot session.
4. Every output and provenance limitation was retained under honest labels.
5. No permission, listener, page access, transport, or agent turn was introduced.
6. Any unavailable, incomplete, unfavorable, inconclusive, malformed, stale, interrupted, or drifted model result withheld only the current candidate.
7. No model could issue or influence an acceptance nonce or activation action.
8. The human could accept only after all required evidence was finalized and bound to the exact candidate and policy.
9. Emergency stop remained immediately available and invalidated late model completion.
10. Failure, acceptance, activation, rollback, restart, and exit receipts remained durable and verifiable.

Only after those automated and inert human-present checks pass may a later checkpoint show the exact migration plan and ask Tom to authorize that specific live mutation.
