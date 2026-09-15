import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256Bytes, sha256Json } from '../review/canonical-json.js';

// Pin the approved graph independently: shortcuts, omissions, and extra edges fail.
const v2Graph = {
  available: ['staged', 'custody-broken'],
  staged: ['deterministic-review', 'review-failed', 'custody-broken'],
  'deterministic-review': ['codex-review', 'review-failed', 'custody-broken'],
  'codex-review': ['chrome-semantic-review', 'review-failed', 'custody-broken'],
  'chrome-semantic-review': ['eligible', 'review-failed', 'custody-broken'],
  eligible: ['human-accepted', 'rejected', 'custody-broken'],
  'human-accepted': ['activating', 'custody-broken'],
  activating: ['activated', 'activation-failed', 'custody-broken'],
  'activation-failed': ['rolling-back', 'custody-broken'],
  'rolling-back': ['rolled-back', 'custody-broken'],
  activated: [], 'review-failed': [], rejected: [], 'rolled-back': [], 'custody-broken': [],
};

// Final bootstrap graph plus stable delivery files, already bytewise sorted.
// This literal intentionally includes future modules; never discover paths at runtime.
const trustedControlPaths = [
  'bootstrap/chrome-review-journal.js',
  'bootstrap/host.js',
  'bootstrap/native-proxy.js',
  'bootstrap/recovery-state.js',
  'bootstrap/runtime-lock.js',
  'bootstrap/version-store.js',
  'extension/chrome-review-adapter.js',
  'extension/chrome-review-contract.js',
  'extension/manifest.json',
  'extension/service-worker.js',
  'extension/sidepanel-controller.js',
  'extension/sidepanel.css',
  'extension/sidepanel.html',
  'extension/sidepanel.js',
  'native-host/native-framing.js',
  'native-host/sidecar-protocol.js',
  'policy/chrome-language-model.v2.schema.json',
  'policy/codex-attestation.v1.schema.json',
  'policy/review-policy.v1.json',
  'policy/review-policy.v2.json',
  'presentation/desktop-handoff.js',
  'presentation/macos-dialog.js',
  'review/bundle-manifest.js',
  'review/candidate-source.js',
  'review/canonical-json.js',
  'review/capability-diff.js',
  'review/chrome-provenance.js',
  'review/chrome-review-bridge.js',
  'review/chrome-review-contract.js',
  'review/chrome-review.js',
  'review/codex-prompt.js',
  'review/codex-verifier.js',
  'review/decision-nonce.js',
  'review/deterministic-verifier.js',
  'review/git-runner.js',
  'review/macos-evidence.js',
  'review/policy-registry.js',
  'review/process-ownership.js',
  'review/receipt-layout.js',
  'review/receipt-store.js',
  'review/redaction.js',
  'review/review-coordinator.js',
  'review/review-state.js',
  'review/semantic-evidence.js',
  'review/source-diff.js',
  'review/trusted-harness.js',
  'scripts/build-initial-bundle.js',
  'scripts/install-macos.js',
  'scripts/verify-install-plan.js',
];

const analysisSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'outcome', 'summary', 'findings'],
  properties: {
    schemaVersion: { const: 2 },
    outcome: { enum: ['no-blocking-concern', 'blocking-concern', 'inconclusive'] },
    summary: { type: 'string', maxLength: 2000 },
    findings: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'category', 'file', 'location', 'explanation'],
        properties: {
          severity: { enum: ['important', 'caution', 'observation'] },
          category: { enum: ['behavior', 'dependency', 'capability', 'provenance', 'coverage', 'other'] },
          file: { type: 'string', maxLength: 512 },
          location: { type: ['string', 'null'], maxLength: 128 },
          explanation: { type: 'string', maxLength: 1000 },
        },
      },
    },
  },
};

async function registry() {
  let result;
  await assert.doesNotReject(async () => {
    result = await import('../review/policy-registry.js');
  }, 'Versioned review policy contract must be available');
  return result;
}

test('V1 policy retains its approved canonical digest and original bytes', async () => {
  const { loadReviewPolicy, reviewPolicyDigest } = await registry();
  const bytes = readFileSync(new URL('../policy/review-policy.v1.json', import.meta.url));
  assert.equal(reviewPolicyDigest(1), '2c800a3dbb7520e37129213f0dabb648bca6cde03ed3180c91faee1f868f0821');
  assert.deepEqual(loadReviewPolicy(1), JSON.parse(bytes));
  assert.equal(sha256Bytes(bytes), '2c55a5207e0ba01fc8ff2b68e24106875467d79c0945bcd861afdfda711332fa');
});

test('V2 requires both semantic review stages with the exact approved graph', async () => {
  const { loadReviewPolicy, reviewPolicyDigest } = await registry();
  const policy = loadReviewPolicy(2);
  assert.equal(policy.schemaVersion, 2);
  assert.deepEqual(policy.stateTransitions, v2Graph);
  assert.deepEqual(policy.semanticReviewers, [
    { id: 'codex-cli', required: true },
    { id: 'chrome-language-model', required: true, modelIdentityAssurance: 'not-attested' },
  ]);
  assert.equal(reviewPolicyDigest(2), sha256Json(policy));
  assert.notEqual(reviewPolicyDigest(2), reviewPolicyDigest(1));
});

