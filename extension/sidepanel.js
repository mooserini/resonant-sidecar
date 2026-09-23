import { SidecarSession } from './sidepanel-controller.js';

const transcript = document.querySelector('#transcript');
const welcome = document.querySelector('#welcome');
const form = document.querySelector('#turn-form');
const text = document.querySelector('#turn-text');
const sendButton = document.querySelector('#send-button');
const stopButton = document.querySelector('#stop-button');
const status = document.querySelector('#connection-status');
const announcement = document.querySelector('#announcement');
const errorMessage = document.querySelector('#error-message');
const commandBarButton = document.getElementById('command-bar-button');
const commandMenu = document.getElementById('command-menu');
const reviewCard = document.querySelector('#review-card');
const reviewTitle = document.querySelector('#review-title');
const reviewStatus = document.querySelector('#review-status');
const reviewButtons = Object.fromEntries(['start-review', 'accept-review', 'reject-review', 'open-report', 'open-desktop', 'dismiss-review'].map(id => [id, document.getElementById(id)]));
const chromeControls = document.getElementById('chrome-review-controls');
const chromeNotice = document.getElementById('chrome-review-notice');
const preparationNotice = document.getElementById('chrome-preparation-notice');
const chromeStatus = document.getElementById('chrome-review-status');
const chromeButtons = Object.fromEntries(['prepare-chrome-review', 'run-chrome-review', 'cancel-chrome-review'].map(id => [id, document.getElementById(id)]));
const CHROME_NOTICE = 'Local analysis uses a Chrome-managed on-device model that may already be stored or updated on this device.';
const PREPARATION_NOTICE = 'Chrome may download and store an on-device model. Preparation does not run analysis.';


let assistantBody = null;

function setStatus(label, state) {
  status.textContent = label;
  status.dataset.state = state;
}

