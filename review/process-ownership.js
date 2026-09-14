import path from 'node:path';
import { sha256Bytes, sha256Json } from './canonical-json.js';
import { sanitizeEvidence } from './redaction.js';

const PARENTS = Object.freeze({ chrome: null, bootstrap: 'chrome', 'active-host': 'bootstrap', 'sidecar-codex': 'active-host', verifier: 'bootstrap' });
const fail = () => { throw new TypeError('Invalid macOS evidence'); };
export const pathIdentity = value => `path-sha256:${sha256Bytes(value)}`;
export const SAMPLE_SYMBOLS = Object.freeze(['read', 'poll', 'kevent', 'mach_msg_trap', 'mach_msg2_trap', '__psynch_cvwait']);

function record(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => !fields.includes(key))) fail();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
}
function requiredRecord(value, required, optional = []) {
  record(value, [...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key))) fail();
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f]/.test(value) || path.normalize(value) !== value) fail();
}

function array(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let i = 0; i < value.length; i++) if (!descriptors[i] || !Object.hasOwn(descriptors[i], 'value') || !descriptors[i].enumerable) fail();
}

// Policy is supplied only by the trusted orchestrator, never inferred from ps
// output or candidate data. The role graph cannot be weakened by its caller.
export function assertOwnershipPolicy(policy) {
  record(policy, ['phase', 'chromeExited', 'processes', 'expectedChrome']);
  if (!['before', 'verification', 'after'].includes(policy.phase) || typeof policy.chromeExited !== 'boolean' || (policy.chromeExited && policy.phase !== 'after')) fail();
  record(policy.expectedChrome, ['executablePath', 'identifier', 'teamId', 'cdpPorts']);
  absolute(policy.expectedChrome.executablePath);
  if (typeof policy.expectedChrome.identifier !== 'string' || typeof policy.expectedChrome.teamId !== 'string' || !/^[a-zA-Z0-9.-]{1,200}$/.test(policy.expectedChrome.identifier) || !/^[A-Z0-9]{10}$/.test(policy.expectedChrome.teamId)) fail();
  array(policy.expectedChrome.cdpPorts);
  if (!Array.isArray(policy.expectedChrome.cdpPorts) || policy.expectedChrome.cdpPorts.length > 16 || policy.expectedChrome.cdpPorts.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) fail();
  if (!Array.isArray(policy.processes) || policy.processes.length < 4 || policy.processes.length > 5) fail();
  array(policy.processes);
  const names = new Set(); const pids = new Set();
  for (const process of policy.processes) {
    record(process, ['pid', 'name', 'parent', 'executablePath', 'startTime']);
    if (!Number.isSafeInteger(process.pid) || process.pid < 1 || process.pid > 2147483647 || pids.has(process.pid) || names.has(process.name) || !Object.hasOwn(PARENTS, process.name) || process.parent !== PARENTS[process.name]) fail();
    absolute(process.executablePath);
    if (process.startTime !== undefined && !validStartTime(process.startTime)) fail();
    pids.add(process.pid); names.add(process.name);
  }
  for (const name of ['chrome', 'bootstrap', 'active-host', 'sidecar-codex']) if (!names.has(name)) fail();
  if (policy.phase === 'verification' && !names.has('verifier')) fail();
  if (policy.phase === 'before' && names.has('verifier')) fail();
  if (policy.processes.find(p => p.name === 'chrome').executablePath !== policy.expectedChrome.executablePath) fail();
  return policy;
}

export function validStartTime(value) {
  return typeof value === 'string' && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value);
}

export function validElapsedTime(value) {
  return typeof value === 'string' && /^(?:\d+-\d{2}:|\d+:)?\d{1,2}:[0-5]\d$/.test(value);
}

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fileIdentity = value => typeof value === 'string' && /^path-sha256:[a-f0-9]{64}$/.test(value);
const descriptorNumber = value => Number.isSafeInteger(value) && value >= 0;

