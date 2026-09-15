import { assertSupportedReviewPolicy, loadReviewPolicy } from './policy-registry.js';

const historical = loadReviewPolicy(1);
export function transitionReview(from, to, policy = historical) {
  const table = assertSupportedReviewPolicy(policy).stateTransitions;
  if (from === null ? to === 'available' : Object.hasOwn(table, from) && table[from].includes(to)) return to;
  throw new Error('Forbidden review transition');
}

export const terminalReview = (state, policy = historical) => {
  const table = assertSupportedReviewPolicy(policy).stateTransitions;
  return Object.hasOwn(table, state) && table[state].length === 0;
};