function setBusy(busy) {
  text.disabled = busy;
  sendButton.disabled = busy;
  commandBarButton.disabled = busy;
  stopButton.disabled = !busy && !session.chromeReviewActive;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function appendMessage(role, content = '') {
  welcome.hidden = true;
  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.role = role;

  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'You' : 'Hermes';

  const body = document.createElement('span');
  body.textContent = content;
  item.append(label, body);
  transcript.append(item);
  item.scrollIntoView({ block: 'end' });
  return body;
}

function handleEvent(event) {
  if (/^(review|update|activation)\./.test(event.type)) { renderReview(); return; }
  if (event.type === 'emergency.stopped') {
    setStatus('Stopped', 'ready'); announcement.textContent = 'Stop requested.'; return;
  }
  if (event.type === 'session.ready') {
    setBusy(false);
    setStatus('Ready', 'ready');
    announcement.textContent = 'Local session ready.';
    text.focus();
    return;
  }
  if (event.type === 'turn.started') {
    setBusy(true);
    setStatus('Thinking', 'ready');
    assistantBody = appendMessage('assistant');
    return;
  }
  if (event.type === 'assistant.delta') {
    if (!assistantBody) assistantBody = appendMessage('assistant');
    assistantBody.textContent += event.text || '';
    return;
  }
  if (event.type === 'turn.completed') {
    setBusy(false);
    setStatus('Ready', 'ready');
    assistantBody = null;
    announcement.textContent = event.status === 'interrupted'
      ? 'Turn stopped.'
      : 'Turn completed.';
    text.focus();
    return;
  }
  if (event.type === 'connection.closed') {
    setBusy(false);
    sendButton.disabled = true;
    renderReview();
    setStatus('Disconnected', 'closed');
    showError('The local sidecar disconnected. Close and reopen the panel to reconnect.');
    return;
  }
  if (event.type === 'policy.violation') {
    announcement.textContent = 'The agent requested a disallowed action. The sidecar denied it.';
    return;
  }
  if (event.type === 'error' || event.type === 'protocol.error' || event.type === 'process.error') {
    setBusy(session.turnActive);
    setStatus('Unavailable', 'closed');
    showError('The local sidecar is unavailable. Close and reopen the panel to reconnect.');
  }
}

function renderReview() {
  const state = session.reviewState;
  const labels = { available: 'Update available', requested: 'Review in progress', reviewing: 'Review in progress', eligible: 'Ready to refresh', accepting: 'Refresh requested', activating: 'Refreshing', completed: 'Refresh complete', stopped: 'Review stopped', failed: 'Review failed' };
  const focused = document.activeElement;
  const focusWasInCard = reviewCard.contains(focused);
  const visible = state === 'failed' ? ['open-report', 'open-desktop', 'dismiss-review'] : state === 'completed' ? ['dismiss-review'] : state === 'eligible' ? ['accept-review', 'reject-review'] : state === 'available' ? ['start-review', 'accept-review'] : state === 'stopped' ? [] : ['accept-review'];
  const controls = Object.entries(reviewButtons).map(([id, button]) => ({ button,
    hidden: !visible.includes(id),
    disabled: (id === 'accept-review' && state !== 'eligible') || (['open-report', 'open-desktop'].includes(id) && !session.canNavigateReview),
  }));
  const chromeState = session.chromeReviewState.state;
  const chromeVisible = state === 'reviewing' && ['checking', 'ready', 'preparation-required', 'preparing', 'running', 'completed'].includes(chromeState);
  const prepare = chromeVisible && ['preparation-required', 'preparing'].includes(chromeState);
  controls.push(...Object.entries(chromeButtons).map(([id, button]) => ({ button,
    hidden: !chromeVisible || (id === 'prepare-chrome-review' ? !prepare : id === 'run-chrome-review' ? !['ready', 'running'].includes(chromeState) : false),
    disabled: id === 'prepare-chrome-review' ? chromeState !== 'preparation-required' : id === 'run-chrome-review' ? chromeState !== 'ready' : !session.chromeReviewActive,
  })));
  // Chromium may blur a disabled/hidden button immediately. Decide where its
  // focus belongs from the old element and the intended state, before writes.
  const displacesFocus = focusWasInCard && controls.some(({ button, hidden, disabled }) => button === focused && (hidden || disabled));
  // Disclosures are committed before either resource-creating button enables.
  chromeNotice.textContent = CHROME_NOTICE; chromeNotice.hidden = !chromeVisible;
  preparationNotice.textContent = PREPARATION_NOTICE; preparationNotice.hidden = !prepare;
  chromeControls.hidden = !chromeVisible;
  const chromeLabels = { checking: 'Checking Chrome reviewer', ready: 'Chrome reviewer ready', 'preparation-required': 'Chrome reviewer preparation required', preparing: 'Preparing Chrome reviewer', running: 'Local analysis in progress', completed: 'Local analysis complete' };
  chromeStatus.textContent = chromeLabels[chromeState] ?? '';
  stopButton.disabled = !session.turnActive && !session.chromeReviewActive;
  reviewCard.hidden = !Object.hasOwn(labels, state);
  if (reviewCard.hidden) { if (focusWasInCard) (session.turnActive ? stopButton : text).focus(); return; }
  reviewTitle.textContent = labels[state];
  reviewStatus.hidden = state === 'failed';
  reviewStatus.textContent = state === 'eligible' ? 'Verification passed. Accept this reviewed candidate or reject it.' : state === 'completed' ? 'The refreshed runtime was verified.' : state === 'stopped' ? 'This review is no longer available.' : 'Accept becomes available after verification.';
  for (const { button, hidden, disabled } of controls) {
    button.hidden = hidden;
    button.disabled = disabled;
  }
  announcement.textContent = labels[state];
  if (displacesFocus) reviewTitle.focus();
}

const session = new SidecarSession({
  connectNative: name => chrome.runtime.connectNative(name),
  storage: chrome.storage.session,
  languageModel: globalThis.LanguageModel,
  onEvent: handleEvent,
});

function sendCurrentText() {
  const content = text.value;
  if (!content.trim()) return;

  errorMessage.hidden = true;
  commandMenu.hidden = true;
  try {
    session.sendTurn(content);
  } catch {
    showError('Sidecar is not connected.');
    return;
  }
  appendMessage('user', content);
  setBusy(true);
  text.value = '';
}

form.addEventListener('submit', event => {
  event.preventDefault();
  sendCurrentText();
});

stopButton.addEventListener('click', () => {
  try { session.emergencyStop(); }
  catch { showError('Stop could not be requested. The local connection is unavailable.'); }
});

// Command bar: buttons send slash commands Hermes already hears over ACP
// (spike 004), so no sidecar slash parser is needed — a leading `/`
// stays ordinary message text per the V1 boundary. `fire` sends
// immediately through the normal submit path; `fill` drops the stem
// into the composer for Tom to complete. Only verbs proven over ACP
// are listed: resume/compress are unprobed, steer trips the
// injection guard, voice is CLI-internal, save has no primitive,
// and approve/deny/restart/update/model knobs are out of scope.
const COMMANDS = [
  { name: 'handoff', hint: 'Move this session: desktop, discord, sidecar', mode: 'fill' },
  { name: 'status', hint: 'Hermes and machine status', mode: 'fire' },
  { name: 'retry', hint: 'Re-run the last turn', mode: 'fire' },
  { name: 'undo', hint: 'Back up one exchange', mode: 'fire' },
  { name: 'queue', hint: 'Queue a prompt for the next turn', mode: 'fill' },
  { name: 'title', hint: 'Name this session', mode: 'fill' },
  { name: 'new', hint: 'Fresh session', mode: 'fire' },
  { name: 'reset', hint: 'Clear this conversation', mode: 'fire' },
];

for (const command of COMMANDS) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'command-item';
  const label = document.createElement('span');
  label.className = 'command-name';
  label.textContent = '/' + command.name;
  const hint = document.createElement('span');
  hint.className = 'command-hint';
  hint.textContent = command.hint;
  item.append(label, hint);
  item.addEventListener('click', () => {
    if (command.mode === 'fire') {
      text.value = '/' + command.name;
      sendCurrentText();
    } else {
      text.value = '/' + command.name + ' ';
      commandMenu.hidden = true;
      text.focus();
    }
  });
  commandMenu.append(item);
}

