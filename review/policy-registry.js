import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Json } from './canonical-json.js';

// Canonical strings keep the module-private policy snapshots immutable.
// Every public result is detached from both the registry and caller input.
const policies = new Map([
  [1, canonicalJson(JSON.parse(readFileSync(new URL('../policy/review-policy.v1.json', import.meta.url), 'utf8')))],
  [2, canonicalJson(JSON.parse(readFileSync(new URL('../policy/review-policy.v2.json', import.meta.url), 'utf8')))],
]);

export function loadReviewPolicy(version) {
  const policy = policies.get(version);
  if (!policy) throw new TypeError('Unsupported review policy version');
  return JSON.parse(policy);
}

export function reviewPolicyDigest(version) {
  return sha256Json(loadReviewPolicy(version));
}

export function assertSupportedReviewPolicy(value) {
  // Observe untrusted input once, then return a trusted snapshot rather than
  // cloning input again (accessors could change between validation and use).
  const snapshot = canonicalJson(value);
  for (const [version, policy] of policies) {
    if (snapshot === policy) return loadReviewPolicy(version);
  }
  throw new TypeError('Unsupported review policy snapshot');
}
