import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSemanticEvidence, buildChromeReviewRequest } from '../../review/semantic-evidence.js';
import { buildSourceDiff } from '../../review/source-diff.js';
import { loadReviewPolicy } from '../../review/policy-registry.js';
import { sha256Json } from '../../review/canonical-json.js';
import { sourceFixture } from './semantic-source.js';

export const CHANNEL = '11111111-1111-4111-8111-111111111111';
export const RESTART = '22222222-2222-4222-8222-222222222222';
export const OTHER = '33333333-3333-4333-8333-333333333333';
export const NOW = Date.parse('2026-09-14T12:00:00.000Z');
export const RAW = JSON.stringify({ schemaVersion: 2, outcome: 'no-blocking-concern', summary: 'No blocking concern.', findings: [] });
export const observations = {
  browserObservation: { executableSha256: null, version: null, signingIdentity: null, observedAt: '2026-09-14T12:00:00.000Z', unavailableFields: ['executableSha256', 'version', 'signingIdentity'] },
  componentObservation: { status: 'not-collected', metadataSource: null, version: null, artifactSha256: null, observedAt: null },
};
export function wireBinding(request, identity = {}) {
  const { activeBundleDigest, candidateBundleDigest, promptId, schemaId, ...binding } = request.transportBinding;
  return { ...binding, activeDigest: activeBundleDigest, candidateDigest: candidateBundleDigest, channelId: CHANNEL, restartId: RESTART, ...identity };
}
export async function bridgeFixture(t, identity = {}) {
  const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chrome-bridge-')));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const files = await sourceFixture(t); const policy = loadReviewPolicy(2);
  const common = buildSemanticEvidence({ reviewId: 'review-chrome', activeManifest: files.activeManifest, candidateManifest: files.candidateManifest, policy,
    deterministic: { passed: true, checks: [{ name: 'schema', passed: true }], policySnapshotHash: sha256Json(policy), activeBundleDigest: files.activeManifest.bundleDigest, candidateBundleDigest: files.candidateManifest.bundleDigest },
    sourceDiff: await buildSourceDiff(files) });
  const request = buildChromeReviewRequest({ ...common, invocationId: 'invocation-chrome', runtimeGeneration: identity.runtimeGeneration ?? 3, adapterDigest: 'a'.repeat(64), deadline: new Date(NOW + 60000).toISOString() });
  const binding = wireBinding(request, identity);
  return { projectRoot, request, binding, packet: request.packet, deadline: binding.deadline,
    current: { channelId: binding.channelId, restartId: binding.restartId, runtimeGeneration: binding.runtimeGeneration, activeDigest: binding.activeDigest } };
}
export async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Test condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
