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
import { bridgeFixture, observations, NOW, RAW, until } from './fixtures/chrome-bridge.js';
import { ChromeReviewJournal } from '../bootstrap/chrome-review-journal.js';

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

for (const kind of ['result', 'cancel']) test(`native Chrome ${kind} settles busy review without entering conversation or starting another review`, async t => {
  const f = await bridgeFixture(t, { runtimeGeneration: 1 }); const input = new PassThrough(); const output = new PassThrough(); const messages = []; const turns = []; let bound; let result; let starts = 0; let runtime;
  const decoder = new NativeMessageDecoder(message => messages.push(message)); output.on('data', chunk => decoder.push(chunk));
  runtime = await runBootstrap({ input, output, signals: new EventEmitter(), chromeReview: { projectRoot: f.projectRoot, ...observations, clock: () => NOW },
    store: { recover: async () => {}, bindRuntimeGuard() {}, resolveActiveHost: async () => ({ digest: f.binding.activeDigest, reviewId: 'active' }) },
    coordinator: { checkAvailability: async () => ({ state: 'available', reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest }),
      startReview: async () => { starts++; bound = { ...f.binding, ...runtime.chromeReviewIdentity }; result = await runtime.requestChromeReview({ binding: bound, packet: f.packet, deadline: f.deadline }); return { state: 'review-failed', reviewId: bound.reviewId, candidateDigest: bound.candidateDigest }; }, acceptReview() {}, rejectReview() {} },
    receiptStore: { verifyChain() { throw new Error('no navigation'); } }, presentation: { openReviewReport() {}, openChromeDeveloperProject() {} },
    proxyFactory: () => ({ pid: 103, send: message => turns.push(message), close: async () => {} }),
  });
  t.after(() => runtime.close());
  assert.equal(typeof runtime.requestChromeReview, 'function');
  input.write(encodeNativeMessage({ type: 'turn.start', text: 'before' })); await until(() => turns.length);
  input.write(encodeNativeMessage({ type: 'update.status' })); await until(() => messages.some(m => m.type === 'update.available'));
  input.write(encodeNativeMessage({ type: 'review.start', reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest })); await until(() => messages.some(m => m.type === 'review.chromeReady'));
  for (let i = 0; i < 12; i++) input.write(encodeNativeMessage({ type: 'review.start', reviewId: f.binding.reviewId, candidateDigest: f.binding.candidateDigest }));
  input.write(encodeNativeMessage({ type: 'turn.start', text: 'during' }));
  const message = kind === 'result' ? { type: 'review.chromeResult', ...bound, rawText: RAW, reasonCode: null, availabilityStatus: 'available', executionStatus: 'completed' } : { type: 'review.chromeCancel', ...bound, reasonCode: 'cancellation', availabilityStatus: 'available', executionStatus: 'failed' };
  input.write(encodeNativeMessage(message)); await until(() => result);
  assert.equal(result.type, kind === 'result' ? 'ChromeReviewResult' : 'ChromeReviewFailure');
  assert.equal(runtime.chromeReviewJournal.recoveryState(), 'terminal-unreceipted'); assert.equal(starts, 1);
  await until(() => turns.length === 2); assert.deepEqual(turns.map(m => m.text), ['before', 'during']);
  input.write(encodeNativeMessage(message)); await new Promise(resolve => setImmediate(resolve)); assert.equal(starts, 1);
});

