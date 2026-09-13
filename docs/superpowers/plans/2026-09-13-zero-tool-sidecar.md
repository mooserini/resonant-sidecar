# Zero-Tool Resonant Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and locally attach a Chrome Dev side panel to Codex CLI, then prove one thread retains conversational context across several tool-free turns.

**Architecture:** A Manifest V3 side panel opens a long-lived Chrome Native Messaging port. A dependency-free Node native host translates Chrome's length-prefixed JSON frames to Codex app-server JSONL over child-process stdio and exposes only session, turn, stream, and interrupt operations.

**Tech Stack:** Chrome Manifest V3, semantic HTML/CSS/JavaScript, Node.js 26 built-ins, Codex CLI 0.153.2 app-server protocol, Node test runner.

**Spec:** `docs/design.md`

## Global Constraints

- No network listener; both transport hops use stdio.
- No CDP, page content, tabs, cookies, history, clipboard, or host permissions.
- No transcript persistence; only `threadId` may live in `chrome.storage.session`.
- No sidecar-defined slash commands; user text is forwarded byte-for-byte after JSON decoding.
- Tool and approval requests are never accepted in V1.
- The existing `resonant-mirror` checkout and its untracked files remain untouched.

---

### Task 1: Native framing and message validation

**Files:**
- Create: `package.json`
- Create: `native-host/native-framing.js`
- Create: `native-host/sidecar-protocol.js`
- Create: `test/native-framing.test.js`
- Create: `test/sidecar-protocol.test.js`

**Interfaces:**
- Produces: `encodeNativeMessage(value): Buffer`, `NativeMessageDecoder`, and `parseBrowserMessage(value)`.

- [ ] **Step 1: Write failing framing tests**

```js
test('decodes split UTF-8 Chrome frames', () => {
  const frame = encodeNativeMessage({ text: 'hello λ' });
  const decoded = [];
  const decoder = new NativeMessageDecoder(value => decoded.push(value));
  decoder.push(frame.subarray(0, 5));
  decoder.push(frame.subarray(5));
  assert.deepEqual(decoded, [{ text: 'hello λ' }]);
});
```

- [ ] **Step 2: Run `npm test` and confirm missing modules fail**
- [ ] **Step 3: Implement length-prefixed framing, size limits, and three allowed browser message shapes**
- [ ] **Step 4: Run `npm test` and confirm framing and validation pass**
- [ ] **Step 5: Commit `test: define native sidecar framing contract`**

### Task 2: Codex app-server session adapter

**Files:**
- Create: `native-host/app-server-client.js`
- Create: `test/app-server-client.test.js`
- Create: `test/fixtures/fake-app-server.js`

**Interfaces:**
- Consumes: newline-delimited JSON streams.
- Produces: `AppServerClient.start()`, `openSession(threadId)`, `startTurn(text)`, `interruptTurn()`, `close()` and typed event callbacks.

- [ ] **Step 1: Write a failing integration test against a deterministic fake app-server**

```js
test('starts one thread and sends consecutive text turns to it', async () => {
  const client = createTestClient();
  await client.start();
  const threadId = await client.openSession(null);
  await client.startTurn('/literal first turn');
  await client.startTurn('second turn');
  assert.equal(threadId, 'thread-test');
  assert.deepEqual(clientFixture.turnTexts, ['/literal first turn', 'second turn']);
});
```

- [ ] **Step 2: Run the targeted test and confirm the adapter is missing**
- [ ] **Step 3: Implement initialization, request correlation, thread start/resume, turn streaming, and interruption**
- [ ] **Step 4: Add and pass tests for malformed JSON, child exit, unsolicited tool/approval requests, and leading-slash preservation**
- [ ] **Step 5: Commit `feat: add Codex app-server session adapter`**

### Task 3: Native host bridge

**Files:**
- Create: `native-host/host.js`
- Create: `test/native-host.test.js`

**Interfaces:**
- Consumes: Chrome Native Messaging frames on stdin.
- Produces: validated sidecar events as Chrome Native Messaging frames on stdout.

- [ ] **Step 1: Write a failing process-level test that exchanges framed session and turn messages**
- [ ] **Step 2: Run the targeted test and confirm no host entry point exists**
- [ ] **Step 3: Implement the bridge with stdout reserved exclusively for frames and diagnostics on stderr**
- [ ] **Step 4: Run the process-level test and the complete suite**
- [ ] **Step 5: Commit `feat: bridge Chrome native messaging to Codex`**

### Task 4: Accessible Manifest V3 side panel

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/service-worker.js`
- Create: `extension/sidepanel.html`
- Create: `extension/sidepanel.css`
- Create: `extension/sidepanel.js`
- Create: `test/extension-contract.test.js`

**Interfaces:**
- Consumes: host name `com.resonantmirror.sidecar` and sidecar protocol events.
- Produces: action-opened side panel with transcript, composer, connection state, and Stop button.

- [ ] **Step 1: Write failing manifest and DOM-contract tests**
- [ ] **Step 2: Run the targeted tests and confirm the extension files are absent**
- [ ] **Step 3: Implement the MV3 manifest, synchronous service-worker listeners, semantic transcript/form controls, explicit labels, visible focus, and polite/assertive live regions**
- [ ] **Step 4: Run static checks and the complete test suite**
- [ ] **Step 5: Commit `feat: add local Codex side panel`**

### Task 5: Local Chrome Dev installation

**Files:**
- Create: `scripts/install-macos.js`
- Create: `test/install-macos.test.js`
- Generate locally: Chrome Dev native host manifest and executable launcher outside the repository.

**Interfaces:**
- Consumes: unpacked extension ID, absolute Node path, absolute Codex path, and project root.
- Produces: one user-scoped native-host registration whose `allowed_origins` contains only that extension ID.

- [ ] **Step 1: Write failing tests for path validation, exact origin generation, and Chrome Dev target selection**
- [ ] **Step 2: Run the targeted test and confirm the installer is missing**
- [ ] **Step 3: Implement dry-run output and explicit `--install --extension-id` mutation**
- [ ] **Step 4: Load the unpacked extension, capture its ID, run the installer, and inspect the generated manifest before use**
- [ ] **Step 5: Commit `feat: add inspected macOS native-host installer`**

### Task 6: Real zero-tool durability proof

**Files:**
- Create: `test/real-app-server-smoke.js`
- Create: `README.md`
- Create: `docs/test-receipt.md`

**Interfaces:**
- Consumes: installed Codex authentication and the locally attached Chrome Dev sidecar.
- Produces: a reproducible tool-free continuity receipt with thread and turn IDs but no transcript secrets.

- [ ] **Step 1: Add a smoke harness that sends deterministic nonce prompts and fails on any tool or approval event**
- [ ] **Step 2: Run the smoke harness directly against real `codex app-server` for three turns**
- [ ] **Step 3: Repeat the same sequence through the loaded Chrome Dev side panel, including one panel reload/resume**
- [ ] **Step 4: Run `npm run check`, inspect the installed manifest, and record exact pass/fail receipts**
- [ ] **Step 5: Commit `test: prove zero-tool conversational continuity`**
