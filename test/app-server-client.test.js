import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AppServerClient } from '../native-host/app-server-client.js';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url));

function createClient() {
  return new AppServerClient({
    command: process.execPath,
    args: [fixturePath],
    cwd: process.cwd(),
  });
}

test('starts one thread and preserves exact text across consecutive turns', async t => {
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

  assert.equal(threadId, 'thread-test');
  assert.deepEqual(
    events.filter(event => event.type === 'assistant.delta').map(event => event.text),
    ['echo:/literal first turn', 'echo:second λ turn'],
  );
});

test('resumes the supplied thread id instead of starting another', async t => {
  const client = createClient();
  t.after(() => client.close());

  await client.start();

  assert.equal(await client.openSession('thread-existing'), 'thread-existing');
});

test('interrupts the current in-flight turn', async t => {
  const client = createClient();
  t.after(() => client.close());
  await client.start();
  await client.openSession(null);
  const turn = await client.startTurn('__hold__');

  await client.interruptTurn();
  const completion = await turn.completed;

  assert.equal(completion.status, 'interrupted');
});

test('declines an unsolicited command approval and reports a policy violation', async t => {
  const client = createClient();
  t.after(() => client.close());
  const events = [];
  client.on('event', event => events.push(event));
  await client.start();
  await client.openSession(null);

  const turn = await client.startTurn('__approval__');
  await turn.completed;

  assert.ok(events.some(event => event.type === 'policy.violation'));
  assert.ok(events.some(event => event.type === 'assistant.delta' && event.text === 'approval:decline'));
});

test('reports malformed server output and continues reading later events', async t => {
  const client = createClient();
  t.after(() => client.close());
  const events = [];
  client.on('event', event => events.push(event));
  await client.start();
  await client.openSession(null);

  const turn = await client.startTurn('__malformed__');
  await turn.completed;

  assert.ok(events.some(event => event.type === 'protocol.error'));
  assert.ok(events.some(event => event.type === 'assistant.delta' && event.text === 'echo:__malformed__'));
});

test('rejects pending work when the app-server process exits', async t => {
  const client = createClient();
  t.after(() => client.close());
  await client.start();
  await client.openSession(null);

  const turn = await client.startTurn('__exit__');

  await assert.rejects(turn.completed, /exited.*17/i);
});
