import fs from 'node:fs';
import path from 'node:path';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { canonicalJson, sha256Bytes, sha256Json } from './canonical-json.js';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const fail = message => { throw new Error(message); };
function snapshot(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('Invalid decision');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !Object.hasOwn(descriptors, key)) || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) fail('Invalid decision fields');
  return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
const bindingFields = ['reviewId', 'candidateDigest', 'policyDigest', 'action'];
function binding(value) {
  const b = snapshot(value, bindingFields);
  if (typeof b.reviewId !== 'string' || !ID.test(b.reviewId) || !['accept', 'reject'].includes(b.action) || ![b.candidateDigest, b.policyDigest].every(d => typeof d === 'string' && HASH.test(d))) fail('Invalid decision binding');
  return b;
}
export function snapshotHumanDecision(value) {
  const d = snapshot(value, [...bindingFields, 'nonce']);
  binding(Object.fromEntries(bindingFields.map(k => [k, d[k]])));
  if (typeof d.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(d.nonce)) fail('Invalid decision nonce');
  return Object.freeze(d);
}
function syncDirectory(directory) { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function concrete(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory) fail('Invalid nonce custody path');
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail('Invalid nonce custody');
  }
}
function privateEntry(file, directory = false) {
  concrete(file); const stat = fs.lstatSync(file);
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('Invalid nonce custody');
  return stat;
}

// Synchronous O_EXCL consumption is the linearization point. No await, rename
// replacement, raw nonce persistence, or mutable convenience index is involved.
export class DecisionNonces {
  #root; #clock; #random; #ttl; #session;
  constructor({ root, clock = Date.now, randomBytes = cryptoRandomBytes, ttlMs = 300000 } = {}) {
    concrete(root); privateEntry(root, true);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3600000) fail('Invalid nonce expiry');
    this.#root = path.join(root, 'review-decisions'); this.#clock = clock; this.#random = randomBytes; this.#ttl = ttlMs;
    this.#session = sha256Bytes(cryptoRandomBytes(32));
    // Dependency construction precedes the coordinator's receipt check. Delay
    // filesystem mutation until issue() is reached through that checked gate.
    if (fs.existsSync(this.#root)) privateEntry(this.#root, true);
  }
  #now() { const now = this.#clock(); if (!Number.isSafeInteger(now) || now < 0) fail('Invalid nonce clock'); return now; }
  #file(hash, used = false) { if (typeof hash !== 'string' || !HASH.test(hash)) fail('Invalid decision binding'); return path.join(this.#root, `${hash}${used ? '.used' : ''}.json`); }
  #write(file, value) {
    privateEntry(this.#root, true);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o400);
    try { fs.writeFileSync(fd, canonicalJson(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(this.#root);
  }
  #read(file) {
    privateEntry(this.#root, true); const stat = privateEntry(file);
    if (stat.size > 4096 || (stat.mode & 0o777) !== 0o400) fail('Invalid nonce custody');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const held = fs.fstatSync(fd); if (held.ino !== stat.ino || held.dev !== stat.dev) fail('Invalid nonce custody');
      const text = fs.readFileSync(fd, 'utf8'); const parsed = JSON.parse(text);
      if (canonicalJson(parsed) + '\n' !== text) fail('Invalid nonce custody');
      return parsed;
    } finally { fs.closeSync(fd); }
  }
  #record(hash) {
    const r = snapshot(this.#read(this.#file(hash)), [...bindingFields, 'nonceDigest', 'expiresAt', 'sessionDigest', 'threadId']);
    binding(Object.fromEntries(bindingFields.map(k => [k, r[k]])));
    if (r.nonceDigest !== hash || !HASH.test(r.sessionDigest) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= this.#now()) fail('Decision expired');
    if (r.threadId !== null && (typeof r.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(r.threadId))) fail('Invalid decision binding');
    return r;
  }
  issue(value, { threadId = null } = {}) {
    const b = binding(value);
    if (threadId !== null && (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId))) fail('Invalid decision binding');
    const bytes = this.#random(32); if (!Buffer.isBuffer(bytes) || bytes.length !== 32) fail('Invalid nonce entropy');
    const nonce = bytes.toString('base64url'); const nonceDigest = sha256Bytes(nonce);
    privateEntry(path.dirname(this.#root), true);
    try { fs.mkdirSync(this.#root, { mode: 0o700 }); syncDirectory(path.dirname(this.#root)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    this.#write(this.#file(nonceDigest), { ...b, nonceDigest, expiresAt: this.#now() + this.#ttl, sessionDigest: this.#session, threadId });
    return Object.freeze({ ...b, nonce });
  }
  consume(value) {
    const d = snapshotHumanDecision(value); const hash = sha256Bytes(d.nonce);
    let r;
    try { r = this.#record(hash); } catch (e) { if (e.code === 'ENOENT') fail('Decision binding mismatch'); throw e; }
    if (bindingFields.some(k => d[k] !== r[k])) fail('Decision binding mismatch');
    if (fs.existsSync(this.#file(hash, true))) fail('Decision already consumed');
    if (r.sessionDigest !== this.#session) fail('Decision invalidated by restart');
    try { this.#write(this.#file(hash, true), { nonceDigest: hash, bindingDigest: sha256Json(r) }); }
    catch (e) { if (e.code === 'EEXIST') fail('Decision already consumed'); throw e; }
    return Object.freeze({ ...r, consumed: true });
  }
  recover(hash) {
    const r = this.#record(hash); const used = this.#read(this.#file(hash, true));
    if (canonicalJson(used) !== canonicalJson({ nonceDigest: hash, bindingDigest: sha256Json(r) })) fail('Consumed decision binding mismatch');
    return Object.freeze({ ...r, consumed: true });
  }
}
