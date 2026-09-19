import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { VersionStore } from './fixtures/runtime-components.js';
import { runtimeFixture, decisionFor } from './fixtures/runtime.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now()+8000; while (!check()) { if (Date.now()>deadline) throw new Error('Lock test timed out'); await delay(10); } }

test('two starters after a dead owner cannot unlink a replacement live lock or enter together', async t => {
  const f = await runtimeFixture(t); const staged = await f.stage('a');
  await new VersionStore({ projectRoot: f.projectRoot }).installVersion(staged);
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); await once(dead, 'exit');
  const lock = path.join(f.root, '.store-lock.json'); await writeFile(lock, JSON.stringify({pid:dead.pid})+'\n', {mode:0o600});
  const events=[]; const children=[];
  for (const id of ['a','b']) {
    const script=`import fs from 'node:fs';import { VersionStore } from ${JSON.stringify(new URL('./fixtures/runtime-components.js', import.meta.url).href)};
      const unlink=fs.unlinkSync;let intercepted=false;
      fs.unlinkSync=p=>{if(p===${JSON.stringify(lock)}&&!intercepted){intercepted=true;process.send('stale-read');while(!fs.existsSync(${JSON.stringify(path.join(f.root, 'allow-'+id))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return unlink(p);};
      const store=new VersionStore({projectRoot:${JSON.stringify(f.projectRoot)},consumeDecision:async d=>{process.send('entered');await new Promise(r=>process.once('message',r));return {...d,consumed:false};}});
      process.send('started');try{await store.activate(${JSON.stringify(decisionFor(staged))});}catch{}process.exit(0);`;
    const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:'/usr/bin:/bin'}});
    child.on('message',message=>events.push({id,message})); children.push({id,child});
    t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  }
  await until(()=>events.filter(e=>e.message==='stale-read').length===2 || events.some(e=>e.message==='entered'));
  if (events.filter(e=>e.message==='stale-read').length===2) {
    await writeFile(path.join(f.root,'allow-a'),''); await until(()=>events.some(e=>e.message==='entered'));
    await writeFile(path.join(f.root,'allow-b'),'');
  }
  await until(()=>events.filter(e=>e.message==='started').length===2);
  const first=events.find(e=>e.message==='entered').id;
  await delay(200);
  assert.equal(events.filter(e=>e.message==='entered').length,1,'two mutation sections overlapped');
  const owner=children.find(e=>e.id===first).child; owner.send('release'); await once(owner,'exit');
  await until(()=>events.filter(e=>e.message==='entered').length===2);
  const second=children.find(e=>e.id!==first).child; second.send('release'); await once(second,'exit');
});

test('SIGKILL releases the permanent kernel lock without replacing its inode', async t => {
  const f=await runtimeFixture(t);const staged=await f.stage('a');await new VersionStore({projectRoot:f.projectRoot}).installVersion(staged);
  const script=`import { VersionStore } from ${JSON.stringify(new URL('./fixtures/runtime-components.js',import.meta.url).href)};
    const store=new VersionStore({projectRoot:${JSON.stringify(f.projectRoot)},consumeDecision:async()=>{process.send('held');await new Promise(()=>{});}});await store.activate(${JSON.stringify(decisionFor(staged))});`;
  const owner=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:'/usr/bin:/bin'}});
  t.after(()=>{if(owner.exitCode===null)owner.kill('SIGKILL');});await once(owner,'message');
  const file=path.join(f.root,'.store-lock.json');const before=await lstat(file);owner.kill('SIGKILL');await once(owner,'exit');
  await new VersionStore({projectRoot:f.projectRoot}).installVersion(staged);
  assert.equal((await lstat(file)).ino,before.ino);
});
