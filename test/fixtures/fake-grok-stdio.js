import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin });
const sessionId = 'session-test';
let turnHold = null;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

input.on('line', line => {
  const message = JSON.parse(line);

  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }

  if (message.method === 'session/new' || message.method === 'session/resume') {
    send({ id: message.id, result: { sessionId: message.params?.sessionId ?? sessionId } });
    return;
  }

  if (message.method === 'session/prompt') {
    const text = message.params.prompt[0].text;
    if (text.includes('__hold__')) {
      turnHold = message.id;
      send({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'held' } } } });
      return;
    }
    if (text.includes('__approval__')) {
      send({
        id: 900,
        method: 'session/request_permission',
        params: { sessionId, toolCall: { toolCallId: 'tool-1' } },
      });
      return;
    }
    const echoed = text.split('\n').at(-1);
    send({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${echoed}` } } } });
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === 'session/cancel') {
    if (turnHold !== null) {
      send({ id: turnHold, result: {} });
      turnHold = null;
    }
    return;
  }
});
