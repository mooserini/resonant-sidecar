import { types } from 'node:util';
import { canonicalJson, sha256Json } from './canonical-json.js';
import { buildChromeReviewRequest } from './semantic-evidence.js';
import { buildChromeProvenance } from './chrome-provenance.js';
import { freezeReviewValue, parseChromeAnalysis, snapshotChromeReviewValue } from './chrome-review-contract.js';

function requireBinding(condition) {
  if (!condition) throw new TypeError('Chrome review binding schema rejected');
}

/** Revalidate the raw output at the trusted native boundary. This produces a
 * bound analysis, not acceptance, a receipt, or Codex process evidence. Channel
 * ownership, invocation journaling and receipt lifecycle belong to the caller. */
export function bindChromeReviewResult(input) {
  requireBinding(input !== null && typeof input === 'object' && !types.isProxy(input) && Object.getPrototypeOf(input) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expected = ['request', 'rawText', 'browserObservation', 'componentObservation', 'completedAt'];
  const keys = Reflect.ownKeys(descriptors);
  requireBinding(keys.length === expected.length && keys.every(key => expected.includes(key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable));
  const rawText = descriptors.rawText.value;
  const value = snapshotChromeReviewValue(Object.fromEntries(keys.filter(key => key !== 'rawText').map(key => [key, descriptors[key].value])));
  const request = value.request;
  requireBinding(request?.type === 'ReadyChromeReviewRequest');
  const packet = request.packet;
  requireBinding(packet !== null && typeof packet === 'object');
  // Rebuild all digests, the complete evidence and the exact transport envelope.
  // A cached browser analysis or a forged Ready type cannot bypass this gate.
  const verified = buildChromeReviewRequest({
    evidence: packet.evidence, evidenceDigest: packet.evidenceDigest,
    invocationId: packet.invocationId, runtimeGeneration: packet.runtimeGeneration,
    adapterDigest: packet.adapterDigest, deadline: packet.deadline,
  });
  requireBinding(verified.type === 'ReadyChromeReviewRequest' && canonicalJson(request) === canonicalJson(verified));
  const completedAt = value.completedAt;
  requireBinding(typeof completedAt === 'string' && Number.isFinite(Date.parse(completedAt)) && new Date(completedAt).toISOString() === completedAt);
  requireBinding(Date.parse(completedAt) <= Date.parse(packet.deadline));
  const provenance = buildChromeProvenance({ browserObservation: value.browserObservation, componentObservation: value.componentObservation });
  for (const observation of [provenance.browserObservation, provenance.componentObservation]) {
    requireBinding(observation.observedAt === null || Date.parse(observation.observedAt) <= Date.parse(completedAt));
  }
  const source = verified.packet.evidence.sourceDiff;
  const suppliedFiles = source.changedFiles.map(file => file.path);
  const suppliedLocations = source.coverage.flatMap(file => ['before', 'after'].flatMap(side =>
    file[side] === null ? [] : file[side].ranges.map(([start, end]) => ({ file: file.path, location: `${side}:${start}-${end}` }))));
  const analysis = parseChromeAnalysis(rawText, { suppliedFiles, suppliedLocations, maxBytes: verified.packet.evidence.policy.applicationLimits.maxRawModelOutputBytes });
  return freezeReviewValue({
    type: 'ChromeReviewResult', schemaVersion: 2, transportBinding: verified.transportBinding,
    ...provenance, completedAt, analysis, analysisDigest: sha256Json(analysis),
  });
}