test('V2 freezes all application ceilings and the exact control-plane inventory', async () => {
  const { loadReviewPolicy } = await registry();
  const policy = loadReviewPolicy(2);
  assert.deepEqual(policy.applicationLimits, {
    maxEvidencePacketBytes: 131072,
    maxRawModelOutputBytes: 65536,
    maxOutstandingChromeInvocations: 1,
    readyToResultExpiryMs: 600000,
    inferenceTimeoutMs: 60000,
    automaticRetries: 0,
  });
  assert.deepEqual(policy.trustedControlPaths, trustedControlPaths);
});

test('V2 references the exact bounded Chrome analysis schema', async () => {
  const { loadReviewPolicy } = await registry();
  const policy = loadReviewPolicy(2);
  assert.equal(policy.chromeAnalysisSchema, 'policy/chrome-language-model.v2.schema.json');
  assert.deepEqual(JSON.parse(readFileSync(new URL(`../${policy.chromeAnalysisSchema}`, import.meta.url))), analysisSchema);
});

test('V2 preserves every unrelated V1 capability, runtime, receipt, and test contract', async () => {
  const { loadReviewPolicy } = await registry();
  const v1 = loadReviewPolicy(1);
  const v2 = loadReviewPolicy(2);
  for (const key of Object.keys(v1).filter(key => !['schemaVersion', 'stateTransitions'].includes(key))) {
    assert.deepEqual(v2[key], v1[key], key);
  }
});

test('version selection rejects unsupported values without coercion', async () => {
  const { loadReviewPolicy, reviewPolicyDigest } = await registry();
  for (const version of [undefined, null, 0, 3, -1, 1.5, '1', '2', true, {}, NaN, Infinity]) {
    assert.throws(() => loadReviewPolicy(version), TypeError);
    assert.throws(() => reviewPolicyDigest(version), TypeError);
  }
});

test('supported-policy assertion accepts reordered exact snapshots and returns detached values', async () => {
  const { loadReviewPolicy, reviewPolicyDigest, assertSupportedReviewPolicy } = await registry();
  for (const version of [1, 2]) {
    const original = loadReviewPolicy(version);
    const digest = reviewPolicyDigest(version);
    const supplied = Object.fromEntries(Object.entries(structuredClone(original)).reverse());
    const accepted = assertSupportedReviewPolicy(supplied);
    assert.deepEqual(accepted, original);
    assert.notEqual(accepted, supplied);
    supplied.stateTransitions['codex-review'].push('activated');
    assert.deepEqual(accepted.stateTransitions['codex-review'], original.stateTransitions['codex-review']);
    accepted.stateTransitions['codex-review'].push('activated');
    original.approvedCapabilities.chromePermissions.push('debugger');
    assert.equal(reviewPolicyDigest(version), digest);
    assert.ok(!loadReviewPolicy(version).approvedCapabilities.chromePermissions.includes('debugger'));
    assert.ok(!loadReviewPolicy(version).stateTransitions['codex-review'].includes('activated'));
  }
});

test('supported-policy assertion rejects altered contracts, malformed JSON, and unknown versions', async () => {
  const { loadReviewPolicy, assertSupportedReviewPolicy } = await registry();
  const circular = {}; circular.self = circular;
  const altered = [
    policy => { policy.stateTransitions['codex-review'] = ['eligible']; },
    policy => { policy.semanticReviewers[1].required = false; },
    policy => { policy.applicationLimits.maxEvidencePacketBytes += 1; },
    policy => { policy.trustedControlPaths.pop(); },
    policy => { policy.trustedControlPaths.push('review/unclassified.js'); },
    policy => { policy.schemaVersion = 3; },
    policy => { policy.extra = true; },
    policy => { delete policy.runtimeContract; },
  ];
  for (const change of altered) {
    const policy = loadReviewPolicy(2); change(policy);
    assert.throws(() => assertSupportedReviewPolicy(policy), TypeError);
  }
  for (const value of [null, undefined, 2, '2', [], {}, new Date(), circular, { schemaVersion: 2, bad: undefined }]) {
    assert.throws(() => assertSupportedReviewPolicy(value), TypeError);
  }
});

test('untrusted accessor changes cannot alter a validated returned snapshot', async () => {
  const { loadReviewPolicy, assertSupportedReviewPolicy } = await registry();
  const original = loadReviewPolicy(2);
  const supplied = loadReviewPolicy(2);
  let reads = 0;
  Object.defineProperty(supplied, 'schemaVersion', { enumerable: true, get() { return ++reads === 1 ? 2 : 99; } });
  assert.deepEqual(assertSupportedReviewPolicy(supplied), original);
  assert.equal(reads, 1);
});
