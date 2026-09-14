import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectMacOSEvidence } from '../review/macos-evidence.js';
import { sanitizeEvidence } from '../review/redaction.js';
import { policy, runner, ps, lsof } from './fixtures/macos/fixture.js';

test('retains relevant process facts and sanitized sampling, excluding other processes and private paths', async () => {
  const evidence = await collectMacOSEvidence({ ...policy(), runner: runner().run });
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.processes.map(p => p.pid), [101, 102, 103, 104]);
  assert.equal(evidence.processes[1].ppid, 101);
  assert.equal(evidence.processes[1].pgid, 101);
  assert.match(evidence.processes[1].executableDigest, /^[a-f0-9]{64}$/);
  assert.match(evidence.processes[1].cwd, /^path-sha256:/);
  assert.equal(evidence.processes[0].listeners[0].transport, 'chrome-loopback-cdp');
  assert.equal(evidence.processes[1].endpoints[0].transport, 'anonymous-stdio');
  assert.equal(evidence.processes[1].checks.find(c => c.name === 'sample-read').actual, 100);
  assert.match(evidence.processes[1].sampleDigest, /^[a-f0-9]{64}$/);
  assert.equal(evidence.macOSVersion, '27.0');
  assert.equal(evidence.architecture, 'arm64');
  const json = JSON.stringify(evidence);
  for (const forbidden of ['Cookie', 'never-retain', '/Users/', 'transcript', 'stdout', 'argv']) assert.equal(json.includes(forbidden), false);
  assert.equal(evidence.processes.flatMap(p => p.listeners).some(l => l.port === 6666), false);
  assert.deepEqual(sanitizeEvidence(evidence), evidence);
});

test('emits only fixed absolute command invocations with scrubbed environment and bounded output', async () => {
  const fixture = runner();
  await collectMacOSEvidence({ ...policy(), runner: fixture.run });
  assert.deepEqual([...new Set(fixture.calls.map(c => c.command))].sort(), ['/bin/ps', '/usr/bin/codesign', '/usr/bin/sample', '/usr/bin/sw_vers', '/usr/sbin/lsof', '/usr/sbin/sysctl']);
  for (const call of fixture.calls) {
    assert.deepEqual(call.env, { LANG: 'C', LC_ALL: 'C' });
    assert.equal(call.shell, false);
    assert.equal(call.cwd, '/');
    assert.ok(call.maxOutputBytes <= 1048576);
    assert.ok(call.timeoutMs <= 10000);
  }
  assert.deepEqual(fixture.calls.find(c => c.command === '/bin/ps').args, ['-ww', '-p', '101', '-o', 'pid=,ppid=,pgid=,lstart=,etime=,comm=']);
  assert.deepEqual(fixture.calls.find(c => c.command === '/usr/sbin/lsof').args, ['-nP', '-a', '-p', '101', '-F0pftnPT']);
  assert.deepEqual(fixture.calls.find(c => c.command === '/usr/bin/sample').args, ['101', '1', '10', '-mayDie', '-file', '/dev/stdout']);
});

test('records trusted session identity without reading session contents', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'macos-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionFile = path.join(dir, 'session.jsonl');
  await writeFile(sessionFile, 'Cookie: private transcript');
  const evidence = await collectMacOSEvidence({ ...policy(), sessionFile, runner: runner().run });
  assert.equal(evidence.sessionFileIdentity.bytes, 26);
  assert.equal(evidence.sessionFileIdentity.present, true);
  assert.match(evidence.sessionFileIdentity.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(evidence).includes('private transcript'), false);
});

test('rejects invalid trusted input before executing commands', async () => {
  for (const change of [{ phase: 'bogus' }, { processes: [] }, { processes: [{ ...policy().processes[0], pid: '1;id' }] }, { env: {} }, { command: '/bin/sh' }]) {
    const fixture = runner();
    await assert.rejects(collectMacOSEvidence({ ...policy(), ...change, runner: fixture.run }), /evidence/i);
    assert.equal(fixture.calls.length, 0);
  }
});

test('rejects unbounded output and command errors without retaining their payload', async () => {
  for (const response of [{ exitCode: 0, stdout: 'x'.repeat(1048577), stderr: '' }, { exitCode: 2, stdout: '', stderr: 'Cookie: private' }]) {
    await assert.rejects(collectMacOSEvidence({ ...policy(), runner: runner({ '/bin/ps': () => response }).run }), e => e.message === 'macOS evidence collection failed');
  }
});

