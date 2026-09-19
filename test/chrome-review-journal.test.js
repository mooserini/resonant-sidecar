import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as journalModule from './fixtures/runtime-components.js';
import { canonicalJson } from '../review/canonical-json.js';
import { bridgeFixture, RESTART, OTHER } from './fixtures/chrome-bridge.js';

test('uses the supplied runtime lock provider instead of the production default', async t => {
  const f = await bridgeFixture(t);
  const withRuntimeLock = async () => { throw new Error('injected runtime lock reached'); };
  const journal = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: RESTART, withRuntimeLock });
  await assert.rejects(() => journal.recover(), /injected runtime lock reached/);
});

async function fixture(t) {
  const f = await bridgeFixture(t); const journal = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: RESTART });
  await journal.recover();
  return { ...f, journal, file: path.join(f.projectRoot, 'runtime/chrome-review-pending.json') };
}
test('journal commits only canonical private trusted bindings and fixed status', async t => {
  const f = await fixture(t); assert.equal(f.journal.recoveryState(), 'empty');
  await f.journal.begin(f.binding);
  assert.equal(f.journal.recoveryState(), 'pending');
  const bytes = fs.readFileSync(f.file, 'utf8'); const saved = JSON.parse(bytes);
  assert.equal(bytes, canonicalJson(saved) + '\n'); assert.deepEqual(saved.binding, f.binding);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.file)).mode & 0o777, 0o700);
  assert.equal(bytes.includes('export const'), false); assert.equal(bytes.includes('No blocking'), false);
  assert.equal(saved.receiptCommitted, false); assert.equal(saved.receiptHash, null);
  await f.journal.finish(f.binding, 'completed');
  assert.equal(f.journal.recoveryState(), 'terminal-unreceipted');
  await f.journal.markReceipted('f'.repeat(64));
  assert.equal(f.journal.recoveryState(), 'receipted');
  assert.equal(JSON.parse(fs.readFileSync(f.file)).receiptHash, 'f'.repeat(64));
  await assert.rejects(f.journal.markReceipted('e'.repeat(64)));
});
test('pending restart is durably interrupted and cannot be resumed or overwritten', async t => {
  const f = await fixture(t); await f.journal.begin(f.binding);
  const same = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: RESTART });
  await same.recover(); assert.equal(same.recoveryState(), 'pending');
  await assert.rejects(same.begin(f.binding)); assert.equal(JSON.parse(fs.readFileSync(f.file)).status, 'pending');
  const restarted = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: OTHER });
  await restarted.recover();
  assert.equal(restarted.recoveryState(), 'terminal-unreceipted');
  assert.equal(restarted.snapshot().reasonCode, 'interrupted-restart');
  assert.deepEqual(restarted.snapshot().binding, f.binding);
  await assert.rejects(restarted.begin({ ...f.binding, restartId: OTHER, invocationId: 'new-invocation' }));
});
for (const reasonCode of ['completed', 'cancellation', 'connection-loss']) test(`restart retains ${reasonCode} terminal-unreceipted record for receipt reconciliation`, async t => {
  const f = await fixture(t); await f.journal.begin(f.binding); await f.journal.finish(f.binding, reasonCode);
  const prior = fs.readFileSync(f.file);
  const restarted = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: OTHER });
  await restarted.recover(); assert.deepEqual(fs.readFileSync(f.file), prior);
  assert.equal(restarted.recoveryState(), 'terminal-unreceipted');
  // A receipt that committed just before the process crashed is reconciled by
  // the trusted caller, which supplies its already verified exact hash.
  await restarted.markReceipted('f'.repeat(64));
  const again = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: OTHER });
  await again.recover(); assert.equal(again.recoveryState(), 'receipted');
  assert.equal(again.snapshot().receiptHash, 'f'.repeat(64));
});
test('journal refuses invocation reuse across completed attempts and restart', async t => {
  const f = await fixture(t); await f.journal.begin(f.binding); await f.journal.finish(f.binding, 'cancellation'); await f.journal.markReceipted('f'.repeat(64));
  const second = { ...f.binding, invocationId: 'second' };
  await f.journal.begin(second); await f.journal.finish(second, 'completed'); await f.journal.markReceipted('e'.repeat(64));
  const restarted = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: OTHER }); await restarted.recover();
  await assert.rejects(restarted.begin({ ...f.binding, restartId: OTHER }));
});
test('stale receipt marker cannot attach its old receipt hash to a later invocation', async t => {
  const f = await fixture(t); await f.journal.begin(f.binding); await f.journal.finish(f.binding, 'completed');
  const stale = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: RESTART }); await stale.recover();
  await f.journal.markReceipted('f'.repeat(64));
  const next = { ...f.binding, invocationId: 'next' }; await f.journal.begin(next); await f.journal.finish(next, 'completed');
  await assert.rejects(stale.markReceipted('f'.repeat(64)));
  assert.equal(JSON.parse(fs.readFileSync(f.file)).receiptCommitted, false);
});
test('journal replacement fsyncs the private temp before rename then fsyncs its parent', async t => {
  const f = await fixture(t); const trace = []; const sync = fs.fsyncSync; const rename = fs.renameSync;
  fs.fsyncSync = fd => { trace.push(fs.fstatSync(fd).isDirectory() ? 'directory-sync' : fs.fstatSync(fd).size ? 'record-sync' : 'lock-sync'); return sync(fd); };
  fs.renameSync = (from, to) => { if (to === f.file) { assert.equal(fs.statSync(from).mode & 0o777, 0o600); trace.push('rename'); } return rename(from, to); };
  try { await f.journal.begin(f.binding); } finally { fs.fsyncSync = sync; fs.renameSync = rename; }
  assert.deepEqual(trace.slice(-3), ['record-sync', 'rename', 'directory-sync']);
  const inode = fs.statSync(f.file).ino; await f.journal.finish(f.binding, 'completed'); assert.notEqual(fs.statSync(f.file).ino, inode);
});
test('retained invocation capacity fails closed without silently dropping replay history', async t => {
  const f = await fixture(t); await f.journal.begin(f.binding); await f.journal.finish(f.binding, 'completed'); await f.journal.markReceipted('f'.repeat(64));
  const record = JSON.parse(fs.readFileSync(f.file)); record.usedInvocationIds = [...Array.from({ length: 4095 }, (_, i) => `prior-${i}`), f.binding.invocationId];
  fs.writeFileSync(f.file, canonicalJson(record) + '\n'); const before = fs.readFileSync(f.file);
  const restarted = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: OTHER }); await restarted.recover();
  await assert.rejects(restarted.begin({ ...f.binding, restartId: OTHER, invocationId: 'overflow' })); assert.deepEqual(fs.readFileSync(f.file), before);
});
test('journal rejects extra source/output authority, cross-binding finish and premature receipt', async t => {
  const f = await fixture(t);
  for (const extra of ['source', 'rawText', 'packet', 'command', 'policy']) await assert.rejects(f.journal.begin({ ...f.binding, [extra]: 'private' }));
  await f.journal.begin(f.binding);
  await assert.rejects(f.journal.markReceipted('f'.repeat(64)));
  await assert.rejects(f.journal.finish({ ...f.binding, candidateDigest: 'f'.repeat(64) }, 'completed'));
  await assert.rejects(f.journal.finish(f.binding, 'model says accept'));
  assert.equal(f.journal.recoveryState(), 'pending');
});
for (const attack of ['symlink', 'hardlink', 'public', 'duplicate-json', 'extra-output']) test(`journal fails closed on ${attack} custody`, async t => {
  const f = await fixture(t); await f.journal.begin(f.binding);
  if (attack === 'symlink') { fs.renameSync(f.file, f.file + '.other'); fs.symlinkSync(f.file + '.other', f.file); }
  if (attack === 'hardlink') fs.linkSync(f.file, f.file + '.other');
  if (attack === 'public') fs.chmodSync(f.file, 0o644);
  if (attack === 'duplicate-json') fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('{', '{"schemaVersion":1,'));
  if (attack === 'extra-output') { const saved = JSON.parse(fs.readFileSync(f.file)); saved.rawText = 'private'; fs.writeFileSync(f.file, canonicalJson(saved) + '\n'); }
  const restarted = new journalModule.ChromeReviewJournal({ projectRoot: f.projectRoot, restartId: OTHER });
  await assert.rejects(restarted.recover());
});
