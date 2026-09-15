import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GrokAgentClient } from '../native-host/grok-agent-client.js';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-grok-stdio.js', import.meta.url));

function createClient() {
  return new GrokAgentClient({
    command: process.execPath,
    args: [fixturePath],
    cwd: process.cwd(),
  });
}

test('Grok ACP client starts a session and preserves exact text across consecutive turns', async t => {
  const client = createClient();
  t.after(() => client.close());
  const events = [];
  client.on('event', event => events.push(event));

  await client.start();
  const threadId = await client.openSession(null);
  const first = await client.startTurn('/literal first turn');
  await first.completed;
  const second = await client.startTurn('second λ turn');
  await second.completed;

  assert.equal(threadId, 'session-test');
  assert.deepEqual(
    events.filter(event => event.type === 'assistant.delta').map(event => event.text),
    ['echo:/literal first turn', 'echo:second λ turn'],
  );
});

test('Grok ACP client resumes the supplied session id', async t => {
  const client = createClient();
  t.after(() => client.close());
  await client.start();
  assert.equal(await client.openSession('session-existing'), 'session-existing');
});

test('Grok ACP client interrupts the current in-flight turn', async t => {
  const client = createClient();
  t.after(() => client.close());
  await client.start();
  await client.openSession(null);
  const turn = await client.startTurn('__hold__');
  await client.interruptTurn();
  const completion = await turn.completed;
  assert.equal(completion.status, 'interrupted');
});

test('Grok ACP client declines tool permission requests', async t => {
  const client = createClient();
  t.after(() => client.close());
  const events = [];
  client.on('event', event => events.push(event));
  await client.start();
  await client.openSession(null);
  const turn = await client.startTurn('__approval__');
  await Promise.race([turn.completed, new Promise(resolve => setTimeout(resolve, 50))]);
  assert.ok(events.some(event => event.type === 'policy.violation'));
});
