import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadReviewPolicy, reviewPolicyDigest } from '../review/policy-registry.js';

const v1 = JSON.parse(await readFile(new URL('./fixtures/receipts/v1/review-receipts/2026-09-14T00-00-00.000Z_v1-golden/receipt.json', import.meta.url)));
const semanticFile = 'semantic-reviews/chrome-language-model.json';
async function layout(policy, event) {
  const module = await import('../review/receipt-layout.js');
  return module.receiptLayoutFor(policy, event);
}
function v2(eventType = 'available', semanticReviewsHash = null) {
  return { ...v1, eventType, outcome: eventType, policySnapshotHash: reviewPolicyDigest(2), semanticReviewsHash };
}

test('recorded policy and fixed event select exact immutable V1 and V2 layouts', async () => {
  const old = await layout(loadReviewPolicy(1), v1);
  const before = await layout(loadReviewPolicy(2), v2());
  const terminal = await layout(loadReviewPolicy(2), v2('eligible', 'f'.repeat(64)));
  assert.deepEqual(old.files, before.files);
  assert.deepEqual(terminal.files, [...before.files, semanticFile].sort());
  assert.equal(old.files.length, 13);
  assert.equal(old.directories.includes('semantic-reviews'), false);
  assert.equal(before.directories.includes('semantic-reviews'), false);
  assert.equal(terminal.directories.includes('semantic-reviews'), true);
  assert.equal(typeof terminal.validateSemanticReview, 'function');
  assert.throws(() => terminal.files.push('untrusted.json'), TypeError);
  assert.throws(() => before.validateReceipt(v2('eligible', 'f'.repeat(64))), TypeError);
});

test('layout rejects unknown policy, wrong event shape, hash type and policy binding', async () => {
  const altered = loadReviewPolicy(2); altered.stateTransitions.available.push('eligible');
  const cases = [
    [altered, v2()], [loadReviewPolicy(2), v1], [loadReviewPolicy(1), v2()],
    [loadReviewPolicy(2), { ...v2(), policySnapshotHash: reviewPolicyDigest(1) }],
    [loadReviewPolicy(2), { ...v2(), extra: 'candidate hint' }],
    [loadReviewPolicy(2), v2('invented')], [loadReviewPolicy(2), v2('available', '')],
    [loadReviewPolicy(2), v2('eligible')], [loadReviewPolicy(2), v2('chrome-semantic-review', 'f'.repeat(64))],
  ];
  for (const [policy, event] of cases) await assert.rejects(() => layout(policy, event), TypeError);
});
