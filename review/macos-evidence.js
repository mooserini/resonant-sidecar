import { spawn } from 'node:child_process';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sha256Json } from './canonical-json.js';
import { sanitizeEvidence } from './redaction.js';
import { assertOwnershipPolicy, pathIdentity, validStartTime, verifyOwnershipTopology } from './process-ownership.js';

const LIMIT = 1024 * 1024;
const COMMANDS = Object.freeze({ ps: '/bin/ps', lsof: '/usr/sbin/lsof', codesign: '/usr/bin/codesign', sample: '/usr/bin/sample', sw_vers: '/usr/bin/sw_vers', sysctl: '/usr/sbin/sysctl' });
const failure = () => new Error('macOS evidence collection failed');

// Private runner: callers may inject a trusted fixture runner, but cannot supply
// command names, argv, environment, shell, cwd or resource limits.
function run(invocation) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: '/', env: invocation.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = []; let bytes = 0; let settled = false;
    const stop = () => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(failure()); };
    const timer = setTimeout(stop, invocation.timeoutMs);
    const capture = target => data => { bytes += data.length; if (bytes > LIMIT) stop(); else target.push(data); };
    child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
    child.on('error', stop);
    child.on('close', exitCode => { if (settled) return; settled = true; clearTimeout(timer); resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
  });
}

function textOutput(value) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value))) throw failure();
  return Buffer.isBuffer(value) ? new TextDecoder('utf-8', { fatal: true }).decode(value) : value;
}

function parseProcess(stdout, pid) {
  // comm is the executable path, not argv. Unrelated rows never cross custody.
  const rows = stdout.split('\n').filter(line => new RegExp(`^\\s*${pid}\\s`).test(line));
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw failure();
  const match = rows[0].match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\d:.-]+)\s+(\/[^\r\n]+)$/);
  if (!match) throw failure();
  const startTime = match[4].replace(/\s+/g, ' ');
  if (!validStartTime(startTime)) throw failure();
  return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startTime, elapsedTime: match[5], executablePath: match[6] };
}

function parseDescriptors(stdout, pid, role, cdpPorts) {
  const records = []; let relevant = false; let current;
  for (const field of stdout.split(/[\0\n]/).filter(Boolean)) {
    const kind = field[0]; const value = field.slice(1);
    if (kind === 'p') { relevant = value === String(pid); current = undefined; }
    else if (kind === 'f') { current = relevant ? { fd: value } : undefined; if (current) records.push(current); }
    else if (current && ['t', 'n', 'P'].includes(kind)) current[kind] = value;
    else if (current && kind === 'T' && value.startsWith('ST=')) current.state = value.slice(3);
  }
  const result = { descriptors: [], endpoints: [], listeners: [] };
  for (const entry of records) {
    if (entry.fd === 'cwd' && entry.t === 'DIR') { if (!entry.n?.startsWith('/')) throw failure(); result.cwd = pathIdentity(entry.n); continue; }
    if (['IPv4', 'IPv6'].includes(entry.t) && !['TCP', 'UDP', 'UDPLITE', 'ICMP', 'ICMPV6'].includes(entry.P)) throw failure();
    if (entry.P === 'TCP' && (!entry.state || !/^\d+[rwu]?$/.test(entry.fd))) throw failure();
    if (!/^\d+[rwu]?$/.test(entry.fd)) continue;
    const fd = Number.parseInt(entry.fd, 10);
    if (['PIPE', 'unix'].includes(entry.t)) {
      result.descriptors.push({ fd, type: entry.t });
      // Named Unix sockets and filesystem paths are never retained.
      if (/^(?:->)?0x[a-fA-F0-9]+$/.test(entry.n ?? '')) result.endpoints.push({ fd, type: entry.t, target: entry.n, transport: fd <= 2 ? 'anonymous-stdio' : entry.t === 'PIPE' ? 'anonymous-pipe' : 'anonymous-unix' });
    }
    if (entry.P === 'TCP') {
      if (!entry.state) throw failure();
      if (entry.state !== 'LISTEN') continue;
      const endpoint = entry.n?.match(/^(127\.0\.0\.1|\[::1\]|\*|\d{1,3}(?:\.\d{1,3}){3}|\[[a-fA-F0-9:]+\]):(\d+)$/);
      const address = endpoint ? endpoint[1].replace(/^\[|\]$/g, '') : 'unrecognized';
      const port = endpoint ? Number(endpoint[2]) : 0;
      if (port > 65535) throw failure();
      result.listeners.push({ fd, protocol: 'TCP', address, port, transport: role === 'chrome' && ['127.0.0.1', '::1'].includes(address) && cdpPorts.includes(port) ? 'chrome-loopback-cdp' : 'tcp' });
    }
  }
  if (!result.cwd) throw failure();
  return result;
}

function signingFacts(stdout, verified) {
  const signing = { passed: verified, authority: [] };
  const fields = { Identifier: 'identifier', TeamIdentifier: 'teamId', CDHash: 'cdHash' };
  for (const line of stdout.split('\n')) {
    const split = line.indexOf('='); if (split < 0) continue;
    const key = line.slice(0, split); const value = line.slice(split + 1);
    if (key === 'Authority') signing.authority.push(value);
    else if (Object.hasOwn(fields, key)) { if (Object.hasOwn(signing, fields[key])) throw failure(); signing[fields[key]] = value; }
  }
  return sanitizeEvidence(signing);
}

