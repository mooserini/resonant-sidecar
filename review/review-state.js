import { readFileSync } from 'node:fs';

const table = JSON.parse(readFileSync(new URL('../policy/review-policy.v1.json', import.meta.url), 'utf8')).stateTransitions;
export function transitionReview(from, to) {
  if (from === null ? to === 'available' : Object.hasOwn(table, from) && table[from].includes(to)) return to;
  throw new Error('Forbidden review transition');
}

export const terminalReview = state => Object.hasOwn(table, state) && table[state].length === 0;