commandBarButton.addEventListener('click', () => {
  commandMenu.hidden = !commandMenu.hidden;
});

document.addEventListener?.('keydown', event => {
  if (event.key === 'Escape') commandMenu.hidden = true;
});

for (const [id, method] of Object.entries({ 'prepare-chrome-review': 'prepareChromeReview', 'run-chrome-review': 'runChromeReview', 'cancel-chrome-review': 'cancelChromeReview' })) {
  chromeButtons[id].addEventListener('click', event => {
    const button = chromeButtons[id];
    if (!event.isTrusted || button.hidden || button.disabled || chromeControls.hidden || reviewCard.hidden) return;
    if (id !== 'cancel-chrome-review' && (chromeNotice.hidden || chromeNotice.textContent !== CHROME_NOTICE)) return;
    if (id === 'prepare-chrome-review' && (preparationNotice.hidden || preparationNotice.textContent !== PREPARATION_NOTICE)) return;
    // No await before this method: create must retain the direct user gesture.
    void session[method]();
  });
}

for (const [id, method] of Object.entries({ 'start-review': 'startReview', 'accept-review': 'acceptReview', 'reject-review': 'rejectReview', 'open-report': 'openReport', 'open-desktop': 'openDesktop', 'dismiss-review': 'dismissReview' })) {
  reviewButtons[id].addEventListener('click', () => { try { session[method](); } catch { /* State-gated actions cannot add diagnostics to the failure card. */ } renderReview(); });
}

window.addEventListener('pagehide', () => session.disconnect());

try {
  await session.connect();
  session.requestUpdateStatus();
} catch (error) {
  setStatus('Unavailable', 'closed');
  showError('The local sidecar is unavailable.');
}

// The panel document can outlive its native pipe: hiding the panel
// disconnects the port, but showing it again does not reload the page,
// so no new connect is attempted. Reconnect when visible again after a
// failure instead of stranding Tom on a dead pipe.
async function reconnect() {
  errorMessage.hidden = true;
  setStatus('Connecting', 'connecting');
  try {
    session.disconnect();
  } catch { /* already down */ }
  try {
    await session.connect();
    session.requestUpdateStatus();
  } catch (error) {
    setStatus('Unavailable', 'closed');
    showError('The local sidecar is unavailable. Close and reopen the panel to reconnect.');
  }
}

function maybeReconnect() {
  if (status.dataset.state === 'closed') void reconnect();
}

document.addEventListener?.('visibilitychange', () => {
  if (!document.hidden) maybeReconnect();
});
window.addEventListener('pageshow', maybeReconnect);
