// Trusted entry point. Candidate source arrives as bounded stdin data; nothing
// in the candidate selects a command, test, fixture, import, or report path.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const sources = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const context = createContext({ Buffer, process: Object.freeze({ cwd: () => '/test', env: Object.freeze({}) }) }, { codeGeneration: { strings: false, wasm: false } });
const plain = value => JSON.parse(JSON.stringify(value));
let approval;
let pendingChild;
let turn = 0;

function fakeSpawn(command, args, options) {
  assert.equal(command, 'trusted-fixture');
  assert.deepEqual(plain(args), []);
  assert.equal(options.cwd, '/test');
  assert.deepEqual(plain(options.env), {});
  assert.deepEqual(plain(options.stdio), ['pipe', 'pipe', 'pipe']);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.stdout.end(); child.stderr.end(); return true; };
  child.send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin = { writable: true, write: line => {
    const request = JSON.parse(line);
    queueMicrotask(() => {
      const respond = result => child.send({ id: request.id, result });
      const notify = (method, params) => child.send({ method, params });
      if (request.method === 'initialize') respond({});
      else if (request.method === 'initialized') return;
      else if (request.method === 'thread/start' || request.method === 'thread/resume') {
        assert.equal(request.params.approvalPolicy, 'never');
        assert.equal(request.params.sandbox, 'read-only');
        respond({ thread: { id: request.params.threadId ?? 'thread-test' } });
      } else if (request.method === 'turn/start') {
        const id = `turn-${++turn}`;
        child.turn = id;
        respond({ turn: { id } });
        notify('turn/started', { turn: { id } });
        const text = request.params.input[0].text;
        if (text === '__hold__') return;
        notify('item/agentMessage/delta', { delta: `echo:${text}`, turnId: id });
        notify('turn/completed', { turn: { id, status: 'completed' } });
      } else if (request.method === 'turn/interrupt') {
        respond({});
        notify('turn/completed', { turn: { id: child.turn, status: 'interrupted' } });
      } else if (request.id === 700) approval = request;
      else assert.fail('Unexpected candidate protocol request');
    });
    return true;
  } };
  pendingChild = child;
  return child;
}

const builtins = {
  'node:child_process': { spawn: fakeSpawn },
  'node:events': { EventEmitter },
  'node:readline': { default: readline },
};
async function load(file) {
  assert.ok(['native-host/native-framing.js', 'native-host/sidecar-protocol.js', 'native-host/app-server-client.js', 'extension/sidepanel-controller.js'].includes(file));
  const module = new SourceTextModule(sources[file], { context, identifier: file });
  await module.link(specifier => {
    const exports = builtins[specifier];
    assert.ok(file === 'native-host/app-server-client.js' && exports, 'Unapproved candidate import');
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate({ timeout: 1000 });
  return module.namespace;
}

async function client() {
  const { AppServerClient } = await load('native-host/app-server-client.js');
  const value = new AppServerClient({ command: 'trusted-fixture', args: [], cwd: '/test' });
  await value.start();
  return value;
}

const mode = process.argv[2];
if (mode === 'unit') {
  const { NativeMessageDecoder, encodeNativeMessage } = await load('native-host/native-framing.js');
  const decoded = [];
  const decoder = new NativeMessageDecoder(value => decoded.push(plain(value)));
  const frame = encodeNativeMessage({ text: 'hello λ' });
  decoder.push(frame.subarray(0, 5));
  decoder.push(frame.subarray(5));
  assert.deepEqual(decoded, [{ text: 'hello λ' }]);
  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(64 * 1024 * 1024 + 1);
  assert.throws(() => new NativeMessageDecoder(() => {}).push(huge));
} else if (mode === 'protocol') {
  const { parseBrowserMessage } = await load('native-host/sidecar-protocol.js');
  assert.deepEqual(plain(parseBrowserMessage({ type: 'turn.start', text: '/literal λ' })), { type: 'turn.start', text: '/literal λ' });
  assert.deepEqual(plain(parseBrowserMessage({ type: 'session.open', threadId: 'thread-existing' })), { type: 'session.open', threadId: 'thread-existing' });
  for (const message of [{ type: 'run.command' }, { type: 'turn.interrupt', command: 'no' }, { type: 'turn.start', text: ' ' }, { type: 'turn.start', text: 'x'.repeat(32769) }]) assert.throws(() => parseBrowserMessage(message));
} else if (mode === 'continuity') {
  const value = await client();
  try {
    const events = [];
    value.on('event', event => events.push(plain(event)));
    assert.equal(await value.openSession('thread-existing'), 'thread-existing');
    for (const text of ['/first λ', 'second']) await (await value.startTurn(text)).completed;
    assert.deepEqual(events.filter(event => event.type === 'assistant.delta').map(event => event.text), ['echo:/first λ', 'echo:second']);
    assert.equal(value.threadId, 'thread-existing');
  } finally { value.close(); }
  const { SidecarSession } = await load('extension/sidepanel-controller.js');
  const sent = [];
  const session = new SidecarSession({
    connectNative: name => {
      assert.equal(name, 'com.resonantmirror.sidecar');
      return { postMessage: message => sent.push(plain(message)), onMessage: { addListener() {} }, onDisconnect: { addListener() {} } };
    },
    storage: { get: async key => { assert.equal(key, 'codexThreadId'); return { codexThreadId: 'thread-existing' }; } },
  });
  await session.connect();
  assert.deepEqual(sent, [{ type: 'session.open', threadId: 'thread-existing' }]);
} else if (mode === 'interruption') {
  const value = await client();
  try {
    await value.openSession(null);
    const current = await value.startTurn('__hold__');
    await value.interruptTurn();
    assert.equal((await current.completed).status, 'interrupted');
  } finally { value.close(); }
} else if (mode === 'negative-policy') {
  const value = await client();
  try {
    const events = [];
    value.on('event', event => events.push(plain(event)));
    await value.openSession(null);
    pendingChild.send({ id: 700, method: 'item/commandExecution/requestApproval', params: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(approval, { id: 700, result: { decision: 'decline' } });
    assert.ok(events.some(event => event.type === 'policy.violation'));
  } finally { value.close(); }
} else assert.fail('Unknown trusted check');
process.stdout.write('passed\n');
