import { canonicalJson } from '../review/canonical-json.js';

const digest = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function assertPin(pin) {
  if (!pin || Object.keys(pin).sort().join(',') !== 'digest,reviewId,schemaVersion' || pin.schemaVersion !== 1 || !digest.test(pin.digest) || !id.test(pin.reviewId)) throw new Error('Invalid canonical pin');
  return pin;
}

export function assertDecision(d) {
  if (!d || Object.keys(d).sort().join(',') !== 'action,candidateDigest,nonce,policyDigest,reviewId' || d.action !== 'accept' || !id.test(d.reviewId) || !digest.test(d.candidateDigest) || !digest.test(d.policyDigest) || typeof d.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(d.nonce)) throw new Error('Invalid decision');
  return d;
}

export function snapshotDecision(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid decision');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !Object.hasOwn(fields[key], 'value') || !fields[key].enumerable)) throw new Error('Invalid decision fields');
  const snapshot = Object.fromEntries(Object.entries(fields).map(([key, descriptor]) => [key, descriptor.value]));
  assertDecision(snapshot);
  return Object.freeze(snapshot);
}

export function recoverInterruptedActivation(state) {
  if (state === null) return { action: 'none' };
  try {
    if (Object.keys(state).sort().join(',') !== 'candidate,decisionHash,failureRef,phase,previous,priorPrevious,schemaVersion' || state.schemaVersion !== 1 || !digest.test(state.decisionHash)) throw new Error();
    assertPin(state.candidate);
    if (state.previous !== null) assertPin(state.previous);
    if (state.priorPrevious !== null) assertPin(state.priorPrevious);
    if (state.failureRef !== null && (typeof state.failureRef !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(state.failureRef))) throw new Error();
    if (['complete', 'rolled-back'].includes(state.phase)) return { action: 'none' };
    if (!['prepared', 'previous-written', 'active-written', 'pending-verification', 'rolling-back'].includes(state.phase)) throw new Error();
    return { action: 'rollback', pin: state.previous };
  } catch { throw new Error('Invalid recovery state'); }
}

export const samePin = (a, b) => canonicalJson(a) === canonicalJson(b);
