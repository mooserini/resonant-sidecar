import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin });
const threadId = 'thread-test';
let turnSequence = 0;
let heldTurnId = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function completeTurn(turnId, status = 'completed') {
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status, items: [], error: null } },
  });
}

input.on('line', line => {
  const message = JSON.parse(line);

  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-app-server' } });
    return;
  }
  if (message.method === 'initialized') return;

  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.params.sandbox !== 'read-only') {
      send({
        id: message.id,
        error: { code: -32602, message: `Unexpected sandbox value: ${message.params.sandbox}` },
      });
      return;
    }
    send({ id: message.id, result: { thread: { id: message.params.threadId ?? threadId } } });
    return;
  }

  if (message.method === 'turn/start') {
    const text = message.params.input[0].text;
    const turnId = `turn-${++turnSequence}`;
    send({
      id: message.id,
      result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } },
    });
    send({
      method: 'turn/started',
      params: { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } },
    });

    if (text === '__exit__') process.exit(17);
    if (text === '__hold__') {
      heldTurnId = turnId;
      return;
    }
    if (text === '__malformed__') process.stdout.write('{not-json\n');
    if (text === '__approval__') {
      send({
        id: 900,
        method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, itemId: 'command-1', command: 'echo unsafe' },
      });
      return;
    }

    send({
      method: 'item/agentMessage/delta',
      params: { threadId, turnId, itemId: `assistant-${turnSequence}`, delta: `echo:${text}` },
    });
    completeTurn(turnId);
    return;
  }

  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    completeTurn(message.params.turnId, 'interrupted');
    heldTurnId = null;
    return;
  }

  if (message.id === 900) {
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId,
        turnId: `turn-${turnSequence}`,
        itemId: `assistant-${turnSequence}`,
        delta: `approval:${message.result.decision}`,
      },
    });
    completeTurn(`turn-${turnSequence}`);
  }
});

process.on('SIGTERM', () => process.exit(0));
