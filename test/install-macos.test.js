import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { sha256Bytes, sha256Json } from '../review/canonical-json.js';
import { buildInstallPlan, migrateInstallation, parseInstallerArgs } from '../scripts/install-macos.js';
import { inspectCurrentInstallation, verifyInstallPlan } from '../scripts/verify-install-plan.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const COMMIT = 'b'.repeat(40);
const execFileAsync = promisify(execFile);

function currentIdentity(launcherPath, manifestPath, launcher = 'old', manifest = 'old-manifest') {
  const value = {
    launcher: { path: launcherPath, bytes: Buffer.byteLength(launcher), sha256: sha256Bytes(launcher), mode: 0o700 },
    manifest: { path: manifestPath, bytes: Buffer.byteLength(manifest), sha256: sha256Bytes(manifest), mode: 0o600 },
  };
  return { ...value, currentHash: sha256Json(value) };
}

function sourceArtifact(relativePath, text, mode = 0o644) {
  const bytes = Buffer.from(text);
  return { relativePath, bytes, mode, sha256: sha256Bytes(bytes) };
}

function sourceInspection() {
  const bundleFiles = [
    sourceArtifact('extension/manifest.json', JSON.stringify({ manifest_version: 3, permissions: ['nativeMessaging', 'sidePanel', 'storage'] })),
    sourceArtifact('native-host/host.js', '// active host\n'),
    sourceArtifact('package.json', JSON.stringify({ type: 'module', engines: { node: '>=22' } })),
  ];
  const trustedFiles = [
    sourceArtifact('bootstrap/host.js', '// trusted host\n'),
    sourceArtifact('bootstrap/native-proxy.js', '// trusted proxy\n'),
    sourceArtifact('native-host/native-framing.js', '// framing\n'),
  ];
  const manifest = {
    schemaVersion: 1,
    sourceCommit: COMMIT,
    files: bundleFiles.map(({ relativePath, bytes, mode, sha256 }) => ({ path: relativePath, bytes: bytes.length, mode, sha256 })),
    capabilities: { chromePermissions: ['nativeMessaging', 'sidePanel', 'storage'], hostPermissions: [], lifecycleScripts: [], listeners: [] },
    dependencies: { lockfiles: [], packageManager: null, runtime: [] },
  };
  manifest.bundleDigest = sha256Json(manifest);
  return {
    sourceCommit: COMMIT,
    bundle: { manifest, files: bundleFiles },
    trustedBootstrap: { digest: sha256Json(trustedFiles.map(({ relativePath, sha256, mode }) => ({ path: relativePath, sha256, mode }))), files: trustedFiles },
    behaviorComparison: { passed: true, checks: [{ name: 'v1-capabilities', passed: true }] },
  };
}

test('migration requires the exact explicit confirmation triple', () => {
  const currentHash = 'a'.repeat(64);
  assert.deepEqual(parseInstallerArgs([]), { migrate: false, extensionId: null, expectedCurrentHash: null });
  assert.throws(() => parseInstallerArgs(['--migrate']), /extension-id/i);
  assert.throws(() => parseInstallerArgs(['--migrate', '--extension-id', EXTENSION_ID]), /expected-current-hash/i);
  assert.throws(() => parseInstallerArgs(['--extension-id', EXTENSION_ID, '--expected-current-hash', currentHash]), /migrate/i);
  assert.throws(() => parseInstallerArgs(['--install', '--extension-id', EXTENSION_ID]), /unknown/i);
  assert.deepEqual(parseInstallerArgs(['--migrate', '--extension-id', EXTENSION_ID, '--expected-current-hash', currentHash]), { migrate: true, extensionId: EXTENSION_ID, expectedCurrentHash: currentHash });
});

