import { SidecarSession } from './sidepanel-controller.js';

const transcript = document.querySelector('#transcript');
const form = document.querySelector('#turn-form');
const text = document.querySelector('#turn-text');
const sendButton = document.querySelector('#send-button');
const stopButton = document.querySelector('#stop-button');
const status = document.querySelector('#connection-status');
const announcement = document.querySelector('#announcement');
const errorMessage = document.querySelector('#error-message');

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
  if (event.type === 'session.ready') {
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
    setBusy(false);
    setStatus('Disconnected', 'closed');
    showError('The local sidecar disconnected. Close and reopen the panel to reconnect.');
    return;
  }
  if (event.type === 'policy.violation') {
    showError('Codex requested a disallowed action. The sidecar denied it.');
    return;
  }
  if (event.type === 'error' || event.type === 'protocol.error' || event.type === 'process.error') {
    setBusy(false);
    showError(event.message || 'The local sidecar reported an error.');
  }
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
  session.interrupt();
  stopButton.disabled = true;
  announcement.textContent = 'Stop requested.';
});

window.addEventListener('pagehide', () => session.disconnect());

try {
  await session.connect();
} catch (error) {
  setStatus('Unavailable', 'closed');
  showError(error instanceof Error ? error.message : String(error));
}
