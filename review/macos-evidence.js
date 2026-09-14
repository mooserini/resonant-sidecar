import { spawn } from 'node:child_process';
import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sha256Json } from './canonical-json.js';
import { sanitizeEvidence } from './redaction.js';
import { assertOwnershipPolicy, pathIdentity, validStartTime, validElapsedTime, verifyOwnershipTopology, SAMPLE_SYMBOLS } from './process-ownership.js';

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
  if (!validStartTime(startTime) || !validElapsedTime(match[5])) throw failure();
  return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startTime, elapsedTime: match[5], executablePath: match[6] };
}

function parseDescriptors(stdout, pid, role, cdpPorts) {
  if (!/\0\n?$/.test(stdout)) throw failure();
  const records = []; const seen = new Set(); let relevant = false; let current;
  const assign = (key, value) => {
    if (Object.hasOwn(current, key) && current[key] !== value) throw failure();
    current[key] = value;
  };
  // Only NUL separates fields. Newlines inside a pathname are data, never a
  // synthetic p/f record. lsof may insert one newline after a record's NUL.
  for (const field of stdout.split('\0').map(value => value.replace(/^\n/, '')).filter(Boolean)) {
    const kind = field[0]; const value = field.slice(1);
    if (kind === 'p') { relevant = value === String(pid); current = undefined; }
    else if (kind === 'f') {
      current = relevant ? { fd: value } : undefined;
      if (current) { if (seen.has(value)) throw failure(); seen.add(value); records.push(current); }
    } else if (current && ['t', 'n', 'P'].includes(kind)) assign(kind, value);
    else if (current && kind === 'T') {
      if (!/^[A-Z]{2}=.+$/.test(value)) throw failure();
      assign(`T${value.slice(0, 2)}`, value.slice(3));
    }
  }
  const tcpStates = new Set(['CLOSED', 'LISTEN', 'SYN_SENT', 'SYN_RCVD', 'ESTABLISHED', 'CLOSE_WAIT', 'FIN_WAIT_1', 'CLOSING', 'LAST_ACK', 'FIN_WAIT_2', 'TIME_WAIT']);
  const descriptorTypes = new Set(['REG', 'DIR', 'CHR', 'FIFO', 'PIPE', 'unix', 'IPv4', 'IPv6', 'KQUEUE', 'FSEVENT', 'PSXSEM', 'PSXSHM', 'systm', 'NDRV', 'ROUTE']);
  const result = { descriptors: [], endpoints: [], listeners: [] };
  for (const entry of records) {
    if (entry.TST !== undefined && entry.P !== 'TCP') throw failure();
    if (entry.P !== undefined && !['IPv4', 'IPv6'].includes(entry.t)) throw failure();
    if (entry.fd === 'cwd' && entry.t === 'DIR') { if (!entry.n?.startsWith('/')) throw failure(); result.cwd = pathIdentity(entry.n); continue; }
    if (['IPv4', 'IPv6'].includes(entry.t) && !['TCP', 'UDP', 'UDPLITE', 'ICMP', 'ICMPV6'].includes(entry.P)) throw failure();
    if (entry.P === 'TCP' && (!tcpStates.has(entry.TST) || !['IPv4', 'IPv6'].includes(entry.t) || !/^\d+[rwu]?$/.test(entry.fd))) throw failure();
    if (!/^\d+[rwu]?$/.test(entry.fd)) { if (/^\d/.test(entry.fd)) throw failure(); continue; }
    if (!descriptorTypes.has(entry.t) || !entry.n) throw failure();
    const fd = Number.parseInt(entry.fd, 10);
    if (['PIPE', 'unix'].includes(entry.t)) {
      result.descriptors.push({ fd, type: entry.t });
      // Named Unix sockets and filesystem paths are never retained.
      if (/^(?:->)?0x[a-fA-F0-9]+$/.test(entry.n ?? '')) result.endpoints.push({ fd, type: entry.t, target: entry.n, transport: fd <= 2 ? 'anonymous-stdio' : entry.t === 'PIPE' ? 'anonymous-pipe' : 'anonymous-unix' });
    }
    if (entry.P === 'TCP') {
      if (entry.TST !== 'LISTEN') continue;
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
  const checks = SAMPLE_SYMBOLS.map(symbol => {
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

async function bindExecutable(file) {
  const canonicalPath = await realpath(file);
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 512n * 1024n * 1024n) throw failure();
    const fingerprint = info => ['dev', 'ino', 'mode', 'nlink', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs'].map(key => String(info[key]));
    const identity = sha256Json(fingerprint(before));
    const check = async () => {
      if (await realpath(file) !== canonicalPath) throw failure();
      const pathname = await lstat(canonicalPath, { bigint: true });
      const opened = await handle.stat({ bigint: true });
      if (!pathname.isFile() || sha256Json(fingerprint(pathname)) !== identity || sha256Json(fingerprint(opened)) !== identity) throw failure();
    };
    await check();
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; if (BigInt(bytes) > before.size) throw failure(); hash.update(chunk); }
    if (BigInt(bytes) !== before.size) throw failure();
    await check();
    return { canonicalPath, digest: hash.digest('hex'), evidence: { path: pathIdentity(canonicalPath), sha256: identity }, check, close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
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
  const bindings = new Map();
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
    // Reject stale identity or unrelated ancestry for the entire snapshot before
    // any lsof, executable read, codesign or sample observes an individual PID.
    for (const expected of processes) {
      const facts = initial.get(expected.pid);
      if (!facts) continue;
      if (policy.chromeExited || facts.executablePath !== expected.executablePath || (expected.startTime && facts.startTime !== expected.startTime)) throw failure();
      if (expected.parent) {
        const parent = processes.find(p => p.name === expected.parent);
        if (!initial.get(parent.pid) || facts.ppid !== parent.pid) throw failure();
      }
      if (expected.name === 'verifier' && (facts.pgid !== facts.pid || processes.filter(p => ['active-host', 'sidecar-codex'].includes(p.name)).some(p => initial.get(p.pid)?.pgid === facts.pgid))) throw failure();
    }
    const evidence = { schemaVersion: 1, status: phase, macOSVersion, architecture, bootSessionUUID, processes: [], checks: [] };
    for (const expected of processes) {
      const facts = initial.get(expected.pid);
      if (!facts) { evidence.processes.push({ name: expected.name, pid: expected.pid, present: false }); continue; }
      const descriptors = parseDescriptors((await execute('lsof', ['-nP', '-a', '-p', String(expected.pid), '-F0pftnPT'])).stdout, expected.pid, expected.name, expectedChrome.cdpPorts);
      const binding = await bindExecutable(expected.executablePath);
      bindings.set(expected.pid, binding);
      await binding.check();
      const display = await execute('codesign', ['--display', '--verbose=4', binding.canonicalPath], [0, 1]);
      await binding.check();
      const verified = await execute('codesign', ['--verify', '--strict', binding.canonicalPath], [0, 1]);
      await binding.check();
      const signing = signingFacts(display.stderr, display.exitCode === 0 && verified.exitCode === 0);
      const sample = sampleFacts((await execute('sample', [String(expected.pid), '1', '10', '-mayDie', '-file', '/dev/stdout'])).stdout);
      evidence.processes.push({ ...facts, name: expected.name, present: true, executablePath: pathIdentity(facts.executablePath), executable: binding.evidence, executableDigest: binding.digest, signing, ...descriptors, ...sample });
    }
    if (sessionFile !== undefined) evidence.sessionFileIdentity = await sessionIdentity(sessionFile);
    for (const expected of processes) {
      await bindings.get(expected.pid)?.check();
      const before = initial.get(expected.pid); const after = await probe(expected.pid);
      await bindings.get(expected.pid)?.check();
      const stable = before === null ? after === null : after !== null && ['pid', 'ppid', 'pgid', 'startTime', 'executablePath'].every(key => before[key] === after[key]);
      evidence.checks.push({ name: `${expected.name}-stable`, passed: stable, reasonCode: stable ? 'verified' : 'process-changed' });
    }
    for (const binding of bindings.values()) await binding.check();
    const verdict = verifyOwnershipTopology(evidence, policy);
    return sanitizeEvidence({ ...evidence, passed: verdict.passed, checks: [...evidence.checks, ...verdict.checks] });
  } catch { throw failure(); }
  finally { await Promise.allSettled([...bindings.values()].map(binding => binding.close())); }
}