test('dry-run plan targets Chrome Dev and a trusted installed bootstrap with one exact unchanged origin', () => {
  const launcherPath = '/Users/example/Library/Application Support/Resonant Sidecar/native-host';
  const manifestPath = '/Users/example/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json';
  const current = currentIdentity(launcherPath, manifestPath);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir: '/Users/example', nodePath: '/opt/node/bin/node', codexPath: '/Users/example/.local/bin/codex', projectRoot: '/Users/example/resonant-sidecar' });
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.browser, 'Google Chrome Dev');
  assert.equal(plan.paths.manifest, '/Users/example/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json');
  assert.equal(plan.paths.stableExtension, '/Users/example/Library/Application Support/Resonant Sidecar/extension');
  assert.equal(plan.paths.trustedBootstrap, '/Users/example/Library/Application Support/Resonant Sidecar/trusted-bootstrap');
  assert.equal(plan.paths.activeBundle, `/Users/example/resonant-sidecar/runtime/versions/${plan.bundle.digest}/bundle`);
  assert.deepEqual(plan.runtimeDirectory, { destination: '/Users/example/resonant-sidecar/runtime', mode: 0o700 });
  assert.equal(plan.bundle.manifestArtifact.destination, `${plan.paths.activeVersion}/manifest.json`);
  assert.equal(plan.bundle.manifestArtifact.mode, 0o400);
  assert.equal(plan.activePin.destination, plan.paths.activePin);
  assert.equal(plan.activePin.mode, 0o600);
  assert.deepEqual(plan.manifest.contents.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.deepEqual(plan.extensionIdentity, {
    expectedId: EXTENSION_ID,
    observedStablePathId: null,
    state: 'unverified',
  });
  assert.deepEqual(plan.registration, {
    state: 'unchanged-pending-stable-id-proof',
    launcherSha256: current.launcher.sha256,
    manifestSha256: current.manifest.sha256,
  });
  assert.equal(plan.manifest.contents.path, plan.paths.launcher);
  assert.match(plan.launcher.contents, /trusted-bootstrap\/runtime-entry\.js/);
  assert.doesNotMatch(plan.launcher.contents, /resonant-sidecar\/native-host\/host\.js/);
  assert.doesNotMatch(plan.launcher.contents, /localhost|127\.0\.0\.1|remote-debugging|WebSocket/i);
  assert.equal(plan.before.currentHash, current.currentHash);
  assert.equal(plan.receipts.before.eventType, 'migration-before');
  assert.equal(plan.receipts.migration.eventType, 'migration-prepared');
  assert.equal(plan.receipts.after.eventType, 'migration-files-prepared');
  verifyInstallPlan(plan);
});

test('planning and current-install inspection are read-only', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-plan-readonly-')));
  const paths = { launcher: path.join(root, 'Library', 'Application Support', 'Resonant Sidecar', 'native-host'), manifest: path.join(root, 'Library', 'Application Support', 'Google', 'Chrome Dev', 'NativeMessagingHosts', 'com.resonantmirror.sidecar.json') };
  await mkdir(path.dirname(paths.launcher), { recursive: true });
  await mkdir(path.dirname(paths.manifest), { recursive: true });
  await writeFile(paths.launcher, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(paths.manifest, '{"name":"old"}\n', { mode: 0o600 });
  const before = await Promise.all([stat(paths.launcher), stat(paths.manifest)]);
  const current = await inspectCurrentInstallation(paths);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir: root, projectRoot: path.join(root, 'repo'), nodePath: '/opt/node/bin/node', codexPath: '/opt/codex' });
  verifyInstallPlan(plan);
  const after = await Promise.all([stat(paths.launcher), stat(paths.manifest)]);
  assert.deepEqual(after.map(info => [info.ino, info.size, info.mtimeMs]), before.map(info => [info.ino, info.size, info.mtimeMs]));
  await assert.rejects(() => lstat(plan.paths.trustedBootstrap), /ENOENT/);
  await assert.rejects(() => lstat(plan.paths.stableExtension), /ENOENT/);
});

