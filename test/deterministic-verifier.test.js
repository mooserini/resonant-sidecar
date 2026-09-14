import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildBundleManifest } from '../review/bundle-manifest.js';
import { runDeterministicReview } from '../review/deterministic-verifier.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const policy = JSON.parse(await readFile(path.join(root, 'policy/review-policy.v1.json')));
const commit = 'a'.repeat(40);

async function setup(t, changes = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sidecar-verifier-'));
  const bundleRoot = path.join(temporary, 'bundle');
  await mkdir(bundleRoot);
  t.after(async () => {
    async function unseal(directory) {
      await chmod(directory, 0o700);
      const { readdir } = await import('node:fs/promises');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await unseal(target);
        else if (!entry.isSymbolicLink()) await chmod(target, 0o600);
      }
    }
    await unseal(temporary);
    await rm(temporary, { recursive: true });
  });
  const active = await buildBundleManifest({ root, files: policy.approvedBundlePaths, sourceCommit: commit, schemaVersion: 1 });
  for (const file of policy.approvedBundlePaths) {
    await mkdir(path.dirname(path.join(bundleRoot, file)), { recursive: true });
    await cp(path.join(root, file), path.join(bundleRoot, file));
    if (Object.hasOwn(changes, file)) await writeFile(path.join(bundleRoot, file), changes[file]);
  }
  const manifest = await buildBundleManifest({ root: bundleRoot, files: policy.approvedBundlePaths, sourceCommit: commit, schemaVersion: 1 });
  const manifestPath = path.join(temporary, 'staging-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o400 });
  const directories = new Set([bundleRoot]);
  for (const file of policy.approvedBundlePaths) {
    await chmod(path.join(bundleRoot, file), 0o400);
    directories.add(path.dirname(path.join(bundleRoot, file)));
  }
  for (const directory of directories) await chmod(directory, 0o500);
  return { staged: { bundleRoot, manifestPath, manifest }, active: { manifest: active, root }, policy, trustedHarness: { root }, temporary };
}

test('real fixed harness passes the baseline and reports every required check', async t => {
  const input = await setup(t);
  const result = await runDeterministicReview(input);
  assert.equal(result.passed, true, JSON.stringify(result));
  for (const name of ['schema', 'staged-integrity', 'unit', 'protocol', 'continuity', 'interruption', 'negative-policy', 'sanitization']) {
    assert.ok(result.checks.some(check => check.name === name && check.passed), name);
  }
  assert.ok(result.checks.some(check => check.name.startsWith('syntax-')));
  assert.ok(result.verifierIdentities.some(identity => identity.name === 'trusted-harness' && /^[a-f0-9]{64}$/.test(identity.sha256)));
  assert.equal(result.candidateBundleDigest, input.staged.manifest.bundleDigest);
  assert.doesNotMatch(JSON.stringify(result), /stdout|stderr|\/Users\/|\/home\//);
});

test('syntax failure is a hard failure without running candidate code', async t => {
  const input = await setup(t, { 'native-host/sidecar-protocol.js': 'export const broken = ;' });
  const result = await runDeterministicReview(input);
  assert.equal(result.passed, false);
  assert.ok(result.checks.some(check => check.reasonCode === 'syntax-failed'));
});

test('trusted behavioral checks reject broken candidate logic', async t => {
  const source = await readFile(path.join(root, 'native-host/sidecar-protocol.js'), 'utf8');
  const input = await setup(t, { 'native-host/sidecar-protocol.js': source.replace('text: value.text', "text: 'changed'") });
  const result = await runDeterministicReview(input);
  assert.equal(result.passed, false);
  assert.ok(result.checks.some(check => check.name === 'protocol' && !check.passed));
});

test('changed staged bytes fail before any command', async t => {
  const input = await setup(t);
  await chmod(path.join(input.staged.bundleRoot, 'native-host/host.js'), 0o600);
  await writeFile(path.join(input.staged.bundleRoot, 'native-host/host.js'), 'process.exit(0)');
  await chmod(path.join(input.staged.bundleRoot, 'native-host/host.js'), 0o400);
  let called = false;
  input.trustedHarness.runner = () => { called = true; };
  const result = await runDeterministicReview(input);
  assert.equal(result.passed, false);
  assert.ok(result.checks.some(check => check.reasonCode === 'staged-integrity-failed'));
  assert.equal(called, false);
});

test('candidate tests and extra files cannot replace trusted inputs', async t => {
  const input = await setup(t);
  await chmod(input.staged.bundleRoot, 0o700);
  await mkdir(path.join(input.staged.bundleRoot, 'test'));
  await writeFile(path.join(input.staged.bundleRoot, 'test/pass.test.js'), 'process.exit(0)');
  await chmod(input.staged.bundleRoot, 0o500);
  const result = await runDeterministicReview(input);
  assert.equal(result.passed, false);
  assert.ok(result.checks.some(check => check.reasonCode === 'staged-integrity-failed'));
});

test('fixed argv, scrubbed environment, bounded runner, and output sanitization', async t => {
  const input = await setup(t);
  const invocations = [];
  input.trustedHarness.runner = async invocation => {
    invocations.push(invocation);
    return { exitCode: 1, stdout: Buffer.from('Authorization: Bearer sensitive-value'), stderr: Buffer.from('/Users/private/secret'), timedOut: false, outputLimitExceeded: false };
  };
  const result = await runDeterministicReview(input);
  assert.ok(invocations.length > 0);
  for (const invocation of invocations) {
    assert.equal(invocation.shell, false);
    assert.deepEqual(Object.keys(invocation.env).sort(), ['LANG', 'LC_ALL']);
    assert.ok(invocation.timeoutMs > 0 && invocation.timeoutMs <= 10000);
    assert.ok(invocation.maxOutputBytes <= 65536);
    assert.equal(invocation.command, '/usr/bin/sandbox-exec');
    assert.ok(invocation.args[1].includes('(deny default)'));
    assert.ok(invocation.args.includes('--input-type=module') || invocation.args.includes(path.join(root, 'review/trusted-harness.js')));
    assert.equal((await lstat(path.join(input.staged.bundleRoot, 'native-host/host.js'))).mode & 0o777, 0o400);
  }
  assert.equal(result.passed, false);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-value|private|Authorization|stdout|stderr/);
  assert.ok(result.checks.some(check => /^[a-f0-9]{64}$/.test(check.outputDigest)));
});

