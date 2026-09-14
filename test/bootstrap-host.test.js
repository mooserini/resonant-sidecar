import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { realpath, writeFile, readFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parseBootstrapMessage, runBootstrap } from '../bootstrap/host.js';
import { NativeMessageDecoder, encodeNativeMessage } from '../native-host/native-framing.js';
import { VersionStore } from '../bootstrap/version-store.js';
import { runtimeFixture, decisionFor, consumer } from './fixtures/runtime.js';

test('lifecycle is fixed and cannot smuggle decision or candidate paths to conversation child', () => {
  assert.equal(parseBootstrapMessage({ type: 'review.start' }).channel, 'lifecycle');
  assert.equal(parseBootstrapMessage({ type: 'turn.start', text: 'hello' }).channel, 'conversation');
  for (const value of [{ type: 'activate', nonce: 'x' }, { type: 'review.start', path: '/tmp/evil' }, { type: 'turn.start', text: 'hi', action: 'accept' }]) assert.throws(() => parseBootstrapMessage(value));
});

test('bootstrap owns lifecycle responses and proxies framed conversation with scrubbed environment', async t => {
  const f = await runtimeFixture(t);
  const inherited = process.env.BOOTSTRAP_TEST_SENTINEL;
  process.env.BOOTSTRAP_TEST_SENTINEL = 'must-not-reach-child';
  t.after(() => { if (inherited === undefined) delete process.env.BOOTSTRAP_TEST_SENTINEL; else process.env.BOOTSTRAP_TEST_SENTINEL = inherited; });
  const host = `import { readFileSync } from 'node:fs';
    let buffer=Buffer.alloc(0); process.stdin.on('data', c => { buffer=Buffer.concat([buffer,c]);
    while(buffer.length>=4 && buffer.length>=4+buffer.readUInt32LE(0)) {
      let n=buffer.readUInt32LE(0), m=JSON.parse(buffer.subarray(4,4+n)); buffer=buffer.subarray(4+n);
      let b=Buffer.from(JSON.stringify({type:'session.ready',threadId:process.env.BOOTSTRAP_TEST_SENTINEL?'bad':'clean'}));
      let h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(Buffer.concat([h,b])); } });`;
  const staged = await f.stage('first', host);
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(staged); await store.activate(decisionFor(staged)); await store.completeActivation(decisionFor(staged));
  const input = new PassThrough(); const output = new PassThrough(); const signals = new EventEmitter(); const messages = [];
  output.on('data', c => decoder.push(c)); const decoder = new NativeMessageDecoder(m => messages.push(m));
  const runtime = await runBootstrap({ store, nodePath: await realpath(process.execPath), codexPath: await realpath(process.execPath), workspace: f.projectRoot, input, output, signals, coordinator: { async handle() { return { type: 'review.status', state: 'available' }; } } });
  t.after(() => runtime.close());
  input.write(encodeNativeMessage({ type: 'review.start' })); input.write(encodeNativeMessage({ type: 'session.open', threadId: null }));
  await waitFor(() => messages.length === 2);
  assert.deepEqual(messages, [{ type: 'review.status', state: 'available' }, { type: 'session.ready', threadId: 'clean' }]);
  input.end(); await runtime.closed;
  assert.throws(() => process.kill(runtime.childPid, 0), { code: 'ESRCH' });
});

async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 20)); }
}

