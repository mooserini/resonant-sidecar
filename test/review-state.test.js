import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionReview, terminalReview } from '../review/review-state.js';
import { loadReviewPolicy } from '../review/policy-registry.js';

// Literal approved graph: removing an edge or permitting a shortcut is a bug.
const graph = {
  available: ['staged', 'custody-broken'], staged: ['deterministic-review', 'review-failed', 'custody-broken'],
  'deterministic-review': ['codex-review', 'review-failed', 'custody-broken'],
  'codex-review': ['eligible', 'review-failed', 'custody-broken'], eligible: ['human-accepted', 'rejected', 'custody-broken'],
  'human-accepted': ['activating', 'custody-broken'], activating: ['activated', 'activation-failed', 'custody-broken'],
  'activation-failed': ['rolling-back', 'custody-broken'], 'rolling-back': ['rolled-back', 'custody-broken'],
  activated: [], 'review-failed': [], rejected: [], 'rolled-back': [], 'custody-broken': [],
};
for (const from of Object.keys(graph)) for (const to of Object.keys(graph)) {
  test(`${from} -> ${to}: ${graph[from].includes(to) ? 'permitted' : 'forbidden'}`, () => {
    if (graph[from].includes(to)) assert.equal(transitionReview(from, to), to);
    else assert.throws(() => transitionReview(from, to), /transition/);
  });
}
test('only available can initialize a review', () => {
  assert.equal(transitionReview(null, 'available'), 'available');
  for (const to of Object.keys(graph).filter(s => s !== 'available')) assert.throws(() => transitionReview(null, to), /transition/);
  assert.throws(() => transitionReview('toString', 'available'), /transition/);
});

test('V2 requires Chrome review and preserves the historical V1 shortcut', () => {
  const v2 = loadReviewPolicy(2);
  assert.throws(() => transitionReview('codex-review', 'eligible', v2), /transition/);
  assert.equal(transitionReview('codex-review', 'chrome-semantic-review', v2), 'chrome-semantic-review');
  for (const next of ['eligible', 'review-failed', 'custody-broken']) assert.equal(transitionReview('chrome-semantic-review', next, v2), next);
  assert.equal(terminalReview('chrome-semantic-review', v2), false);
  assert.equal(transitionReview('codex-review', 'eligible'), 'eligible');
});