test('reviewed plan file can be verified without executing or changing it', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-plan-file-')));
  const launcherPath = path.join(root, 'Library', 'Application Support', 'Resonant Sidecar', 'native-host');
  const manifestPath = path.join(root, 'Library', 'Application Support', 'Google', 'Chrome Dev', 'NativeMessagingHosts', 'com.resonantmirror.sidecar.json');
  const current = currentIdentity(launcherPath, manifestPath);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir: root, projectRoot: path.join(root, 'repo'), nodePath: '/opt/node/bin/node', codexPath: '/opt/codex' });
  const planPath = path.join(root, 'reviewed-plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const before = await stat(planPath);
  const { stdout } = await execFileAsync(process.execPath, [path.resolve('scripts/verify-install-plan.js'), planPath], { cwd: path.resolve('.') });
  assert.equal(stdout, `${plan.installHash}\n`);
  const after = await stat(planPath);
  assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
});

test('plan verifier rejects unproved registration and redirected artifact destinations', () => {
  const launcherPath = '/Users/example/Library/Application Support/Resonant Sidecar/native-host';
  const manifestPath = '/Users/example/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json';
  const current = currentIdentity(launcherPath, manifestPath);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir: '/Users/example', projectRoot: '/Users/example/repo', nodePath: '/opt/node/bin/node', codexPath: '/opt/codex' });
  const redirected = structuredClone(plan);
  redirected.stableExtension.files[0].destination = '/tmp/redirected-manifest.json';
  delete redirected.installHash;
  redirected.installHash = sha256Json(redirected);
  assert.throws(() => verifyInstallPlan(redirected), /destination|containment/i);
  const claimed = structuredClone(plan);
  claimed.extensionIdentity = { expectedId: EXTENSION_ID, observedStablePathId: EXTENSION_ID, state: 'verified' };
  delete claimed.installHash;
  claimed.installHash = sha256Json(claimed);
  assert.throws(() => verifyInstallPlan(claimed), /identity proof/i);
});

test('explicit migration installs exact pinned bytes and preserves the prior V1 registration', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-migrate-')));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'runtime'), { recursive: true, mode: 0o755 });
  const support = path.join(homeDir, 'Library', 'Application Support');
  const launcherPath = path.join(support, 'Resonant Sidecar', 'native-host');
  const manifestPath = path.join(support, 'Google', 'Chrome Dev', 'NativeMessagingHosts', 'com.resonantmirror.sidecar.json');
  await mkdir(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const oldLauncher = '#!/bin/sh\nexec /old/v1\n';
  const oldManifest = '{"name":"com.resonantmirror.sidecar","path":"/old/v1"}\n';
  await writeFile(launcherPath, oldLauncher, { mode: 0o700 });
  await writeFile(manifestPath, oldManifest, { mode: 0o600 });
  const current = await inspectCurrentInstallation({ launcher: launcherPath, manifest: manifestPath });
  const inspection = sourceInspection();
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: inspection, homeDir, projectRoot, nodePath: process.execPath, codexPath: '/opt/codex' });
  const result = await migrateInstallation(plan);
  assert.equal(result.mode, 'prepared');
  assert.equal(result.installHash, plan.installHash);
  assert.equal(result.registration, 'unchanged-pending-stable-id-proof');
  assert.equal(await readFile(plan.paths.launcher, 'utf8'), oldLauncher);
  assert.equal(await readFile(plan.paths.manifest, 'utf8'), oldManifest);
  assert.equal((await stat(plan.paths.launcher)).mode & 0o777, 0o700);
  assert.equal((await stat(plan.paths.manifest)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(projectRoot, 'runtime'))).mode & 0o777, 0o700);
  assert.equal(await readFile(path.join(plan.paths.recovery, 'native-host'), 'utf8'), oldLauncher);
  assert.equal(await readFile(path.join(plan.paths.recovery, 'native-host-manifest.json'), 'utf8'), oldManifest);
  assert.equal((await stat(path.join(plan.paths.recovery, 'native-host'))).mode & 0o777, 0o400);
  for (const file of inspection.trustedBootstrap.files) assert.deepEqual(await readFile(path.join(plan.paths.trustedBootstrap, file.relativePath)), file.bytes);
  for (const file of inspection.bundle.files) assert.deepEqual(await readFile(path.join(plan.paths.activeBundle, file.relativePath)), file.bytes);
  assert.deepEqual(await readFile(path.join(plan.paths.stableExtension, 'manifest.json')), inspection.bundle.files.find(file => file.relativePath === 'extension/manifest.json').bytes);
  await execFileAsync(process.execPath, ['--check', path.join(plan.paths.trustedBootstrap, 'runtime-entry.js')]);
  t.after(async () => { await chmod(path.join(plan.paths.recovery, 'native-host'), 0o600).catch(() => {}); });
});