test('detects process identity changing while diagnostics are collected', async () => {
  let reads = 0;
  const evidence = await collectMacOSEvidence({ ...policy(), runner: runner({ '/bin/ps': () => ({ exitCode: 0, stderr: '', stdout: ++reads > 4 ? ps.replace('12:00:00', '13:00:00') : ps }) }).run });
  assert.equal(evidence.passed, false);
  assert.ok(evidence.checks.some(c => c.reasonCode === 'process-changed'));
});

test('actual parsed listener evidence blocks sidecar custody, including IPv6', async () => {
  for (const address of ['127.0.0.1:1234', '[::1]:1234', '*:1234']) {
    const evidence = await collectMacOSEvidence({ ...policy(), runner: runner({ '/usr/sbin/lsof': () => ({ exitCode: 0, stderr: '', stdout: `${lsof}\np103\nf17\ntIPv6\nPTCP\nn${address}\nTST=LISTEN\n` }) }).run });
    assert.equal(evidence.passed, false);
    assert.ok(evidence.checks.some(c => c.reasonCode === 'sidecar-listener'));
  }
});

test('refuses incomplete listener output instead of claiming no listener', async () => {
  for (const suffix of ['p103\nf17\ntIPv4\nn127.0.0.1:1234\nTST=LISTEN\n', 'p103\nf17\ntIPv4\nPTCP\nn127.0.0.1:1234\n']) {
    await assert.rejects(collectMacOSEvidence({ ...policy(), runner: runner({ '/usr/sbin/lsof': () => ({ exitCode: 0, stderr: '', stdout: `${lsof}\n${suffix}` }) }).run }), /evidence/);
  }
});

test('freezes trusted PID and role scope before the first asynchronous command', async () => {
  const input = policy();
  const fixture = runner({ '/usr/bin/sw_vers': () => {
    input.processes[0].pid = 999;
    return { exitCode: 0, stdout: '27.0', stderr: '' };
  } });
  const evidence = await collectMacOSEvidence({ ...input, runner: fixture.run });
  assert.equal(evidence.processes[0].pid, 101);
  assert.equal(evidence.passed, true);
});

test('unsigned or invalid Chrome signature cannot produce a passing collection', async () => {
  const evidence = await collectMacOSEvidence({ ...policy(), runner: runner({ '/usr/bin/codesign': () => ({ exitCode: 1, stdout: '', stderr: 'code object is not signed at all' }) }).run });
  assert.equal(evidence.passed, false);
  assert.ok(evidence.checks.some(c => c.reasonCode === 'chrome-signing-mismatch'));
});

test('retains macOS call-tree sample counters without retaining frame prose', async () => {
  const evidence = await collectMacOSEvidence({ ...policy(), runner: runner({ '/usr/bin/sample': () => ({ exitCode: 0, stderr: '', stdout: 'Call graph:\n    +   97 read (in libsystem_kernel.dylib) [0x111]\n    ! 3 poll (in libsystem_kernel.dylib) [0x222]\n    + 12 unknown_private_function\n' }) }).run });
  assert.equal(evidence.processes[0].checks.find(c => c.name === 'sample-read').actual, 97);
  assert.equal(evidence.processes[0].checks.find(c => c.name === 'sample-poll').actual, 3);
  assert.equal(JSON.stringify(evidence).includes('unknown_private_function'), false);
});

test('anonymous descriptors above stderr are not mislabeled as stdio', async () => {
  const evidence = await collectMacOSEvidence({ ...policy(), runner: runner({ '/usr/sbin/lsof': () => ({ exitCode: 0, stderr: '', stdout: `${lsof}\np104\nf8\ntunix\nn->0xabcd\n` }) }).run });
  assert.equal(evidence.processes[3].endpoints.find(e => e.fd === 8).transport, 'anonymous-unix');
});

test('missing signing constraint and accessor arrays are rejected before execution', async () => {
  const missing = policy(); delete missing.expectedChrome.identifier;
  let invoked = false;
  const accessor = policy();
  Object.defineProperty(accessor.expectedChrome.cdpPorts, '0', { enumerable: true, get() { invoked = true; return 9222; } });
  for (const input of [missing, accessor]) {
    const fixture = runner();
    await assert.rejects(collectMacOSEvidence({ ...input, runner: fixture.run }), /evidence/);
    assert.equal(fixture.calls.length, 0);
  }
  assert.equal(invoked, false);
});
