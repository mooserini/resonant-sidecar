import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { recoverInterruptedActivation } from '../bootstrap/recovery-state.js';
import { VersionStore } from '../bootstrap/version-store.js';
import { runtimeFixture, decisionFor, consumer } from './fixtures/runtime.js';
import { canonicalJson } from '../review/canonical-json.js';
import { spawnSync } from 'node:child_process';

for (const phase of ['prepared', 'previous-written', 'active-written', 'pending-verification', 'rolling-back']) {
  test(`restart at ${phase} restores prior digest and retains failed candidate`, async t => {
    const f = await runtimeFixture(t); const first = await f.stage('first'); const next = await f.stage('next', '// next');
    const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
    await store.installVersion(first); await store.activate(decisionFor(first)); await store.completeActivation(decisionFor(first));
    await store.installVersion(next); await store.activate(decisionFor(next, 'm'.repeat(32)));
    const file = path.join(f.root, 'recovery-state.json'); const state = JSON.parse(await readFile(file, 'utf8'));
    state.phase = phase; await writeFile(file, canonicalJson(state) + '\n');
    assert.equal(recoverInterruptedActivation(state).action, 'rollback');
    const restarted = new VersionStore({ projectRoot: f.projectRoot });
    await assert.rejects(() => restarted.resolveActiveHost(), /recovery/i);
    await restarted.recover();
    assert.equal((await restarted.resolveActiveHost()).digest, first.manifest.bundleDigest);
    const recovered = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(recovered.candidate.digest, next.manifest.bundleDigest);
    assert.equal(recovered.phase, 'rolled-back');
  });
}

test('malformed recovery refuses execution and first-install interruption restores no active host', async t => {
  assert.throws(() => recoverInterruptedActivation({ phase: 'unknown' }), /recovery/i);
  const f = await runtimeFixture(t); const staged = await f.stage('first');
  const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
  await store.installVersion(staged); await store.activate(decisionFor(staged));
  await new VersionStore({ projectRoot: f.projectRoot }).recover();
  await assert.rejects(() => new VersionStore({ projectRoot: f.projectRoot }).resolveActiveHost(), /active/i);
});

for (let boundary = 1; boundary <= 7; boundary++) {
  test(`SIGKILL after activation atomic rename ${boundary} restores the prior runtime`, async t => {
    const f = await runtimeFixture(t); const first = await f.stage('first'); const next = await f.stage('next', '// next');
    const store = new VersionStore({ projectRoot: f.projectRoot, consumeDecision: consumer() });
    await store.installVersion(first); await store.activate(decisionFor(first)); await store.completeActivation(decisionFor(first));
    await store.installVersion(next);
    // Intercept the real filesystem syscall in a disposable child. No fault
    // injection hooks or altered persistence paths exist in production.
    const script = `import fs from 'node:fs'; import { VersionStore } from ${JSON.stringify(new URL('../bootstrap/version-store.js', import.meta.url).href)};
      const rename=fs.renameSync;let count=0;fs.renameSync=(...args)=>{rename(...args);if(++count===${boundary})process.kill(process.pid,'SIGKILL');};
      const store=new VersionStore({projectRoot:${JSON.stringify(f.projectRoot)},consumeDecision:async d=>({...d,consumed:true})});
      await store.activate(${JSON.stringify(decisionFor(next, 'm'.repeat(32)))});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: '/usr/bin:/bin' }, timeout: 10000, maxBuffer: 65536 });
    assert.equal(child.signal, 'SIGKILL');
    const restarted = new VersionStore({ projectRoot: f.projectRoot });
    await restarted.recover();
    assert.equal((await restarted.resolveActiveHost()).digest, first.manifest.bundleDigest);
    const usedDecision = path.join(f.root, 'decisions');
    const { readdir } = await import('node:fs/promises');
    assert.equal((await readdir(usedDecision)).length, 2);
  });
}

test('atomic publication syncs each source before rename and its destination directory afterward', async t => {
  const f = await runtimeFixture(t); const staged = await f.stage('first');
  const script = `import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
    import { VersionStore } from ${JSON.stringify(new URL('../bootstrap/version-store.js', import.meta.url).href)};
    const synced=new Set();let awaiting=null,count=0;const sync=fs.fsyncSync,rename=fs.renameSync;
    fs.fsyncSync=fd=>{sync(fd);const s=fs.fstatSync(fd);synced.add(s.ino);if(s.ino===awaiting)awaiting=null;};
    fs.renameSync=(from,to)=>{assert.equal(awaiting,null);assert.ok(synced.has(fs.lstatSync(from).ino),'source was not fsynced');rename(from,to);awaiting=fs.lstatSync(path.dirname(to)).ino;count++;};
    const store=new VersionStore({projectRoot:${JSON.stringify(f.projectRoot)},consumeDecision:async d=>({...d,consumed:true})});
    await store.installVersion(${JSON.stringify(staged)});await store.activate(${JSON.stringify(decisionFor(staged))});
    assert.equal(awaiting,null);assert.ok(count>=7);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: '/usr/bin:/bin' }, timeout: 10000, maxBuffer: 65536 });
  assert.equal(child.status, 0, child.stderr.toString());
});