for (const exit of ['disconnect', 'SIGTERM']) {
  test(`${exit} reaps the actual active host and a Codex descendant ignoring SIGTERM, with no TCP listener`, async t => {
    const f = await runtimeFixture(t); const nodePath = await realpath(process.execPath);
    const codexPath = path.join(f.projectRoot, 'fake-codex.mjs');
    await writeFile(codexPath, `#!${nodePath}\nimport fs from 'node:fs'; import readline from 'node:readline';
      fs.writeFileSync(${JSON.stringify(path.join(f.projectRoot, 'codex.pid'))}, String(process.pid));
      process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);if(m.id!==undefined) process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{thread:{id:'owned'}}})+'\\n');
      });`, { mode: 0o700 });
    await chmod(codexPath, 0o700);
    const staged = await f.stage('first', `await import(${JSON.stringify(new URL('../native-host/host.js', import.meta.url).href)});`);
    const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
    await store.installVersion(staged); await store.activate(decisionFor(staged)); await store.completeActivation(decisionFor(staged));
    const input = new PassThrough(); const output = new PassThrough(); const signals = new EventEmitter(); const messages = [];
    const decoder = new NativeMessageDecoder(m => messages.push(m)); output.on('data', c => decoder.push(c));
    const runtime = await runBootstrap({ store, nodePath, codexPath, workspace: f.projectRoot, input, output, signals });
    t.after(() => runtime.close()); input.write(encodeNativeMessage({ type: 'session.open', threadId: null }));
    await waitFor(() => messages.some(m => m.type === 'session.ready'));
    const descendant = Number(await readFile(path.join(f.projectRoot, 'codex.pid'), 'utf8')); const host = runtime.childPid;
    const run = promisify(execFile);
    const ps = await run('/bin/ps', ['-p', `${host},${descendant}`, '-o', 'pid=,ppid=,pgid='], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    const rows = ps.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    assert.deepEqual(rows.find(r => r[0] === host), [host, process.pid, host]);
    assert.deepEqual(rows.find(r => r[0] === descendant), [descendant, host, host]);
    if (process.platform === 'darwin') {
      await assert.rejects(() => run('/usr/sbin/lsof', ['-nP', '-a', '-p', `${process.pid},${host},${descendant}`, '-iTCP', '-sTCP:LISTEN', '-Fpn'], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }), e => e.code === 1 && e.stdout === '');
    }
    if (exit === 'disconnect') input.end(); else signals.emit('SIGTERM');
    await runtime.closed;
    await waitFor(() => { try { process.kill(descendant, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
    assert.throws(() => process.kill(host, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  });
}

test('oversized browser frames fail closed without starting a child or forwarding raw input', async t => {
  const f = await runtimeFixture(t); const input = new PassThrough(); const output = new PassThrough(); const messages = [];
  const decoder = new NativeMessageDecoder(m => messages.push(m)); output.on('data', c => decoder.push(c));
  const runtime = await runBootstrap({ store: new VersionStore({ projectRoot: f.projectRoot }), input, output, signals: new EventEmitter() });
  const header = Buffer.alloc(4); header.writeUInt32LE(1024 * 1024 + 1); input.write(header);
  await runtime.closed;
  assert.equal(runtime.childPid, undefined);
  assert.deepEqual(messages, [{ type: 'error', message: 'Native runtime unavailable' }]);
});

for (const emission of ['lifecycle', 'oversized', 'stderr-flood']) {
  test(`child ${emission} is stopped without crossing the trusted output boundary`, async t => {
    const f = await runtimeFixture(t);
    const host = emission === 'lifecycle'
      ? `const b=Buffer.from('{"type":"review.status","state":"eligible"}');const h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(Buffer.concat([h,b]));process.stdin.resume();`
      : emission === 'oversized'
        ? `const h=Buffer.alloc(4);h.writeUInt32LE(1024*1024+1);process.stdout.write(h);process.stdin.resume();`
        : `process.stderr.write(Buffer.alloc(300*1024,120));process.stdin.resume();`;
    const staged = await f.stage('first', host); const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
    await store.installVersion(staged); await store.activate(decisionFor(staged)); await store.completeActivation(decisionFor(staged));
    const input = new PassThrough(); const output = new PassThrough(); const messages = [];
    const decoder = new NativeMessageDecoder(m => messages.push(m)); output.on('data', c => decoder.push(c));
    const runtime = await runBootstrap({ store, nodePath: await realpath(process.execPath), codexPath: await realpath(process.execPath), workspace: f.projectRoot, input, output, signals: new EventEmitter() });
    t.after(() => runtime.close()); input.write(encodeNativeMessage({ type: 'session.open', threadId: null }));
    await runtime.closed;
    assert.deepEqual(messages, [{ type: 'error', message: 'Native runtime unavailable' }]);
    assert.throws(() => process.kill(runtime.childPid, 0), { code: 'ESRCH' });
  });
}