for (const [name, result] of [
  ['timeout', { exitCode: 0, timedOut: true }],
  ['output overflow', { exitCode: 0, outputLimitExceeded: true }],
  ['malformed runner response', { exitCode: '0' }],
]) {
  test(`${name} cannot become a passing review`, async t => {
    const input = await setup(t);
    input.trustedHarness.runner = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ...result });
    assert.equal((await runDeterministicReview(input)).passed, false);
  });
}

test('policy commands cannot be replaced with candidate commands', async t => {
  const input = await setup(t);
  input.policy = { ...policy, trustedTestCommands: [['npm', 'test']] };
  assert.equal((await runDeterministicReview(input)).passed, false);
});

for (const [fixture, target] of [
  ['reject-permission/extension/manifest.json', 'extension/manifest.json'],
  ['reject-listener/native-host/host.js', 'native-host/host.js'],
  ['reject-lifecycle/package.json', 'package.json'],
]) {
  test(`rejects ${fixture} without reaching execution`, async t => {
    const bytes = await readFile(path.join(root, 'test/fixtures/bundles', fixture));
    const input = await setup(t, { [target]: bytes });
    let called = false;
    input.trustedHarness.runner = () => { called = true; };
    assert.equal((await runDeterministicReview(input)).passed, false);
    assert.equal(called, false);
  });
}

test('staged mutation between commands is detected', async t => {
  const input = await setup(t);
  let calls = 0;
  input.trustedHarness.runner = async () => {
    calls++;
    const target = path.join(input.staged.bundleRoot, 'native-host/host.js');
    await chmod(target, 0o600);
    await writeFile(target, 'changed');
    await chmod(target, 0o400);
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const result = await runDeterministicReview(input);
  assert.equal(calls, 1);
  assert.equal(result.passed, false);
});

test('malformed staged input returns a sanitized failure', async t => {
  const input = await setup(t);
  input.staged = null;
  assert.equal((await runDeterministicReview(input)).passed, false);
});

test('a behavior-preserving host edit remains reviewable without executing its entry point', async t => {
  const source = await readFile(path.join(root, 'native-host/host.js'), 'utf8');
  const input = await setup(t, { 'native-host/host.js': `${source}\n// Harmless local implementation note.\n` });
  const result = await runDeterministicReview(input);
  assert.equal(result.passed, true, JSON.stringify(result));
});

test('generated installer command injection fails before any candidate test execution', async t => {
  const source = await readFile(path.join(root, 'scripts/install-macos.js'), 'utf8');
  const input = await setup(t, { 'scripts/install-macos.js': source.replace("    '#!/bin/sh',", "    '#!/bin/sh',\n    '/usr/bin/id',") });
  const calls = [];
  input.trustedHarness.runner = async invocation => {
    calls.push(invocation);
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const result = await runDeterministicReview(input);
  assert.equal(result.passed, false);
  assert.ok(result.checks.some(check => check.reasonCode === 'command-authority-added'));
  assert.equal(calls.length, 0);
});

test('actual CommonJS package declaration cannot be reviewed as forced ESM', async t => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
  pkg.type = 'commonjs';
  const input = await setup(t, { 'package.json': JSON.stringify(pkg) });
  const result = await runDeterministicReview(input);
  assert.equal(result.passed, false);
  assert.ok(result.checks.some(check => check.reasonCode === 'package-runtime-unsupported'));
  assert.equal(result.checks.some(check => check.command), false);
});