function sampleFacts(stdout) {
  if (!stdout.includes('Call graph:')) throw failure();
  // Only fixed symbol counters survive. No frame prose, image paths, argv,
  // thread labels or arbitrary strings are persisted or hashed as evidence.
  const checks = ['read', 'poll', 'kevent', 'mach_msg_trap', 'mach_msg2_trap', '__psynch_cvwait'].map(symbol => {
    let count = 0;
    for (const line of stdout.split('\n')) {
      const match = line.match(new RegExp(`^[\\s+!:|]*(\\d+)\\s+${symbol}(?:\\s|$)`));
      if (match) count += Number(match[1]);
    }
    if (!Number.isSafeInteger(count)) throw failure();
    return { name: `sample-${symbol.replaceAll('_', '-')}`, actual: count };
  });
  const sanitized = sanitizeEvidence({ checks });
  return { ...sanitized, sampleDigest: sha256Json(sanitized) };
}

async function executableDigest(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 512 * 1024 * 1024) throw failure();
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; if (bytes > before.size) throw failure(); hash.update(chunk); }
    const after = await handle.stat();
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw failure();
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function sessionIdentity(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1) throw failure();
    return { path: pathIdentity(file), present: true, bytes: info.size, sha256: sha256Json({ name: `${info.dev}:${info.ino}`, bytes: info.size, startTime: String(info.birthtimeMs), elapsedTime: String(info.mtimeMs) }) };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: pathIdentity(file), present: false };
    throw error;
  }
}

export async function collectMacOSEvidence(input) {
  try {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).some(key => !['phase', 'chromeExited', 'processes', 'expectedChrome', 'sessionFile', 'runner'].includes(key)) || Object.values(Object.getOwnPropertyDescriptors(input)).some(d => !Object.hasOwn(d, 'value'))) throw failure();
    const { sessionFile, runner = run } = input;
    const policy = structuredClone(assertOwnershipPolicy({ phase: input.phase, chromeExited: input.chromeExited, processes: input.processes, expectedChrome: input.expectedChrome }));
    const { phase, processes, expectedChrome } = policy;
    if (typeof runner !== 'function' || (runner === run && process.platform !== 'darwin')) throw failure();
    if (sessionFile !== undefined && (typeof sessionFile !== 'string' || !path.isAbsolute(sessionFile) || /[\x00-\x1f]/.test(sessionFile))) throw failure();
    const execute = async (command, args, allowedExitCodes = [0]) => {
      const response = await runner({ command: COMMANDS[command], args, env: { LANG: 'C', LC_ALL: 'C' }, cwd: '/', shell: false, maxOutputBytes: LIMIT, timeoutMs: 10000 });
      const stdout = textOutput(response.stdout); const stderr = textOutput(response.stderr);
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > LIMIT || !allowedExitCodes.includes(response.exitCode)) throw failure();
      return { stdout, stderr, exitCode: response.exitCode };
    };
    const probe = async pid => {
      const result = await execute('ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,etime=,comm='], [0, 1]);
      if (result.exitCode === 1) { if (result.stdout.trim() || result.stderr.trim()) throw failure(); return null; }
      const parsed = parseProcess(result.stdout, pid); if (!parsed) throw failure(); return parsed;
    };
    const macOSVersion = (await execute('sw_vers', ['-productVersion'])).stdout.trim();
    const architecture = (await execute('sysctl', ['-n', 'hw.machine'])).stdout.trim();
    const bootSessionUUID = (await execute('sysctl', ['-n', 'kern.bootsessionuuid'])).stdout.trim();
    if (!/^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/.test(macOSVersion) || !['arm64', 'x86_64'].includes(architecture) || !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(bootSessionUUID)) throw failure();
    const initial = new Map();
    for (const expected of processes) initial.set(expected.pid, await probe(expected.pid));
    const evidence = { schemaVersion: 1, status: phase, macOSVersion, architecture, bootSessionUUID, processes: [], checks: [] };
    for (const expected of processes) {
      const facts = initial.get(expected.pid);
      if (!facts) { evidence.processes.push({ name: expected.name, pid: expected.pid, present: false }); continue; }
      // Do not inspect a different executable merely because a PID was reused.
      if (facts.executablePath !== expected.executablePath) throw failure();
      const descriptors = parseDescriptors((await execute('lsof', ['-nP', '-a', '-p', String(expected.pid), '-F0pftnPT'])).stdout, expected.pid, expected.name, expectedChrome.cdpPorts);
      const digest = await executableDigest(expected.executablePath);
      const display = await execute('codesign', ['--display', '--verbose=4', expected.executablePath], [0, 1]);
      const verified = await execute('codesign', ['--verify', '--strict', expected.executablePath], [0, 1]);
      const signing = signingFacts(display.stderr, display.exitCode === 0 && verified.exitCode === 0);
      const sample = sampleFacts((await execute('sample', [String(expected.pid), '1', '10', '-mayDie', '-file', '/dev/stdout'])).stdout);
      evidence.processes.push({ ...facts, name: expected.name, present: true, executablePath: pathIdentity(facts.executablePath), executableDigest: digest, signing, ...descriptors, ...sample });
    }
    if (sessionFile !== undefined) evidence.sessionFileIdentity = await sessionIdentity(sessionFile);
    for (const expected of processes) {
      const before = initial.get(expected.pid); const after = await probe(expected.pid);
      const stable = before === null ? after === null : after !== null && ['pid', 'ppid', 'pgid', 'startTime', 'executablePath'].every(key => before[key] === after[key]);
      evidence.checks.push({ name: `${expected.name}-stable`, passed: stable, reasonCode: stable ? 'verified' : 'process-changed' });
    }
    const verdict = verifyOwnershipTopology(evidence, policy);
    return sanitizeEvidence({ ...evidence, passed: verdict.passed, checks: [...evidence.checks, ...verdict.checks] });
  } catch { throw failure(); }
}