function assertProcessShape(process) {
  const base = ['pid', 'name', 'present'];
  if (!process.present) { requiredRecord(process, base); return; }
  requiredRecord(process, [...base, 'ppid', 'pgid', 'startTime', 'elapsedTime', 'executablePath', 'executable', 'executableDigest', 'cwd', 'signing', 'descriptors', 'endpoints', 'listeners', 'checks', 'sampleDigest']);
  if (!descriptorNumber(process.ppid) || !Number.isSafeInteger(process.pgid) || process.pgid < 1 || !validStartTime(process.startTime) || !validElapsedTime(process.elapsedTime) || typeof process.executablePath !== 'string' || !digest(process.executableDigest) || !fileIdentity(process.cwd)) fail();
  requiredRecord(process.executable, ['path', 'sha256']);
  if (!fileIdentity(process.executable.path) || !digest(process.executable.sha256)) fail();
  requiredRecord(process.signing, ['passed', 'authority'], ['identifier', 'teamId', 'cdHash']);
  if (typeof process.signing.passed !== 'boolean' || !Array.isArray(process.signing.authority) || process.signing.authority.some(value => typeof value !== 'string')) fail();
  for (const key of ['identifier', 'teamId', 'cdHash']) if (Object.hasOwn(process.signing, key) && typeof process.signing[key] !== 'string') fail();
  if (!Array.isArray(process.descriptors) || !Array.isArray(process.endpoints) || !Array.isArray(process.listeners) || !Array.isArray(process.checks)) fail();
  const seenDescriptors = new Map();
  for (const descriptor of process.descriptors) {
    requiredRecord(descriptor, ['fd', 'type']);
    if (!descriptorNumber(descriptor.fd) || !['PIPE', 'unix'].includes(descriptor.type) || seenDescriptors.has(descriptor.fd)) fail();
    seenDescriptors.set(descriptor.fd, descriptor.type);
  }
  const seenEndpoints = new Set();
  for (const endpoint of process.endpoints) {
    requiredRecord(endpoint, ['fd', 'type', 'target', 'transport']);
    if (!descriptorNumber(endpoint.fd) || seenEndpoints.has(endpoint.fd) || seenDescriptors.get(endpoint.fd) !== endpoint.type || !/^(?:->)?0x[a-fA-F0-9]+$/.test(endpoint.target)) fail();
    const transport = endpoint.fd <= 2 ? 'anonymous-stdio' : endpoint.type === 'PIPE' ? 'anonymous-pipe' : 'anonymous-unix';
    if (endpoint.transport !== transport) fail();
    seenEndpoints.add(endpoint.fd);
  }
  const seenListeners = new Set();
  for (const listener of process.listeners) {
    requiredRecord(listener, ['fd', 'protocol', 'address', 'port', 'transport']);
    if (!descriptorNumber(listener.fd) || seenListeners.has(listener.fd) || listener.protocol !== 'TCP' || typeof listener.address !== 'string' || !Number.isInteger(listener.port) || listener.port < 0 || listener.port > 65535 || !['tcp', 'chrome-loopback-cdp'].includes(listener.transport)) fail();
    seenListeners.add(listener.fd);
  }
  if (process.checks.length !== SAMPLE_SYMBOLS.length) fail();
  for (const [index, sample] of process.checks.entries()) {
    requiredRecord(sample, ['name', 'actual']);
    if (sample.name !== `sample-${SAMPLE_SYMBOLS[index].replaceAll('_', '-')}` || !Number.isSafeInteger(sample.actual) || sample.actual < 0) fail();
  }
  if (!digest(process.sampleDigest) || process.sampleDigest !== sha256Json({ checks: process.checks })) fail();
}

