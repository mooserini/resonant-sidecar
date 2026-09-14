import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMacOSEvidence } from '../review/macos-evidence.js';
import { verifyOwnershipTopology } from '../review/process-ownership.js';
import { policy, runner } from './fixtures/macos/fixture.js';

test('accepts live Chrome ancestry and separately labeled isolated verifier ancestry', async () => {
  for (const phase of ['before', 'verification', 'after']) {
    const expected = policy(phase);
    const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
    assert.equal(evidence.status, phase);
    assert.equal(verifyOwnershipTopology(evidence, expected).passed, true);
  }
});

test('hard-fails every sidecar TCP listener even when bound to loopback', async () => {
  const expected = policy();
  for (const name of ['bootstrap', 'active-host', 'sidecar-codex']) {
    const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
    evidence.processes.find(p => p.name === name).listeners.push({ fd: 17, protocol: 'TCP', address: '127.0.0.1', port: 9222, transport: 'tcp' });
    const verdict = verifyOwnershipTopology(evidence, expected);
    assert.equal(verdict.passed, false);
    assert.ok(verdict.checks.some(c => c.reasonCode === 'sidecar-listener'));
  }
});

test('hard-fails wrong Chrome Team ID, signing identifier, executable, signature, or ancestry', async () => {
  const expected = policy();
  for (const mutate of [
    e => { e.processes[0].signing.teamId = 'WRONGTEAM1'; },
    e => { e.processes[0].signing.identifier = 'com.fake.browser'; },
    e => { e.processes[0].executablePath = '/usr/bin/false'; },
    e => { e.processes[0].signing.passed = false; },
    e => { e.processes[2].ppid = 1; },
    e => { e.processes[0].listeners[0].address = '0.0.0.0'; },
  ]) {
    const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
    mutate(evidence);
    assert.equal(verifyOwnershipTopology(evidence, expected).passed, false);
  }
});

test('after Chrome exit verifies all previously relevant PIDs absent and rejects survivors', async () => {
  const expected = { ...policy('after'), chromeExited: true };
  const evidence = await collectMacOSEvidence({ ...expected, runner: runner({ '/bin/ps': () => ({ exitCode: 1, stdout: '', stderr: '' }) }).run });
  assert.equal(evidence.passed, true);
  assert.equal(evidence.processes.every(p => p.present === false), true);
  evidence.processes[2] = (await collectMacOSEvidence({ ...policy('after'), runner: runner().run })).processes[2];
  assert.equal(verifyOwnershipTopology(evidence, expected).passed, false);
});

test('verification cannot reuse the live Codex process or attach its verifier to the active host', async () => {
  const expected = policy('verification');
  const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
  evidence.processes.at(-1).ppid = 103;
  assert.equal(verifyOwnershipTopology(evidence, expected).passed, false);
});

test('rejects forbidden fields and cannot turn missing or extra process evidence into a pass', async () => {
  const expected = policy();
  for (const mutate of [e => { e.stdout = 'raw'; }, e => { e.processes[0].env = {}; }, e => { e.processes.pop(); }, e => { e.processes.push({ pid: 999, name: 'unrelated', present: true }); }]) {
    const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
    mutate(evidence);
    assert.throws(() => verifyOwnershipTopology(evidence, expected), /evidence|sanitization/i);
  }
});

test('verifier must own its isolated process group', async () => {
  const expected = policy('verification');
  const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
  evidence.processes.at(-1).pgid = 888;
  assert.equal(verifyOwnershipTopology(evidence, expected).passed, false);
});

test('rejects malformed OS identity and process descriptor fields', async () => {
  const expected = policy();
  for (const mutate of [e => { e.architecture = 'unknown'; }, e => { e.bootSessionUUID = 'not-a-uuid'; }, e => { e.macOSVersion = 'nonsense'; }, e => { e.processes[1].listeners = [{ summary: 'arbitrary prose' }]; }]) {
    const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
    mutate(evidence);
    assert.throws(() => verifyOwnershipTopology(evidence, expected), /evidence/);
  }
});

for (const field of ['elapsedTime', 'descriptors', 'checks', 'sampleDigest']) {
  test(`rejects missing mandatory ${field} process evidence`, async () => {
    const expected = policy();
    const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
    delete evidence.processes[1][field];
    assert.throws(() => verifyOwnershipTopology(evidence, expected), /evidence/);
  });
}

for (const kind of ['missing', 'duplicate', 'all-missing']) {
  test(`rejects ${kind} stability evidence`, async () => {
    const expected = policy();
    const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
    if (kind === 'missing') evidence.checks = evidence.checks.filter(c => c.name !== 'bootstrap-stable');
    else if (kind === 'duplicate') evidence.checks.push({ ...evidence.checks.find(c => c.name === 'bootstrap-stable') });
    else delete evidence.checks;
    assert.throws(() => verifyOwnershipTopology(evidence, expected), /evidence/);
  });
}

test('failed stability evidence cannot pass even if top-level passed is forged', async () => {
  const expected = policy(); const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run });
  Object.assign(evidence.checks.find(c => c.name === 'bootstrap-stable'), { passed: false, reasonCode: 'process-changed' });
  evidence.passed = true;
  assert.equal(verifyOwnershipTopology(evidence, expected).passed, false);
});

test('rejects malformed sample counters, digest mismatches, descriptors and elapsed time', async () => {
  for (const mutate of [
    e => { e.processes[1].checks = []; },
    e => { e.processes[1].checks[0].actual = -1; },
    e => { e.processes[1].checks[0].name = 'unrecognized'; },
    e => { e.processes[1].checks[0].actual += 1; },
    e => { e.processes[1].sampleDigest = 'a'.repeat(64); },
    e => { e.processes[1].descriptors = [{ fd: -1, type: 'PIPE' }]; },
    e => { e.processes[1].elapsedTime = 'arbitrary'; },
  ]) {
    const expected = policy(); const evidence = await collectMacOSEvidence({ ...expected, runner: runner().run }); mutate(evidence);
    assert.throws(() => verifyOwnershipTopology(evidence, expected), /evidence/);
  }
});
