import { freezeReviewValue, snapshotChromeReviewValue } from './chrome-review-contract.js';

function requireObservation(condition) {
  if (!condition) throw new TypeError('Chrome provenance observation schema rejected');
}

function exact(value, keys) {
  requireObservation(value !== null && typeof value === 'object' && !Array.isArray(value));
  const actual = Object.keys(value);
  requireObservation(actual.length === keys.length && actual.every(key => keys.includes(key)));
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function digest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function version(value) { return typeof value === 'string' && value.length <= 100 && /^[0-9]+(?:\.[0-9]+){1,4}(?:[-+][A-Za-z0-9.-]+)?$/.test(value); }

/** Trusted caller observations only; model output never enters this function.
 * Metadata describes inspected components, not the weights behind inference. */
export function buildChromeProvenance(input) {
  const value = snapshotChromeReviewValue(input);
  exact(value, ['browserObservation', 'componentObservation']);
  const browser = value.browserObservation;
  const component = value.componentObservation;
  exact(browser, ['executableSha256', 'version', 'signingIdentity', 'observedAt', 'unavailableFields']);
  requireObservation(timestamp(browser.observedAt));
  requireObservation(browser.executableSha256 === null || digest(browser.executableSha256));
  requireObservation(browser.version === null || version(browser.version));
  requireObservation(browser.signingIdentity === null || (typeof browser.signingIdentity === 'string' && /^[A-Za-z0-9][A-Za-z0-9 .:()_-]{0,199}$/.test(browser.signingIdentity)));
  requireObservation(Array.isArray(browser.unavailableFields));
  const missing = ['executableSha256', 'version', 'signingIdentity'].filter(key => browser[key] === null);
  requireObservation(browser.unavailableFields.length === missing.length && new Set(browser.unavailableFields).size === missing.length && browser.unavailableFields.every(key => missing.includes(key)));
  // Canonicalize a set without freezing or otherwise changing caller objects.
  browser.unavailableFields.sort();
  exact(component, ['status', 'metadataSource', 'version', 'artifactSha256', 'observedAt']);
  requireObservation(['observed', 'not-exposed', 'not-collected'].includes(component.status));
  const sources = ['chrome-component-metadata', 'chrome-language-model-api', 'trusted-local-inspection'];
  if (component.status === 'not-collected') {
    requireObservation(component.metadataSource === null && component.version === null && component.artifactSha256 === null && component.observedAt === null);
  } else {
    requireObservation(sources.includes(component.metadataSource) && timestamp(component.observedAt));
    if (component.status === 'not-exposed') requireObservation(component.version === null && component.artifactSha256 === null);
    else {
      requireObservation(component.version !== null || component.artifactSha256 !== null);
      requireObservation(component.version === null || version(component.version));
      requireObservation(component.artifactSha256 === null || digest(component.artifactSha256));
    }
  }
  return freezeReviewValue({
    reviewerId: 'chrome-language-model', provenanceKind: 'observed-local-components',
    modelIdentityAssurance: 'not-attested', inferenceBinding: 'not-established',
    browserObservation: browser, componentObservation: component,
  });
}