export function verifyOwnershipTopology(evidence, policy) {
  assertOwnershipPolicy(policy);
  const safe = sanitizeEvidence(evidence);
  requiredRecord(safe, ['schemaVersion', 'status', 'macOSVersion', 'architecture', 'bootSessionUUID', 'processes', 'checks'], ['sessionFileIdentity', 'passed']);
  if (safe.schemaVersion !== 1 || safe.status !== policy.phase || !Array.isArray(safe.processes) || safe.processes.length !== policy.processes.length) fail();
  if (!/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(safe.macOSVersion) || !['arm64', 'x86_64'].includes(safe.architecture) || !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(safe.bootSessionUUID)) fail();
  const checks = [];
  const check = (name, passed, reasonCode) => checks.push({ name, passed, reasonCode: passed ? 'verified' : reasonCode });
  if (!Array.isArray(safe.checks)) fail();
  for (const entry of safe.checks) {
    requiredRecord(entry, ['name', 'passed', 'reasonCode']);
    if (typeof entry.passed !== 'boolean') fail();
  }
  for (const expected of policy.processes) {
    const stable = safe.checks.filter(entry => entry.name === `${expected.name}-stable`);
    if (stable.length !== 1 || stable[0].reasonCode !== (stable[0].passed ? 'verified' : 'process-changed')) fail();
  }
  const observed = new Map();
  for (const process of safe.processes) {
    if (observed.has(process.name) || !policy.processes.some(p => p.name === process.name && p.pid === process.pid) || typeof process.present !== 'boolean') fail();
    assertProcessShape(process);
    observed.set(process.name, process);
  }
  for (const expected of policy.processes) {
    const process = observed.get(expected.name);
    if (!process) fail();
    if (policy.chromeExited) {
      check(`${expected.name}-absent`, !process.present, 'process-survived');
      continue;
    }
    check(`${expected.name}-present`, process.present, 'process-absent');
    if (!process.present) continue;
    check(`${expected.name}-identity`, process.executablePath === pathIdentity(expected.executablePath) && /^[a-f0-9]{64}$/.test(process.executableDigest ?? '') && validStartTime(process.startTime) && (!expected.startTime || expected.startTime === process.startTime), 'process-identity');
    check(`${expected.name}-facts`, Number.isSafeInteger(process.ppid) && Number.isSafeInteger(process.pgid) && process.pgid > 0 && /^path-sha256:[a-f0-9]{64}$/.test(process.cwd ?? '') && Array.isArray(process.listeners) && Array.isArray(process.endpoints) && /^[a-f0-9]{64}$/.test(process.sampleDigest ?? ''), 'process-facts-missing');
    if (expected.parent) check(`${expected.name}-parent`, observed.get(expected.parent)?.present === true && process.ppid === observed.get(expected.parent)?.pid, 'wrong-parent');
    if (expected.name === 'verifier') check('verifier-isolated', process.pgid === process.pid && process.pgid !== observed.get('active-host')?.pgid && process.pgid !== observed.get('sidecar-codex')?.pgid, 'verifier-not-isolated');
    if (expected.name === 'chrome') {
      check('chrome-signing', process.signing?.passed === true && process.signing.identifier === policy.expectedChrome.identifier && process.signing.teamId === policy.expectedChrome.teamId, 'chrome-signing-mismatch');
      check('chrome-listeners', Array.isArray(process.listeners) && process.listeners.every(l => l.protocol === 'TCP' && ['127.0.0.1', '::1'].includes(l.address) && policy.expectedChrome.cdpPorts.includes(l.port) && l.transport === 'chrome-loopback-cdp'), 'unexpected-chrome-listener');
    } else check(`${expected.name}-listeners`, Array.isArray(process.listeners) && process.listeners.length === 0, 'sidecar-listener');
  }
  // Collector checks carry race detection, never approval authority. A false
  // collector check must survive recomputation by downstream consumers.
  if (safe.checks?.some(c => !c.passed)) check('collection-stable', false, 'process-changed');
  return sanitizeEvidence({ passed: checks.every(c => c.passed), checks });
}