test('bootstrap mint returns only an unpredictable invocation ID without reserving a review or starting a proxy', async t => {
  const f = await bridgeFixture(t); let starts = 0;
  const runtime = await runBootstrap({ input: new PassThrough(), output: new PassThrough(), signals: new EventEmitter(), chromeReview: { projectRoot: f.projectRoot, ...observations, clock: () => NOW },
    store: { recover: async () => {}, bindRuntimeGuard() {} }, proxyFactory: () => { starts++; throw new Error('must not start'); },
  });
  try {
    assert.equal(typeof runtime.mintChromeInvocation, 'function');
    const first = runtime.mintChromeInvocation(); const second = runtime.mintChromeInvocation();
    assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); assert.notEqual(first, second);
    assert.equal(runtime.chromeReviewJournal.recoveryState(), 'empty'); assert.equal(starts, 0);
  } finally { await runtime.close(); }
  assert.throws(() => runtime.mintChromeInvocation());
});
test('bootstrap recovers old pending invocation before attaching any native input listener', async t => {
  const f = await bridgeFixture(t); const journal = new ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: f.binding.restartId });
  await journal.recover(); await journal.begin(f.binding);
  const input = new PassThrough(); let recoveryChecked = false;
  const runtime = await runBootstrap({ input, output: new PassThrough(), signals: new EventEmitter(), chromeReview: { projectRoot: f.projectRoot, ...observations, clock: () => NOW },
    store: { recover: async () => { assert.equal(input.listenerCount('data'), 0); const saved = JSON.parse(await readFile(path.join(f.projectRoot, 'runtime/chrome-review-pending.json'))); assert.equal(saved.reasonCode, 'interrupted-restart'); recoveryChecked = true; }, bindRuntimeGuard() {} },
  });
  assert.equal(recoveryChecked, true); assert.equal(runtime.chromeReviewJournal.recoveryState(), 'terminal-unreceipted'); await runtime.close();
});

test('long review dispatch never blocks normal turns or emergency interrupt', async () => {
  const input = new PassThrough(); const output = new PassThrough(); const sent = [];
  let release; let entered = false; let closed = false;
  const pending = new Promise(resolve => { release = resolve; });
  const runtime = await runBootstrap({ input, output, signals: new EventEmitter(),
    store: { recover: async () => {}, bindRuntimeGuard() {}, resolveActiveHost: async () => ({ digest: 'a'.repeat(64), reviewId: 'first' }) },
    coordinator: { handle: async () => { entered = true; await pending; return { state: 'eligible' }; } },
    proxyFactory: () => ({ pid: 103, send: m => sent.push(m), close: async () => { closed = true; } }),
  });
  try {
    input.write(encodeNativeMessage({ type: 'review.start' }));
    await waitFor(() => entered);
    input.write(encodeNativeMessage({ type: 'turn.start', text: 'still usable' }));
    input.write(encodeNativeMessage({ type: 'turn.interrupt' }));
    await waitFor(() => sent.length === 2);
    assert.deepEqual(sent.map(m => m.type), ['turn.start', 'turn.interrupt']); assert.equal(closed, false);
  } finally { release(); await runtime.close(); }
});
for (const problem of ['custody', 'review', 'invalid-request']) test(`${problem} lifecycle failure is framed without closing healthy A`, async () => {
  const input = new PassThrough(); const output = new PassThrough(); const messages = []; const sent = []; let closed = false;
  const decoder = new NativeMessageDecoder(m => messages.push(m)); output.on('data', chunk => decoder.push(chunk));
  const runtime = await runBootstrap({ input, output, signals: new EventEmitter(),
    store: { recover: async () => {}, bindRuntimeGuard() {}, resolveActiveHost: async () => ({ digest: 'a'.repeat(64), reviewId: 'first' }) },
    coordinator: { handle: async () => { const e = new Error('private details'); e.name = problem === 'custody' ? 'CustodyError' : 'Error'; throw e; } },
    proxyFactory: () => ({ pid: 103, send: m => sent.push(m), close: async () => { closed = true; } }),
  });
  try {
    input.write(encodeNativeMessage({ type: 'turn.start', text: 'before' })); await waitFor(() => sent.length === 1);
    input.write(encodeNativeMessage({ type: 'review.start', ...(problem === 'invalid-request' ? { path: '/tmp' } : {}) }));
    await waitFor(() => messages.length === 1);
    assert.deepEqual(messages, [{ type: 'review.failed', state: problem === 'custody' ? 'custody-broken' : 'review-failed' }]);
    assert.equal(closed, false);
    input.write(encodeNativeMessage({ type: 'turn.interrupt' })); await waitFor(() => sent.length === 2);
  } finally { await runtime.close(); }
});

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

