import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../review/canonical-json.js';
import { freezeReviewValue } from '../review/chrome-review-contract.js';
import { parseChromeBinding, CHROME_RESULT_FAILURES, CHROME_CANCEL_REASONS } from '../review/chrome-review-bridge.js';
import { withRuntimeLock } from './runtime-lock.js';

// Retained IDs are never pruned. Exhaustion requires a separately reviewed
// archival/rotation policy; it cannot silently weaken replay protection.
export const MAX_RETAINED_CHROME_INVOCATIONS = 4096;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const REASONS = new Set(['completed', 'interrupted-restart', ...CHROME_RESULT_FAILURES, ...CHROME_CANCEL_REASONS]);
const fail = () => { throw new Error('Chrome review journal custody unavailable'); };
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function concrete(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || /[\x00-\x1f]/.test(file)) fail();
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail();
  }
}
function custody(file, directory, device) {
  concrete(file); const info = fs.lstatSync(file);
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid() || (info.mode & 0o7077) || (device !== undefined && info.dev !== device) || (!directory && info.nlink !== 1)) fail();
  return info;
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function validate(record) {
  if (!record || Object.keys(record).sort().join(',') !== 'binding,reasonCode,receiptCommitted,receiptHash,schemaVersion,status,usedInvocationIds' || record.schemaVersion !== 1) fail();
  const binding = parseChromeBinding(record.binding);
  if (!['pending', 'terminal'].includes(record.status) || typeof record.receiptCommitted !== 'boolean') fail();
  if (record.status === 'pending' ? record.reasonCode !== null || record.receiptCommitted : !REASONS.has(record.reasonCode)) fail();
  if (record.receiptCommitted ? typeof record.receiptHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.receiptHash) : record.receiptHash !== null) fail();
  const ids = record.usedInvocationIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_RETAINED_CHROME_INVOCATIONS || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) || ids.at(-1) !== binding.invocationId) fail();
  return freezeReviewValue({ ...record, binding });
}

/** This is crash bookkeeping, not a receipt or model-output store. The trusted
 * caller reconciles the permanent receipt chain before markReceipted. */
export class ChromeReviewJournal {
  #project; #root; #file; #restart; #record = null; #recovered = false;
  constructor({ projectRoot, restartId }) {
    this.#project = projectRoot; this.#root = path.join(projectRoot, 'runtime'); this.#file = path.join(this.#root, 'chrome-review-pending.json');
    if (typeof restartId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(restartId)) fail();
    this.#restart = restartId;
  }
  #prepare() {
    concrete(this.#project);
    if (!exists(this.#root)) { try { fs.mkdirSync(this.#root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } syncDirectory(this.#project); }
    return custody(this.#root, true).dev;
  }
  #read(device) {
    if (!exists(this.#file)) return null;
    const before = custody(this.#file, false, device); if (before.size > MAX_JOURNAL_BYTES) fail();
    const fd = fs.openSync(this.#file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const held = fs.fstatSync(fd); if (held.ino !== before.ino || held.dev !== before.dev) fail();
      const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd); const named = custody(this.#file, false, device);
      if (bytes.length > MAX_JOURNAL_BYTES || after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.ino !== before.ino) fail();
      const text = bytes.toString('utf8'); const record = validate(JSON.parse(text));
      if (text !== canonicalJson(record) + '\n') fail();
      return record;
    } finally { fs.closeSync(fd); }
  }
  #write(record, device) {
    const bytes = canonicalJson(validate(record)) + '\n'; if (Buffer.byteLength(bytes) > MAX_JOURNAL_BYTES) fail();
    custody(this.#root, true, device); if (exists(this.#file)) custody(this.#file, false, device);
    const temp = path.join(this.#root, `.chrome-review-${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let renamed = false;
    try {
      try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      custody(temp, false, device); custody(this.#root, true, device); if (exists(this.#file)) custody(this.#file, false, device);
      fs.renameSync(temp, this.#file); renamed = true; syncDirectory(this.#root);
    } finally { if (!renamed && exists(temp)) fs.unlinkSync(temp); }
    this.#record = this.#read(device);
  }
  async #locked(action) {
    const device = this.#prepare();
    return withRuntimeLock({ file: path.join(this.#root, '.chrome-review-lock.json'), device }, async () => {
      if (this.#prepare() !== device) fail();
      this.#record = this.#read(device); return action(device);
    });
  }
  async recover() {
    await this.#locked(device => {
      if (this.#record?.status === 'pending' && this.#record.binding.restartId !== this.#restart) this.#write({ ...this.#record, status: 'terminal', reasonCode: 'interrupted-restart' }, device);
      this.#recovered = true;
    });
    return this.recoveryState();
  }
  recoveryState() {
    if (!this.#recovered) fail();
    return !this.#record ? 'empty' : this.#record.status === 'pending' ? 'pending' : this.#record.receiptCommitted ? 'receipted' : 'terminal-unreceipted';
  }
  snapshot() { this.recoveryState(); return this.#record; }
  async begin(value) {
    const binding = parseChromeBinding(value); if (!this.#recovered || binding.restartId !== this.#restart) fail();
    await this.#locked(device => {
      if (this.#record && !this.#record.receiptCommitted) fail();
      const ids = this.#record?.usedInvocationIds ?? [];
      if (ids.includes(binding.invocationId) || ids.length >= MAX_RETAINED_CHROME_INVOCATIONS) fail();
      this.#write({ schemaVersion: 1, binding, status: 'pending', reasonCode: null, receiptCommitted: false, receiptHash: null, usedInvocationIds: [...ids, binding.invocationId] }, device);
    });
  }
  async finish(value, reasonCode) {
    const binding = parseChromeBinding(value);
    if (!this.#recovered || binding.restartId !== this.#restart || !REASONS.has(reasonCode) || reasonCode === 'interrupted-restart') fail();
    await this.#locked(device => {
      const record = this.#record;
      if (!record || record.receiptCommitted || canonicalJson(record.binding) !== canonicalJson(binding)) fail();
      // A failure can supersede a completed callback during finalization; it
      // can never be promoted back to completion or replace a prior failure.
      if (record.status === 'terminal' && record.reasonCode !== reasonCode && record.reasonCode !== 'completed') fail();
      this.#write({ ...record, status: 'terminal', reasonCode }, device);
    });
  }
  async markReceipted(receiptHash) {
    if (!this.#recovered || typeof receiptHash !== 'string' || !/^[a-f0-9]{64}$/.test(receiptHash)) fail();
    const expected = this.#record;
    if (!expected || expected.status !== 'terminal') fail();
    await this.#locked(device => {
      const record = this.#record;
      if (!record || record.status !== 'terminal' || canonicalJson(record.binding) !== canonicalJson(expected.binding) || record.reasonCode !== expected.reasonCode || (record.receiptCommitted && record.receiptHash !== receiptHash)) fail();
      if (!record.receiptCommitted) this.#write({ ...record, receiptCommitted: true, receiptHash }, device);
    });
  }
}