test('failed preparation records visible journal state while leaving V1 registration unchanged', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-migrate-journal-')));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'runtime'), { recursive: true, mode: 0o700 });
  const launcherPath = path.join(homeDir, 'Library', 'Application Support', 'Resonant Sidecar', 'native-host');
  const manifestPath = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome Dev', 'NativeMessagingHosts', 'com.resonantmirror.sidecar.json');
  await mkdir(path.dirname(launcherPath), { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const oldLauncher = '#!/bin/sh\nexec /old/v1\n';
  const oldManifest = '{"name":"com.resonantmirror.sidecar","path":"/old/v1"}\n';
  await writeFile(launcherPath, oldLauncher, { mode: 0o700 });
  await writeFile(manifestPath, oldManifest, { mode: 0o600 });
  const current = await inspectCurrentInstallation({ launcher: launcherPath, manifest: manifestPath });
  const inspection = sourceInspection();
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: inspection, homeDir, projectRoot, nodePath: process.execPath, codexPath: '/opt/codex' });
  inspection.trustedBootstrap.files[0].bytes[0] ^= 0xff;
  await assert.rejects(() => migrateInstallation(plan), /pinned source unavailable/i);
  assert.equal(await readFile(launcherPath, 'utf8'), oldLauncher);
  assert.equal(await readFile(manifestPath, 'utf8'), oldManifest);
  const journal = JSON.parse(await readFile(plan.paths.journal, 'utf8'));
  assert.equal(journal.state, 'preparation-failed');
  assert.equal(journal.installHash, plan.installHash);
  assert.equal(journal.recovery, plan.paths.recovery);
});

test('migration fails closed on stale hash and symlink target without replacing registration', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-migrate-fail-')));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'runtime'), { recursive: true, mode: 0o700 });
  const support = path.join(homeDir, 'Library', 'Application Support');
  const launcherPath = path.join(support, 'Resonant Sidecar', 'native-host');
  const manifestPath = path.join(support, 'Google', 'Chrome Dev', 'NativeMessagingHosts', 'com.resonantmirror.sidecar.json');
  await mkdir(path.dirname(launcherPath), { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(launcherPath, 'old', { mode: 0o700 });
  await writeFile(manifestPath, 'old-manifest', { mode: 0o600 });
  const current = await inspectCurrentInstallation({ launcher: launcherPath, manifest: manifestPath });
  const args = { extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir, projectRoot, nodePath: process.execPath, codexPath: '/opt/codex' };
  const stale = buildInstallPlan(args);
  await writeFile(launcherPath, 'changed', { mode: 0o700 });
  await assert.rejects(() => migrateInstallation(stale), /current installation changed/i);
  assert.equal(await readFile(manifestPath, 'utf8'), 'old-manifest');
  await writeFile(launcherPath, 'old', { mode: 0o700 });
  const freshCurrent = await inspectCurrentInstallation({ launcher: launcherPath, manifest: manifestPath });
  const symlinkPlan = buildInstallPlan({ ...args, expectedCurrentHash: freshCurrent.currentHash, currentInstallation: freshCurrent });
  await mkdir(path.dirname(symlinkPlan.paths.stableExtension), { recursive: true });
  await import('node:fs/promises').then(fs => fs.symlink('/tmp', symlinkPlan.paths.stableExtension));
  await assert.rejects(() => migrateInstallation(symlinkPlan), /symbolic link|custody/i);
  assert.equal(await readFile(launcherPath, 'utf8'), 'old');
  assert.equal(await readFile(manifestPath, 'utf8'), 'old-manifest');
});
