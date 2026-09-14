import { SidecarSession } from './sidepanel-controller.js';

const transcript = document.querySelector('#transcript');
const form = document.querySelector('#turn-form');
const text = document.querySelector('#turn-text');
const sendButton = document.querySelector('#send-button');
const stopButton = document.querySelector('#stop-button');
const status = document.querySelector('#connection-status');
const announcement = document.querySelector('#announcement');
const errorMessage = document.querySelector('#error-message');
const reviewCard = document.querySelector('#review-card');
const reviewTitle = document.querySelector('#review-title');
const reviewStatus = document.querySelector('#review-status');
const reviewButtons = Object.fromEntries(['start-review', 'accept-review', 'reject-review', 'open-report', 'open-desktop', 'dismiss-review'].map(id => [id, document.getElementById(id)]));

let assistantBody = null;

function setStatus(label, state) {
  status.textContent = label;
  status.dataset.state = state;
}

function setBusy(busy) {
  text.disabled = busy;
  sendButton.disabled = busy;
  stopButton.disabled = !busy;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function appendMessage(role, content = '') {
  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.role = role;

  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'You' : 'Codex';

  const body = document.createElement('span');
  body.textContent = content;
  item.append(label, body);
  transcript.append(item);
  item.scrollIntoView({ block: 'end' });
  return body;
}

function handleEvent(event) {
  if (/^(review|update|activation)\./.test(event.type)) { renderReview(); return; }
  if (event.type === 'session.ready') {
    setBusy(false);
    setStatus('Ready', 'ready');
    announcement.textContent = 'Local Codex session ready.';
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
      : 'Codex turn completed.';
    text.focus();
    return;
  }
  if (event.type === 'connection.closed') {
    reviewCard.hidden = true;
    setBusy(false);
    setStatus('Disconnected', 'closed');
    showError('The local sidecar disconnected. Close and reopen the panel to reconnect.');
    return;
  }
  if (event.type === 'policy.violation') {
    announcement.textContent = 'Codex requested a disallowed action. The sidecar denied it.';
    return;
  }
  if (event.type === 'error' || event.type === 'protocol.error' || event.type === 'process.error') {
    setBusy(session.turnActive);
    showError('The local sidecar is unavailable.');
  }
}

function renderReview() {
  const state = session.reviewState;
  const labels = { available: 'Update available', requested: 'Review in progress', reviewing: 'Review in progress', eligible: 'Ready to refresh', accepting: 'Refresh requested', activating: 'Refreshing', completed: 'Refresh complete', failed: 'Review failed' };
  const focusWasInCard = reviewCard.contains(document.activeElement);
  reviewCard.hidden = !Object.hasOwn(labels, state);
  if (reviewCard.hidden) { if (focusWasInCard) (session.turnActive ? stopButton : text).focus(); return; }
  reviewTitle.textContent = labels[state];
  reviewStatus.hidden = state === 'failed';
  reviewStatus.textContent = state === 'eligible' ? 'Verification passed. Accept this reviewed candidate or reject it.' : state === 'completed' ? 'The refreshed runtime was verified.' : 'Accept becomes available after verification.';
  const visible = state === 'failed' ? ['open-report', 'open-desktop', 'dismiss-review'] : state === 'completed' ? ['dismiss-review'] : state === 'eligible' ? ['accept-review', 'reject-review'] : state === 'available' ? ['start-review', 'accept-review'] : ['accept-review'];
  for (const [id, button] of Object.entries(reviewButtons)) {
    button.hidden = !visible.includes(id);
    button.disabled = (id === 'accept-review' && state !== 'eligible') || (['open-report', 'open-desktop'].includes(id) && !session.canNavigateReview);
  }
  announcement.textContent = labels[state];
  if (focusWasInCard && (document.activeElement.hidden || document.activeElement.disabled)) reviewTitle.focus();
}

const session = new SidecarSession({
  connectNative: name => chrome.runtime.connectNative(name),
  storage: chrome.storage.session,
  onEvent: handleEvent,
});

form.addEventListener('submit', event => {
  event.preventDefault();
  const content = text.value;
  if (!content.trim()) return;

  errorMessage.hidden = true;
  appendMessage('user', content);
  setBusy(true);
  session.sendTurn(content);
  text.value = '';
});

stopButton.addEventListener('click', () => {
  try { session.interrupt(); announcement.textContent = 'Stop requested.'; }
  catch { showError('Stop could not be requested. The local connection is unavailable.'); }
});

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
