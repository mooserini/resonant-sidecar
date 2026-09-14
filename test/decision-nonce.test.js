import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeFixture } from './fixtures/runtime.js';
import { DecisionNonces } from '../review/decision-nonce.js';

const binding = { reviewId: 'review-1', candidateDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), action: 'accept' };
test('nonce dependency construction is read-only before the coordinator checks receipt custody', async t => {
  const f = await runtimeFixture(t); new DecisionNonces({ root: f.root });
  assert.equal(fs.existsSync(path.join(f.root, 'review-decisions')), false);
});
test('single-use decision binds every field and persists no raw nonce', async t => {
  const f = await runtimeFixture(t); const vault = new DecisionNonces({ root: f.root });
  const decision = vault.issue(binding, { threadId: 'thread-1' });
  for (const field of ['reviewId', 'candidateDigest', 'policyDigest', 'action', 'nonce']) {
    assert.throws(() => vault.consume({ ...decision, [field]: field.endsWith('Digest') ? 'c'.repeat(64) : 'changed' }), /binding|decision/);
  }
  const proof = vault.consume(decision);
  assert.equal(proof.consumed, true);
  assert.throws(() => vault.consume(decision), /consumed/);
  const files = fs.readdirSync(path.join(f.root, 'review-decisions')).filter(n => n.endsWith('.json'));
  for (const file of files) assert.equal(fs.readFileSync(path.join(f.root, 'review-decisions', file), 'utf8').includes(decision.nonce), false);
  const restarted = new DecisionNonces({ root: f.root });
  assert.equal(restarted.recover(proof.nonceDigest).threadId, 'thread-1');
});
test('restart invalidates unconsumed decisions and expiry blocks consume and resume', async t => {
  const f = await runtimeFixture(t); let now = 1000;
  const vault = new DecisionNonces({ root: f.root, clock: () => now, ttlMs: 50 });
  const first = vault.issue(binding, { threadId: 'thread-1' });
  assert.throws(() => new DecisionNonces({ root: f.root, clock: () => now }).consume(first), /restart/);
  now = 1050; assert.throws(() => vault.consume(first), /expired/);
  const next = vault.issue(binding, { threadId: 'thread-1' }); const proof = vault.consume(next);
  now = 1100; assert.throws(() => vault.recover(proof.nonceDigest), /expired/);
});
test('accessors, extra fields, and weak entropy are refused', async t => {
  const f = await runtimeFixture(t); const vault = new DecisionNonces({ root: f.root });
  const d = vault.issue(binding, { threadId: 'thread-1' }); let invoked = false;
  assert.throws(() => vault.consume({ ...d, get action() { invoked = true; return 'accept'; } }), /decision/);
  assert.equal(invoked, false); assert.throws(() => vault.consume({ ...d, path: '/tmp' }), /decision/);
  assert.throws(() => new DecisionNonces({ root: f.root, randomBytes: () => Buffer.alloc(1) }).issue(binding), /entropy/);
});
test('replacing the nonce directory with a symlink cannot redirect consumption', async t => {
  const f = await runtimeFixture(t); const vault = new DecisionNonces({ root: f.root });
  const d = vault.issue(binding); const root = path.join(f.root, 'review-decisions'); const saved = path.join(f.root, 'saved-decisions');
  fs.renameSync(root, saved); fs.symlinkSync(saved, root);
  assert.throws(() => vault.consume(d), /custody/);
  assert.equal(fs.readdirSync(saved).length, 1);
});