for (const emission of ['lifecycle', 'oversized', 'stderr-flood', 'missing-session-id']) {
  test(`child ${emission} is stopped without crossing the trusted output boundary`, async t => {
    const f = await runtimeFixture(t);
    const host = emission === 'lifecycle'
      ? `const b=Buffer.from('{"type":"review.status","state":"eligible"}');const h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(Buffer.concat([h,b]));process.stdin.resume();`
      : emission === 'oversized'
        ? `const h=Buffer.alloc(4);h.writeUInt32LE(1024*1024+1);process.stdout.write(h);process.stdin.resume();`
        : emission === 'missing-session-id'
          ? `const b=Buffer.from('{"type":"session.ready"}');const h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(Buffer.concat([h,b]));setTimeout(()=>process.exit(0),25);`
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

test('trusted refresh replaces A with pending B on the same Chrome connection before completion', async t => {
  const f=await runtimeFixture(t);
  const echo=label=>`let buf=Buffer.alloc(0);process.stdin.on('data',c=>{buf=Buffer.concat([buf,c]);while(buf.length>=4&&buf.length>=4+buf.readUInt32LE(0)){let n=buf.readUInt32LE(0),m=JSON.parse(buf.subarray(4,n+4));buf=buf.subarray(n+4);let b=Buffer.from(JSON.stringify(m.type==='session.open'?{type:'session.ready',threadId:'shared'}:{type:'assistant.delta',text:${JSON.stringify(label)},phase:'unknown',turnId:'turn'}));let h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(Buffer.concat([h,b]));}});`;
  const a=await f.stage('a',echo('A'));const b=await f.stage('b',echo('B'));const store=new VersionStore({projectRoot:f.projectRoot,consumeDecision:consumer()});
  await store.installVersion(a);await store.activate(decisionFor(a));await store.completeActivation(decisionFor(a));await store.installVersion(b);
  const input=new PassThrough(),output=new PassThrough(),messages=[];const decoder=new NativeMessageDecoder(m=>messages.push(m));output.on('data',c=>decoder.push(c));
  const runtime=await runBootstrap({store,nodePath:await realpath(process.execPath),codexPath:await realpath(process.execPath),workspace:f.projectRoot,input,output,signals:new EventEmitter()});t.after(()=>runtime.close());
  input.write(encodeNativeMessage({type:'session.open',threadId:null}));await waitFor(()=>messages.length===1);const oldPid=runtime.childPid;
  const decision=decisionFor(b,'m'.repeat(32));await store.activate(decision);
  await assert.rejects(()=>store.completeActivation(decision),/refresh/i);
  const active=await runtime.refreshPending(decision);
  assert.equal(active.digest,b.manifest.bundleDigest);assert.equal(active.reviewId,'b');assert.equal(active.pid,runtime.childPid);assert.notEqual(active.pid,oldPid);
  assert.throws(()=>process.kill(oldPid,0),{code:'ESRCH'});
  input.write(encodeNativeMessage({type:'turn.start',text:'hello'}));await waitFor(()=>messages.some(m=>m.text==='B'));
  assert.equal(messages.some(m=>m.text==='A'),false);await runtime.completeActivation(decision);
  input.end();await runtime.closed;assert.equal((await new VersionStore({projectRoot:f.projectRoot}).resolveActiveHost()).digest,b.manifest.bundleDigest);
  assert.throws(()=>parseBootstrapMessage({type:'runtime.refresh'}));
});

for (const boundary of ['during-stop','after-ready']) {
  test(`disconnect ${boundary} of pending refresh reaps the proxy and restores A`, async t => {
    const f=await runtimeFixture(t);
    const host=`process.stdin.on('data',()=>{const b=Buffer.from('{"type":"session.ready","threadId":"shared"}');const h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(Buffer.concat([h,b]));});`;
    const a=await f.stage('a',host+'//A');const b=await f.stage('b',host+'//B');
    const store=new VersionStore({projectRoot:f.projectRoot,consumeDecision:consumer()});
    await store.installVersion(a);await store.activate(decisionFor(a));await store.completeActivation(decisionFor(a));await store.installVersion(b);
    const input=new PassThrough(),output=new PassThrough(),messages=[];const decoder=new NativeMessageDecoder(m=>messages.push(m));output.on('data',c=>decoder.push(c));
    const runtime=await runBootstrap({store,nodePath:await realpath(process.execPath),codexPath:await realpath(process.execPath),workspace:f.projectRoot,input,output,signals:new EventEmitter()});t.after(()=>runtime.close());
    input.write(encodeNativeMessage({type:'session.open',threadId:null}));await waitFor(()=>messages.length===1);const oldPid=runtime.childPid;
    const decision=decisionFor(b,'m'.repeat(32));await store.activate(decision);
    const refresh=runtime.refreshPending(decision);let newPid;
    if(boundary==='during-stop') {const cancelled=assert.rejects(refresh,/cancel/i);input.end();await cancelled;}
    else {newPid=(await refresh).pid;input.end();}
    await runtime.closed;
    assert.throws(()=>process.kill(oldPid,0),{code:'ESRCH'});
    if(newPid)assert.throws(()=>process.kill(newPid,0),{code:'ESRCH'});
    await assert.rejects(()=>runtime.completeActivation(decision),/completion/i);
    assert.equal((await new VersionStore({projectRoot:f.projectRoot}).resolveActiveHost()).digest,a.manifest.bundleDigest);
    assert.equal(JSON.parse(await readFile(path.join(f.root,'recovery-state.json'),'utf8')).candidate.digest,b.manifest.bundleDigest);
  });
}

async function racingBootstrap(t, { wrongB = false } = {}) {
  const f=await runtimeFixture(t);const trace=path.join(f.projectRoot,'process-trace.jsonl');const spawned=[];
  const host=label=>`import fs from 'node:fs';const trace=${JSON.stringify(trace)};const label=${JSON.stringify(label)};
    const prior=fs.existsSync(trace)?fs.readFileSync(trace,'utf8').trim().split('\\n').map(JSON.parse).filter(e=>e.event==='spawn'):[];
    const alive=prior.filter(e=>{try{process.kill(e.pid,0);return true;}catch{return false;}}).map(e=>e.pid);
    const log=e=>fs.appendFileSync(trace,JSON.stringify({...e,label,pid:process.pid})+'\\n');log({event:'spawn',alive});
    let buf=Buffer.alloc(0);process.stdin.on('data',c=>{buf=Buffer.concat([buf,c]);while(buf.length>=4&&buf.length>=4+buf.readUInt32LE(0)){
      const n=buf.readUInt32LE(0),m=JSON.parse(buf.subarray(4,n+4));buf=buf.subarray(n+4);log({event:'request',...m});
      if(m.type==='session.open') {const reply=()=>{const b=Buffer.from(JSON.stringify({type:'session.ready',threadId:label==='B'&&${wrongB}?'wrong-thread':m.threadId??'new-thread'})),h=Buffer.alloc(4);h.writeUInt32LE(b.length);process.stdout.write(Buffer.concat([h,b]));};
        if(label==='A'){const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(f.projectRoot,'allow-a-ready'))})){clearInterval(timer);reply();}},10);}else reply();}
    }});`;
  const a=await f.stage('a',host('A'));const b=await f.stage('b',host('B'));const store=new VersionStore({projectRoot:f.projectRoot,consumeDecision:consumer()});
  await store.installVersion(a);await store.activate(decisionFor(a));await store.completeActivation(decisionFor(a));await store.installVersion(b);
  const input=new PassThrough(),output=new PassThrough(),messages=[];const decoder=new NativeMessageDecoder(m=>messages.push(m));output.on('data',c=>decoder.push(c));
  const runtime=await runBootstrap({store,nodePath:await realpath(process.execPath),codexPath:await realpath(process.execPath),workspace:f.projectRoot,input,output,signals:new EventEmitter()});
  const readTrace=async()=>{let text;try{text=await readFile(trace,'utf8');}catch(e){if(e.code==='ENOENT')return [];throw e;}const events=text.trim().split('\n').filter(Boolean).map(JSON.parse);for(const e of events)if(e.event==='spawn'&&!spawned.includes(e.pid))spawned.push(e.pid);return events;};
  t.after(()=>{for(const pid of spawned){try{process.kill(-pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}});
  return {...f,a,b,store,input,messages,runtime,readTrace,spawned};
}

test('lazy resolution racing trusted refresh never overlaps or loses ownership of spawned children',async t=>{
  const f=await racingBootstrap(t);const original=f.store.resolveActiveHost.bind(f.store);let release,entered;
  const gate=new Promise(r=>{release=r;});const resolving=new Promise(r=>{entered=r;});
  f.store.resolveActiveHost=async()=>{entered();await gate;return original();};
  f.input.write(encodeNativeMessage({type:'session.open',threadId:'existing-thread'}));await resolving;
  const decision=decisionFor(f.b,'m'.repeat(32));await f.store.activate(decision);
  const refresh=f.runtime.refreshPending(decision);
  await Promise.race([refresh,new Promise(r=>setTimeout(r,250))]);release();await refresh;
  await new Promise(r=>setTimeout(r,100));const events=await f.readTrace();
  await f.runtime.completeActivation(decision);f.input.end();await f.runtime.closed;
  assert.equal(events.some(e=>e.event==='spawn'&&e.alive.length>0),false,'new child overlapped an unreaped child');
  for(const pid of f.spawned)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('refresh binds an in-flight explicit session.open before A reports readiness',async t=>{
  const f=await racingBootstrap(t);f.input.write(encodeNativeMessage({type:'session.open',threadId:'existing-thread'}));
  let events=[];await waitFor(()=>f.runtime.childPid!==undefined);
  for(let i=0;i<100;i++){events=await f.readTrace();if(events.some(e=>e.event==='request'&&e.label==='A'))break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(f.messages.length,0);const decision=decisionFor(f.b,'m'.repeat(32));await f.store.activate(decision);
  await f.runtime.refreshPending(decision);events=await f.readTrace();await f.runtime.completeActivation(decision);f.input.end();await f.runtime.closed;
  assert.equal(events.find(e=>e.event==='request'&&e.label==='B').threadId,'existing-thread');
  assert.equal(f.messages.some(m=>m.threadId==='new-thread'),false);
  for(const pid of f.spawned)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('refresh fails closed when an initial null session has not acquired an identity',async t=>{
  const f=await racingBootstrap(t);f.input.write(encodeNativeMessage({type:'session.open',threadId:null}));await waitFor(()=>f.runtime.childPid!==undefined);
  await f.readTrace();const decision=decisionFor(f.b,'m'.repeat(32));await f.store.activate(decision);
  let rejected;try{await f.runtime.refreshPending(decision);}catch(error){rejected=error;}
  await f.readTrace();f.input.end();await f.runtime.closed;
  assert.match(rejected?.message??'refresh was accepted',/session|identity/i);
  assert.equal((await new VersionStore({projectRoot:f.projectRoot}).resolveActiveHost()).digest,f.a.manifest.bundleDigest);
  assert.equal(f.messages.some(m=>m.threadId==='new-thread'),false);
});

test('disconnect while lazy resolution is suspended prevents all later spawns and completion',async t=>{
  const f=await racingBootstrap(t);const original=f.store.resolveActiveHost.bind(f.store);let release,entered;
  const gate=new Promise(r=>{release=r;});const resolving=new Promise(r=>{entered=r;});
  f.store.resolveActiveHost=async()=>{entered();await gate;return original();};
  f.input.write(encodeNativeMessage({type:'session.open',threadId:'existing-thread'}));await resolving;
  const decision=decisionFor(f.b,'m'.repeat(32));await f.store.activate(decision);f.input.end();
  await assert.rejects(()=>f.runtime.completeActivation(decision),/refresh/i);release();await f.runtime.closed;
  assert.deepEqual(await f.readTrace(),[]);assert.equal(f.runtime.childPid,undefined);
  assert.equal((await new VersionStore({projectRoot:f.projectRoot}).resolveActiveHost()).digest,f.a.manifest.bundleDigest);
});

test('wrong refresh session readiness cannot complete and every spawned child is reaped',async t=>{
  const f=await racingBootstrap(t,{wrongB:true});f.input.write(encodeNativeMessage({type:'session.open',threadId:'existing-thread'}));await waitFor(()=>f.runtime.childPid!==undefined);
  await f.readTrace();const decision=decisionFor(f.b,'m'.repeat(32));await f.store.activate(decision);
  await assert.rejects(()=>f.runtime.refreshPending(decision),/cancel/i);await f.runtime.closed;const events=await f.readTrace();
  await assert.rejects(()=>f.runtime.completeActivation(decision),/completion/i);
  assert.equal(events.find(e=>e.event==='request'&&e.label==='B').threadId,'existing-thread');
  assert.equal(f.messages.some(m=>m.threadId==='wrong-thread'),false);
  for(const pid of f.spawned)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal((await new VersionStore({projectRoot:f.projectRoot}).resolveActiveHost()).digest,f.a.manifest.bundleDigest);
});
