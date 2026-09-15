import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { canonicalJson, sha256Bytes, sha256Json } from '../review/canonical-json.js';
import { VersionStore } from '../bootstrap/version-store.js';
import { buildInstallPlan, inspectExecutable, migrateInstallation, parseInstallerArgs, switchRegistration } from '../scripts/install-macos.js';
import { inspectCurrentInstallation, verifyInstallPlan, verifyStoredMigrationChain } from '../scripts/verify-install-plan.js';
import { loadReviewPolicy } from '../review/policy-registry.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const COMMIT = 'b'.repeat(40);
const execFileAsync = promisify(execFile);
const codexIdentity = executable => ({ path: executable, bytes: 7, sha256: '9'.repeat(64), mode: 0o700 });

test('V2 install plan seals exact control identities and omits declaration-only semantic input', () => {
  const plan = fixturePlan('/tmp/v2-dry-run');
  assert.equal(plan.reviewPolicyVersion, 2);
  assert.equal(plan.controlPlane.files.length, 49);
  assert.equal(plan.trustedBootstrap.files.length, 40);
  assert.equal(plan.stableExtension.files.length, 8);
  const contract = plan.trustedBootstrap.files.find(file => file.path === 'review/chrome-review-contract.js');
  assert.equal(contract.sha256, plan.stableExtension.files.find(file => file.path === 'chrome-review-contract.js').sha256);
  assert.equal(contract.sha256, plan.controlPlane.contractDigest);
  assert.doesNotMatch(plan.runtimeEntry.contents, /Committed local bundle; canonical manifests and deterministic checks are authoritative/);
  assert.match(plan.runtimeEntry.contents, /loadReviewPolicy\(2\)/);
  assert.match(plan.runtimeEntry.contents, /chromeContext/);
  assert.match(plan.runtimeEntry.contents, /chromeReviewJournal/);
  assert.match(plan.runtimeEntry.contents, /expected && \(info\.nlink !== 1 \|\| \(info\.mode & 0o7777\) !== 0o400\)/);
  assert.doesNotMatch(plan.runtimeEntry.contents, /!info\.isFile\(\) \|\| info\.nlink !== 1 \|\| \(expected &&/);
});

test('V2 stored plan verifier rejects omitted inventory and inconsistent shared contract before approval hash', () => {
  const original = fixturePlan('/tmp/v2-dry-run');
  for (const mutate of [
    plan => plan.trustedBootstrap.files.splice(0, 1),
    plan => plan.stableExtension.files.splice(0, 1),
    plan => { plan.trustedBootstrap.digest = 'f'.repeat(64); },
    plan => { plan.controlPlane.contractDigest = 'f'.repeat(64); },
    plan => { plan.stableExtension.files.find(file => file.path === 'chrome-review-contract.js').sha256 = 'f'.repeat(64); },
  ]) {
    const plan = structuredClone(original); mutate(plan);
    assert.throws(() => verifyInstallPlan(plan), /inventory|control|digest|graph/);
  }
});

test('generated V2 runtime executes pinned coordinator wiring with V2 receipts and current adapter custody', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-entry-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'project/runtime'), { recursive: true, mode: 0o700 });
  const plan = fixturePlan(root), inspection = sourceInspection();
  const probe = async (entry, repository, stableRoot, sources) => {
    const assert = (await import('node:assert/strict')).default;
    const { SourceTextModule, SyntheticModule } = await import('node:vm');
    const fs = await import('node:fs');
    const { ReviewCoordinator } = await import(`${repository}/review/review-coordinator.js`);
    let deps, receiptPolicy, bootstrap, drift = false;
    const chromePath = '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev';
    const body = file => file === chromePath ? Buffer.from('observed-browser') : Buffer.from(sources[file]);
    const journal = { recover: async () => 'empty', snapshot: () => 'journal-snapshot', finish: async (...args) => args, markReceipted: async hash => hash };
    const controller = { closed: Promise.resolve(), chromeReviewJournal: journal, chromeReviewIdentity: { activeDigest: 'a'.repeat(64), runtimeGeneration: 1, channelId: 'channel', restartId: 'restart' },
      requestChromeReview: async request => request, mintChromeInvocation: () => 'minted', chromeReviewStatus: binding => binding, completeChromeReview: binding => binding };
    const module = new SourceTextModule(entry, { initializeImportMeta: meta => { meta.url = 'file:///sealed/runtime-entry.js'; } });
    await module.link(async specifier => {
      let exports;
      if (specifier === 'node:fs') exports = { constants: fs.constants, openSync: (file, flags) => { assert.equal(flags & fs.constants.O_WRONLY, 0); body(file); return file; },
        fstatSync: file => ({ isFile: () => true, nlink: 1, mode: 0o400, size: body(file).length }), readFileSync: file => drift && file.endsWith('chrome-review-adapter.js') ? Buffer.from('changed') : body(file), closeSync() {} };
      else if (specifier === 'node:child_process') exports = { execFileSync: () => assert.fail('No process starts during runtime construction') };
      else if (specifier === './bootstrap/host.js') exports = { runBootstrap: async input => { bootstrap = input; return controller; } };
      else if (specifier === './review/review-coordinator.js') exports = { ReviewCoordinator: class extends ReviewCoordinator { constructor(input) { super(input); deps = input; } } };
      else if (specifier === './review/receipt-store.js') {
        const { ReceiptStore } = await import(`${repository}/review/receipt-store.js`);
        exports = { ReceiptStore: class extends ReceiptStore { constructor(input) { super(input); receiptPolicy = input.policy; } } };
      } else if (specifier.endsWith('.json')) exports = { default: JSON.parse(fs.readFileSync(new URL(specifier, `${repository}/`), 'utf8')) };
      else exports = await import(specifier.startsWith('.') ? new URL(specifier, `${repository}/`).href : specifier);
      return new SyntheticModule(Object.keys(exports), function () { for (const key of Object.keys(exports)) this.setExport(key, exports[key]); });
    });
    await module.evaluate();
    assert.equal(receiptPolicy?.schemaVersion, 2, 'Generated receipt store must select V2');
    assert.equal(deps.policy.schemaVersion, 2);
    assert.ok(bootstrap.coordinator instanceof ReviewCoordinator);
    assert.equal(deps.codexInput.diff, undefined);
    assert.equal(deps.codexReview, (await import(`${repository}/review/codex-verifier.js`)).runCodexReview);
    assert.equal(bootstrap.chromeReview.projectRoot, bootstrap.workspace);
    assert.equal(deps.deterministicInput.trustedHarness.stableExtension.root, stableRoot);
    assert.equal(deps.chromeJournal.snapshot(), 'journal-snapshot');
    assert.equal(await deps.chromeJournal.markReceipted('bound-hash'), 'bound-hash');
    assert.equal(deps.mintChromeInvocation(), 'minted');
    assert.equal(deps.chromeContext().adapterDigest, (await import(`${repository}/review/canonical-json.js`)).sha256Bytes(body(`${stableRoot}/chrome-review-adapter.js`)));
    assert.equal(deps.chromeContext().componentObservation.status, 'not-collected');
    assert.deepEqual(deps.chromeContext().browserObservation, bootstrap.chromeReview.browserObservation);
    drift = true;
    assert.throws(() => deps.chromeContext(), /Pinned control/);
  };
  const repository = new URL('../', import.meta.url).href.replace(/\/$/, '');
  const sources = Object.fromEntries(inspection.stableExtension.files.map(file => [path.join(plan.paths.stableExtension, file.relativePath.slice(10)), file.bytes.toString('utf8')]));
  sources['/sealed/review/chrome-review-contract.js'] = inspection.trustedBootstrap.files.find(file => file.relativePath === 'review/chrome-review-contract.js').bytes.toString('utf8');
  await execFileAsync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `await (${probe.toString()})(${JSON.stringify(plan.runtimeEntry.contents)},${JSON.stringify(repository)},${JSON.stringify(plan.paths.stableExtension)},${JSON.stringify(sources)});`]);
});

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
  const policy = loadReviewPolicy(2);
  const artifact = file => sourceArtifact(file, readFileSync(new URL(`../${file}`, import.meta.url)));
  const bundleFiles = policy.approvedBundlePaths.map(artifact);
  const trustedFiles = policy.trustedControlPaths.filter(file => !file.startsWith('extension/') && !file.startsWith('scripts/')).map(artifact);
  const extensionFiles = policy.trustedControlPaths.filter(file => file.startsWith('extension/')).map(artifact);
  const controlFiles = policy.trustedControlPaths.map(file => { const item = artifact(file); return { path: file, bytes: item.bytes.length, mode: item.mode, sha256: item.sha256 }; });
  const manifest = {
    schemaVersion: 1,
    sourceCommit: COMMIT,
    files: bundleFiles.map(({ relativePath, bytes, mode, sha256 }) => ({ path: relativePath, bytes: bytes.length, mode, sha256 })),
    capabilities: { chromePermissions: ['nativeMessaging', 'sidePanel', 'storage'], hostPermissions: [], lifecycleScripts: ['test'], listeners: [] },
    dependencies: { lockfiles: [], packageManager: null, runtime: [] },
  };
  manifest.bundleDigest = sha256Json(manifest);
  return {
    sourceCommit: COMMIT,
    bundle: { manifest, files: bundleFiles },
    trustedBootstrap: { digest: sha256Json(trustedFiles.map(({ relativePath, sha256, mode }) => ({ path: relativePath, sha256, mode }))), files: trustedFiles },
    stableExtension: { files: extensionFiles },
    controlPlane: { files: controlFiles, digest: sha256Json(controlFiles), policyDigest: sha256Json(policy), schemaDigest: sha256Json(JSON.parse(readFileSync(new URL('../policy/chrome-language-model.v2.schema.json', import.meta.url)))),
      adapterDigest: artifact('extension/chrome-review-adapter.js').sha256, contractDigest: artifact('review/chrome-review-contract.js').sha256 },
    declarationComparison: { passed: true, checks: [{ name: 'v1-capabilities', passed: true }] },
  };
}

function fixturePlan(root, codexSha256 = '9'.repeat(64)) {
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const launcher = path.join(homeDir, 'Library/Application Support/Resonant Sidecar/native-host');
  const manifest = path.join(homeDir, 'Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json');
  const current = currentIdentity(launcher, manifest);
  return buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir, projectRoot, nodePath: '/opt/node/bin/node', codexPath: '/opt/codex', codexExecutable: { ...codexIdentity('/opt/codex'), sha256: codexSha256 } });
}

async function writeStoredMigrationChain(plan) {
  await mkdir(plan.paths.migrationReceipts, { recursive: true, mode: 0o700 });
  for (const name of ['before', 'migration', 'after']) {
    const body = `${canonicalJson(plan.receipts[name])}\n`;
    await writeFile(path.join(plan.paths.migrationReceipts, `${name}.json`), body, { mode: 0o400 });
    await writeFile(path.join(plan.paths.migrationReceipts, `${name}.sha256`), `${sha256Bytes(body)}\n`, { mode: 0o400 });
  }
}

async function storedFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-stored-receipts-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = fixturePlan(root);
  await writeStoredMigrationChain(plan);
  return { root, plan };
}

async function replaceSealed(file, body) {
  await chmod(file, 0o600);
  await writeFile(file, body);
  await chmod(file, 0o400);
}

test('migration requires the exact explicit confirmation triple', () => {
  const currentHash = 'a'.repeat(64);
  const installHash = 'b'.repeat(64);
  assert.deepEqual(parseInstallerArgs([]), { migrate: false, switchRegistration: false, extensionId: null, expectedCurrentHash: null, reviewedInstallHash: null, observedStableId: null });
  assert.throws(() => parseInstallerArgs(['--migrate']), /extension-id/i);
  assert.throws(() => parseInstallerArgs(['--migrate', '--extension-id', EXTENSION_ID]), /expected-current-hash/i);
  assert.throws(() => parseInstallerArgs(['--migrate', '--extension-id', EXTENSION_ID, '--expected-current-hash', currentHash]), /reviewed-install-hash/i);
  assert.throws(() => parseInstallerArgs(['--migrate', '--extension-id', EXTENSION_ID, '--expected-current-hash', currentHash, '--reviewed-install-hash', installHash, '--reviewed-install-hash', installHash]), /duplicate/i);
  assert.throws(() => parseInstallerArgs(['--extension-id', EXTENSION_ID, '--expected-current-hash', currentHash]), /migrate|switch-registration/i);
  assert.throws(() => parseInstallerArgs(['--install', '--extension-id', EXTENSION_ID]), /unknown/i);
  assert.deepEqual(parseInstallerArgs(['--migrate', '--extension-id', EXTENSION_ID, '--expected-current-hash', currentHash, '--reviewed-install-hash', installHash]), { migrate: true, switchRegistration: false, extensionId: EXTENSION_ID, expectedCurrentHash: currentHash, reviewedInstallHash: installHash, observedStableId: null });
});

test('registration switch requires the confirmation triple and observed stable-path ID', () => {
  const currentHash = 'a'.repeat(64);
  const installHash = 'b'.repeat(64);
  assert.throws(() => parseInstallerArgs(['--switch-registration']), /extension-id/i);
  assert.throws(() => parseInstallerArgs(['--switch-registration', '--extension-id', EXTENSION_ID, '--expected-current-hash', currentHash, '--reviewed-install-hash', installHash]), /observed-stable-id/i);
  assert.throws(() => parseInstallerArgs(['--migrate', '--switch-registration', '--extension-id', EXTENSION_ID, '--expected-current-hash', currentHash, '--reviewed-install-hash', installHash, '--observed-stable-id', EXTENSION_ID]), /mutually exclusive/i);
  assert.throws(() => parseInstallerArgs(['--observed-stable-id', EXTENSION_ID]), /switch-registration/i);
  assert.deepEqual(parseInstallerArgs(['--switch-registration', '--extension-id', EXTENSION_ID, '--expected-current-hash', currentHash, '--reviewed-install-hash', installHash, '--observed-stable-id', EXTENSION_ID]), { migrate: false, switchRegistration: true, extensionId: EXTENSION_ID, expectedCurrentHash: currentHash, reviewedInstallHash: installHash, observedStableId: EXTENSION_ID });
});

test('inspects a concrete non-symlink Codex executable and binds its bytes', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-codex-path-'))); t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const executable = path.join(root, 'codex-real');
  await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });
  const identity = await inspectExecutable(executable);
  assert.deepEqual(identity, { path: executable, bytes: 10, sha256: sha256Bytes('#!/bin/sh\n'), mode: 0o700 });
  const link = path.join(root, 'codex'); await symlink(executable, link);
  await assert.rejects(() => inspectExecutable(link), /symlink|concrete/i);
});

test('dry-run plan targets Chrome Dev and a trusted installed bootstrap with one exact unchanged origin', () => {
  const launcherPath = '/Users/example/Library/Application Support/Resonant Sidecar/native-host';
  const manifestPath = '/Users/example/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json';
  const current = currentIdentity(launcherPath, manifestPath);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir: '/Users/example', nodePath: '/opt/node/bin/node', codexPath: '/Users/example/.local/bin/codex', codexExecutable: codexIdentity('/Users/example/.local/bin/codex'), projectRoot: '/Users/example/resonant-sidecar' });
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.browser, 'Google Chrome Dev');
  assert.equal(plan.paths.manifest, '/Users/example/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json');
  assert.equal(plan.paths.stableExtension, '/Users/example/Library/Application Support/Resonant Sidecar/extension');
  assert.equal(plan.paths.trustedBootstrap, '/Users/example/Library/Application Support/Resonant Sidecar/trusted-bootstrap');
  assert.equal(plan.paths.reviewHome, '/Users/example/Library/Application Support/Resonant Sidecar/codex-review-home');
  assert.deepEqual(plan.codexExecutable, { path: '/Users/example/.local/bin/codex', bytes: 7, sha256: '9'.repeat(64), mode: 0o700 });
  assert.deepEqual(plan.reviewHome, { destination: plan.paths.reviewHome, mode: 0o700 });
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
  assert.match(plan.trustedBootstrap.files.find(file => file.path === 'runtime-entry.js').sha256, /^[a-f0-9]{64}$/);
  assert.match(plan.trustedBootstrap.files.find(file => file.path === 'runtime-entry.js') ? plan.launcher.contents : '', /runtime-entry/);
  assert.doesNotMatch(plan.launcher.contents, /resonant-sidecar\/native-host\/host\.js/);
  assert.doesNotMatch(plan.launcher.contents, /localhost|127\.0\.0\.1|remote-debugging|WebSocket/i);
  assert.equal(plan.before.currentHash, current.currentHash);
  assert.equal(plan.receipts.before.eventType, 'migration-before');
  assert.equal(plan.receipts.migration.eventType, 'migration-prepared');
  assert.equal(plan.receipts.after.eventType, 'migration-files-prepared');
  assert.deepEqual(plan.receipts.before.registration.launcher, plan.before.launcher);
  assert.deepEqual(plan.receipts.before.registration.manifest, plan.before.manifest);
  assert.ok(plan.receipts.before.inventory.some(file => file.destination === plan.runtimeEntry.destination && file.mode === 0o400));
  assert.ok(plan.receipts.before.inventory.some(file => file.destination === plan.activePin.destination && file.mode === 0o600));
  verifyInstallPlan(plan);
});

test('generated trusted entry adapts the verified active bundleRoot for deterministic review', () => {
  const launcherPath = '/Users/example/Library/Application Support/Resonant Sidecar/native-host';
  const manifestPath = '/Users/example/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json';
  const current = currentIdentity(launcherPath, manifestPath);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir: '/Users/example', nodePath: '/opt/node/bin/node', codexPath: '/opt/codex', codexExecutable: { path: '/opt/codex', bytes: 5, sha256: '8'.repeat(64), mode: 0o700 }, projectRoot: '/Users/example/repo' });
  const entry = plan.trustedBootstrap.files.find(file => file.path === 'runtime-entry.js');
  assert.equal(entry.sha256, plan.trustedBootstrap.entryDigest);
  assert.match(plan.runtimeEntry.contents, /active:\s*\{\s*\.\.\.input\.active,\s*root:\s*input\.active\.bundleRoot\s*\}/);
});

test('migration requires the exact reviewed install hash before its first write', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-approval-')));
  const homeDir = path.join(root, 'home'); const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'runtime'), { recursive: true, mode: 0o700 });
  const launcher = path.join(homeDir, 'Library/Application Support/Resonant Sidecar/native-host');
  const manifest = path.join(homeDir, 'Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json');
  await mkdir(path.dirname(launcher), { recursive: true }); await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(launcher, 'old', { mode: 0o700 }); await writeFile(manifest, 'manifest', { mode: 0o600 });
  const current = await inspectCurrentInstallation({ launcher, manifest });
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir, projectRoot, nodePath: process.execPath, codexPath: process.execPath, codexExecutable: { path: process.execPath, bytes: (await stat(process.execPath)).size, sha256: sha256Bytes(await readFile(process.execPath)), mode: (await stat(process.execPath)).mode & 0o777 } });
  await assert.rejects(() => migrateInstallation(plan), /reviewed install hash/i);
  await assert.rejects(() => migrateInstallation(plan, { reviewedInstallHash: 'f'.repeat(64) }), /reviewed install hash/i);
  const changed = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir, projectRoot, nodePath: process.execPath, codexPath: process.execPath, codexExecutable: { ...plan.codexExecutable, sha256: 'e'.repeat(64) } });
  await assert.rejects(() => migrateInstallation(plan, { reviewedInstallHash: plan.installHash, regeneratePlan: async () => changed }), /regenerated plan/i);
  await assert.rejects(() => lstat(plan.paths.journal), /ENOENT/);
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
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir: root, projectRoot: path.join(root, 'repo'), nodePath: '/opt/node/bin/node', codexPath: '/opt/codex', codexExecutable: codexIdentity('/opt/codex') });
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
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir: root, projectRoot: path.join(root, 'repo'), nodePath: '/opt/node/bin/node', codexPath: '/opt/codex', codexExecutable: codexIdentity('/opt/codex') });
  const planPath = path.join(root, 'reviewed-plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const before = await stat(planPath);
  const { stdout } = await execFileAsync(process.execPath, [path.resolve('scripts/verify-install-plan.js'), planPath], { cwd: path.resolve('.') });
  assert.equal(stdout, `${plan.installHash}\n`);
  const after = await stat(planPath);
  assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
});

test('stored migration chain verifier is read-only and bound to the exact reviewed plan', async t => {
  const { root, plan } = await storedFixture(t);
  const before = await Promise.all(['before.json', 'before.sha256', 'migration.json', 'migration.sha256', 'after.json', 'after.sha256'].map(async name => {
    const info = await stat(path.join(plan.paths.migrationReceipts, name));
    return [name, info.ino, info.size, info.mtimeMs, info.mode & 0o777];
  }));
  const result = await verifyStoredMigrationChain(plan);
  assert.deepEqual(result, { installHash: plan.installHash, receiptRoot: plan.paths.migrationReceipts, finalReceiptHash: plan.receipts.after.receiptHash });
  await assert.rejects(() => verifyStoredMigrationChain(fixturePlan(root, '8'.repeat(64))), /plan binding/i);
  const planPath = path.join(root, 'reviewed-plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const { stdout } = await execFileAsync(process.execPath, [path.resolve('scripts/verify-install-plan.js'), '--stored-chain', planPath], { cwd: path.resolve('.') });
  assert.deepEqual(JSON.parse(stdout), result);
  const after = await Promise.all(['before.json', 'before.sha256', 'migration.json', 'migration.sha256', 'after.json', 'after.sha256'].map(async name => {
    const info = await stat(path.join(plan.paths.migrationReceipts, name));
    return [name, info.ino, info.size, info.mtimeMs, info.mode & 0o777];
  }));
  assert.deepEqual(after, before);
});

test('stored migration chain verifier rejects custody and chain substitution', async t => {
  const cases = [
    ['tampered receipt', async plan => replaceSealed(path.join(plan.paths.migrationReceipts, 'before.json'), `${canonicalJson({ ...plan.receipts.before, eventType: 'migration-tampered' })}\n`)],
    ['noncanonical receipt bytes', async plan => replaceSealed(path.join(plan.paths.migrationReceipts, 'before.json'), `${JSON.stringify(plan.receipts.before, null, 2)}\n`)],
    ['extra entry', async plan => writeFile(path.join(plan.paths.migrationReceipts, 'extra.json'), '{}\n', { mode: 0o400 })],
    ['missing entry', async plan => unlink(path.join(plan.paths.migrationReceipts, 'after.sha256'))],
    ['reordered receipts', async plan => {
      const before = `${canonicalJson(plan.receipts.before)}\n`; const migration = `${canonicalJson(plan.receipts.migration)}\n`;
      await replaceSealed(path.join(plan.paths.migrationReceipts, 'before.json'), migration);
      await replaceSealed(path.join(plan.paths.migrationReceipts, 'before.sha256'), `${sha256Bytes(migration)}\n`);
      await replaceSealed(path.join(plan.paths.migrationReceipts, 'migration.json'), before);
      await replaceSealed(path.join(plan.paths.migrationReceipts, 'migration.sha256'), `${sha256Bytes(before)}\n`);
    }],
    ['predecessor substitution', async plan => {
      const changed = { ...plan.receipts.after, previousReceiptHash: 'f'.repeat(64) };
      delete changed.receiptHash; changed.receiptHash = sha256Json(changed);
      const body = `${canonicalJson(changed)}\n`;
      await replaceSealed(path.join(plan.paths.migrationReceipts, 'after.json'), body);
      await replaceSealed(path.join(plan.paths.migrationReceipts, 'after.sha256'), `${sha256Bytes(body)}\n`);
    }],
    ['sidecar substitution', async plan => replaceSealed(path.join(plan.paths.migrationReceipts, 'after.sha256'), `${'f'.repeat(64)}\n`)],
    ['permissive file mode', async plan => chmod(path.join(plan.paths.migrationReceipts, 'before.json'), 0o600)],
    ['symlinked receipt', async plan => {
      const target = path.join(plan.paths.migrationReceipts, 'after.json'); await unlink(target); await symlink(path.join(plan.paths.migrationReceipts, 'before.json'), target);
    }],
    ['hardlinked receipt', async plan => {
      const target = path.join(plan.paths.migrationReceipts, 'after.json'); await unlink(target); await link(path.join(plan.paths.migrationReceipts, 'before.json'), target);
    }],
    ['permissive receipt directory', async plan => chmod(plan.paths.migrationReceipts, 0o755)],
  ];
  for (const [name, mutate] of cases) await t.test(name, async subtest => {
    const { plan } = await storedFixture(subtest);
    await mutate(plan);
    await assert.rejects(() => verifyStoredMigrationChain(plan), /stored migration|receipt|custody|chain|entry|mode|canonical|sidecar/i);
  });
});

test('stored migration chain verifier catches mutations after its initial inventory snapshot', async t => {
  const cases = [
    ['add', async plan => writeFile(path.join(plan.paths.migrationReceipts, 'late-extra'), 'late', { mode: 0o400 })],
    ['chmod', async plan => chmod(path.join(plan.paths.migrationReceipts, 'before.json'), 0o600)],
    ['hardlink', async plan => {
      const target = path.join(plan.paths.migrationReceipts, 'after.json'); await unlink(target); await link(path.join(plan.paths.migrationReceipts, 'before.json'), target);
    }],
    ['remove', async plan => unlink(path.join(plan.paths.migrationReceipts, 'after.sha256'))],
    ['swap', async plan => {
      const target = path.join(plan.paths.migrationReceipts, 'before.json'); const bytes = await readFile(target); await unlink(target); await writeFile(target, bytes, { mode: 0o400 });
    }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async subtest => {
    const { plan } = await storedFixture(subtest);
    const ready = Promise.withResolvers(); const release = Promise.withResolvers();
    const verification = verifyStoredMigrationChain(plan, { afterInitialInventory: async () => { ready.resolve(); await release.promise; } });
    await ready.promise;
    try { await mutate(plan); } finally { release.resolve(); }
    await assert.rejects(verification, /stored migration|receipt|custody|changed|entries/i);
  });
});

test('stored migration chain verifier catches transient same-UID mutations restored before receipt reads', async t => {
  const cases = [
    ['add-remove', async plan => {
      const extra = path.join(plan.paths.migrationReceipts, 'transient-extra');
      await writeFile(extra, 'transient', { mode: 0o400 });
      await unlink(extra);
    }],
    ['chmod-restore', async plan => {
      const target = path.join(plan.paths.migrationReceipts, 'before.json');
      await chmod(target, 0o600);
      await chmod(target, 0o400);
    }],
    ['inode-swap-restore', async plan => {
      const target = path.join(plan.paths.migrationReceipts, 'before.json');
      const backup = path.join(plan.paths.migrationReceipts, '.before.original');
      const bytes = await readFile(target);
      await rename(target, backup);
      await writeFile(target, bytes, { mode: 0o400 });
      await unlink(target);
      await rename(backup, target);
    }],
  ];
  for (const [name, mutateAndRestore] of cases) await t.test(name, async subtest => {
    const { plan } = await storedFixture(subtest);
    const ready = Promise.withResolvers(); const release = Promise.withResolvers();
    const verification = verifyStoredMigrationChain(plan, { afterInitialInventory: async () => { ready.resolve(); await release.promise; } });
    await ready.promise;
    try { await mutateAndRestore(plan); } finally { release.resolve(); }
    await assert.rejects(verification, /stored migration|receipt|custody|changed|entries/i);
  });
});

test('stored migration chain verifier requires current-user ownership', async t => {
  const { plan } = await storedFixture(t);
  const getuid = process.getuid;
  process.getuid = () => getuid() + 1;
  try { await assert.rejects(() => verifyStoredMigrationChain(plan), /owner|custody/i); }
  finally { process.getuid = getuid; }
});

test('plan verifier rejects unproved registration and redirected artifact destinations', () => {
  const launcherPath = '/Users/example/Library/Application Support/Resonant Sidecar/native-host';
  const manifestPath = '/Users/example/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json';
  const current = currentIdentity(launcherPath, manifestPath);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir: '/Users/example', projectRoot: '/Users/example/repo', nodePath: '/opt/node/bin/node', codexPath: '/opt/codex', codexExecutable: codexIdentity('/opt/codex') });
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
  const brokenChain = structuredClone(plan);
  brokenChain.receipts.after.previousReceiptHash = 'f'.repeat(64);
  assert.throws(() => verifyInstallPlan(brokenChain), /receipt chain/i);
});

test('Codex executable tamper is detected before any migration write', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-codex-tamper-')));
  const homeDir = path.join(root, 'home'); const projectRoot = path.join(root, 'project'); await mkdir(path.join(projectRoot, 'runtime'), { recursive: true, mode: 0o700 });
  const launcher = path.join(homeDir, 'Library/Application Support/Resonant Sidecar/native-host');
  const manifest = path.join(homeDir, 'Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json');
  const codexPath = path.join(root, 'codex');
  await mkdir(path.dirname(launcher), { recursive: true }); await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(launcher, 'old', { mode: 0o700 }); await writeFile(manifest, 'manifest', { mode: 0o600 }); await writeFile(codexPath, '#!/bin/sh\n', { mode: 0o700 });
  const current = await inspectCurrentInstallation({ launcher, manifest }); const codexExecutable = await inspectExecutable(codexPath);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir, projectRoot, nodePath: process.execPath, codexPath, codexExecutable });
  await writeFile(codexPath, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await assert.rejects(() => migrateInstallation(plan, { reviewedInstallHash: plan.installHash, regeneratePlan: async () => plan }), /executable changed/i);
  await assert.rejects(() => lstat(plan.paths.journal), /ENOENT/);
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
  const concreteCodex = await realpath(process.execPath); const executableIdentity = await inspectExecutable(concreteCodex);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: inspection, homeDir, projectRoot, nodePath: process.execPath, codexPath: concreteCodex, codexExecutable: executableIdentity });
  const durabilityCalls = [];
  const result = await migrateInstallation(plan, { reviewedInstallHash: plan.installHash, regeneratePlan: async () => plan, durability: { syncDirectory: async directory => durabilityCalls.push(directory) } });
  assert.equal(result.mode, 'prepared');
  assert.equal(result.installHash, plan.installHash);
  assert.equal(result.registration, 'unchanged-pending-stable-id-proof');
  assert.equal(await readFile(plan.paths.launcher, 'utf8'), oldLauncher);
  assert.equal(await readFile(plan.paths.manifest, 'utf8'), oldManifest);
  assert.equal((await stat(plan.paths.launcher)).mode & 0o777, 0o700);
  assert.equal((await stat(plan.paths.manifest)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(projectRoot, 'runtime'))).mode & 0o777, 0o700);
  assert.equal((await stat(plan.paths.reviewHome)).mode & 0o777, 0o700);
  assert.ok(durabilityCalls.includes(path.dirname(plan.paths.activeVersion)));
  assert.equal(await readFile(path.join(plan.paths.recovery, 'native-host'), 'utf8'), oldLauncher);
  assert.equal(await readFile(path.join(plan.paths.recovery, 'native-host-manifest.json'), 'utf8'), oldManifest);
  assert.equal((await stat(path.join(plan.paths.recovery, 'native-host'))).mode & 0o777, 0o400);
  for (const file of inspection.trustedBootstrap.files) assert.deepEqual(await readFile(path.join(plan.paths.trustedBootstrap, file.relativePath)), file.bytes);
  for (const file of inspection.bundle.files) assert.deepEqual(await readFile(path.join(plan.paths.activeBundle, file.relativePath)), file.bytes);
  assert.deepEqual(await readFile(path.join(plan.paths.stableExtension, 'manifest.json')), inspection.bundle.files.find(file => file.relativePath === 'extension/manifest.json').bytes);
  await execFileAsync(process.execPath, ['--check', path.join(plan.paths.trustedBootstrap, 'runtime-entry.js')]);
  const active = await new VersionStore({ projectRoot }).resolveActiveHost();
  assert.equal(active.digest, plan.bundle.digest);
  assert.equal(active.bundleRoot, plan.paths.activeBundle);
  const receipts = await Promise.all(['before', 'migration', 'after'].map(name => readFile(path.join(plan.paths.migrationReceipts, `${name}.json`), 'utf8').then(JSON.parse)));
  assert.equal(receipts[0].installHash, plan.installHash);
  assert.equal(receipts[0].previousReceiptHash, null);
  assert.equal(receipts[1].previousReceiptHash, receipts[0].receiptHash);
  assert.equal(receipts[2].previousReceiptHash, receipts[1].receiptHash);
  assert.equal(receipts[2].stableExtensionDigest, plan.stableExtension.digest);
  assert.equal(receipts[2].runtimeEntryDigest, plan.runtimeEntry.sha256);
  assert.equal(receipts[2].inventoryHash, plan.inventoryHash);
  assert.deepEqual(receipts[2].inventory, receipts[0].inventory);
  assert.ok(receipts[2].inventory.every(file => path.isAbsolute(file.destination) && Number.isInteger(file.mode)));
  assert.equal((await verifyStoredMigrationChain(plan)).finalReceiptHash, receipts[2].receiptHash);
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
  const concreteCodex = await realpath(process.execPath); const executableIdentity = await inspectExecutable(concreteCodex);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: inspection, homeDir, projectRoot, nodePath: process.execPath, codexPath: concreteCodex, codexExecutable: executableIdentity });
  inspection.trustedBootstrap.files[0].bytes[0] ^= 0xff;
  await assert.rejects(() => migrateInstallation(plan, { reviewedInstallHash: plan.installHash, regeneratePlan: async () => plan }), /pinned source unavailable/i);
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
  const concreteCodex = await realpath(process.execPath); const executableIdentity = await inspectExecutable(concreteCodex);
  const args = { extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: sourceInspection(), homeDir, projectRoot, nodePath: process.execPath, codexPath: concreteCodex, codexExecutable: executableIdentity };
  const stale = buildInstallPlan(args);
  await writeFile(launcherPath, 'changed', { mode: 0o700 });
  await assert.rejects(() => migrateInstallation(stale, { reviewedInstallHash: stale.installHash, regeneratePlan: async () => stale }), /current installation changed/i);
  assert.equal(await readFile(manifestPath, 'utf8'), 'old-manifest');
  await writeFile(launcherPath, 'old', { mode: 0o700 });
  const freshCurrent = await inspectCurrentInstallation({ launcher: launcherPath, manifest: manifestPath });
  const symlinkPlan = buildInstallPlan({ ...args, expectedCurrentHash: freshCurrent.currentHash, currentInstallation: freshCurrent });
  await mkdir(path.dirname(symlinkPlan.paths.stableExtension), { recursive: true });
  await import('node:fs/promises').then(fs => fs.symlink('/tmp', symlinkPlan.paths.stableExtension));
  await assert.rejects(() => migrateInstallation(symlinkPlan, { reviewedInstallHash: symlinkPlan.installHash, regeneratePlan: async () => symlinkPlan }), /symbolic link|custody/i);
  assert.equal(await readFile(launcherPath, 'utf8'), 'old');
  assert.equal(await readFile(manifestPath, 'utf8'), 'old-manifest');
});

async function unsealTree(root) {
  await chmod(root, 0o700).catch(() => {});
  let entries = [];
  try { entries = await import('node:fs/promises').then(fs => fs.readdir(root, { withFileTypes: true })); }
  catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await unsealTree(full);
    else await chmod(full, 0o600).catch(() => {});
  }
}

async function preparedSwitchFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-switch-')));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  t.after(async () => {
    await unsealTree(path.join(projectRoot, 'runtime')).catch(() => {});
    await unsealTree(path.join(homeDir, 'Library/Application Support/Resonant Sidecar')).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(projectRoot, 'runtime'), { recursive: true, mode: 0o755 });
  const launcherPath = path.join(homeDir, 'Library/Application Support/Resonant Sidecar/native-host');
  const manifestPath = path.join(homeDir, 'Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json');
  await mkdir(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const oldLauncher = '#!/bin/sh\nexec /old/v1\n';
  const oldManifest = '{"name":"com.resonantmirror.sidecar","path":"/old/v1"}\n';
  await writeFile(launcherPath, oldLauncher, { mode: 0o700 });
  await writeFile(manifestPath, oldManifest, { mode: 0o600 });
  const current = await inspectCurrentInstallation({ launcher: launcherPath, manifest: manifestPath });
  const inspection = sourceInspection();
  const concreteCodex = await realpath(process.execPath);
  const executableIdentity = await inspectExecutable(concreteCodex);
  const plan = buildInstallPlan({ extensionId: EXTENSION_ID, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection: inspection, homeDir, projectRoot, nodePath: process.execPath, codexPath: concreteCodex, codexExecutable: executableIdentity });
  await migrateInstallation(plan, { reviewedInstallHash: plan.installHash, regeneratePlan: async () => plan });
  return { plan, launcherPath, manifestPath, oldLauncher, oldManifest, inspection };
}

test('registration switch refuses a mismatched observed ID without writing', async t => {
  const { plan, launcherPath, manifestPath, oldLauncher, oldManifest } = await preparedSwitchFixture(t);
  await assert.rejects(() => switchRegistration(plan, { reviewedInstallHash: plan.installHash, observedStableId: 'a'.repeat(32), regeneratePlan: async () => plan }), /observed stable-path id/i);
  assert.equal(await readFile(launcherPath, 'utf8'), oldLauncher);
  assert.equal(await readFile(manifestPath, 'utf8'), oldManifest);
});

test('registration switch refuses a stale live hash without writing', async t => {
  const { plan, launcherPath, manifestPath, oldManifest } = await preparedSwitchFixture(t);
  await writeFile(launcherPath, '#!/bin/sh\nexec /tampered\n', { mode: 0o700 });
  await assert.rejects(() => switchRegistration(plan, { reviewedInstallHash: plan.installHash, observedStableId: EXTENSION_ID, regeneratePlan: async () => plan }), /current installation changed/i);
  assert.equal(await readFile(manifestPath, 'utf8'), oldManifest);
});

test('registration switch refuses a missing stored chain without writing', async t => {
  const { plan, launcherPath, manifestPath, oldLauncher, oldManifest } = await preparedSwitchFixture(t);
  await chmod(plan.paths.migrationReceipts, 0o700);
  await rm(path.join(plan.paths.migrationReceipts, 'after.json'));
  await assert.rejects(() => switchRegistration(plan, { reviewedInstallHash: plan.installHash, observedStableId: EXTENSION_ID, regeneratePlan: async () => plan }), /stored migration|receipt|custody|entries/i);
  assert.equal(await readFile(launcherPath, 'utf8'), oldLauncher);
  assert.equal(await readFile(manifestPath, 'utf8'), oldManifest);
});

test('registration switch refuses bootstrap drift without writing', async t => {
  const { plan, launcherPath, manifestPath, oldLauncher, oldManifest } = await preparedSwitchFixture(t);
  const target = path.join(plan.paths.trustedBootstrap, 'runtime-entry.js');
  await chmod(plan.paths.trustedBootstrap, 0o700);
  await replaceSealed(target, `${await readFile(target, 'utf8')}\n`);
  await chmod(plan.paths.trustedBootstrap, 0o500);
  await assert.rejects(() => switchRegistration(plan, { reviewedInstallHash: plan.installHash, observedStableId: EXTENSION_ID, regeneratePlan: async () => plan }), /artifact verification|pinned control|changed/i);
  assert.equal(await readFile(launcherPath, 'utf8'), oldLauncher);
  assert.equal(await readFile(manifestPath, 'utf8'), oldManifest);
});

test('registration switch replaces only launcher and manifest after a matching observed ID', async t => {
  const { plan, launcherPath, manifestPath, oldLauncher, oldManifest, inspection } = await preparedSwitchFixture(t);
  const adapterBefore = await readFile(path.join(plan.paths.stableExtension, 'chrome-review-adapter.js'));
  const result = await switchRegistration(plan, { reviewedInstallHash: plan.installHash, observedStableId: EXTENSION_ID, regeneratePlan: async () => plan });
  assert.equal(result.mode, 'registration-switched');
  assert.equal(result.installHash, plan.installHash);
  assert.equal(result.extensionId, EXTENSION_ID);
  assert.equal(result.origin, `chrome-extension://${EXTENSION_ID}/`);
  assert.equal(result.liveVerification, 'pending-continuity');
  assert.equal(await readFile(launcherPath, 'utf8'), plan.launcher.contents);
  assert.equal(await readFile(manifestPath, 'utf8'), `${canonicalJson(plan.manifest.contents)}\n`);
  assert.notEqual(await readFile(launcherPath, 'utf8'), oldLauncher);
  assert.notEqual(await readFile(manifestPath, 'utf8'), oldManifest);
  assert.equal((await stat(launcherPath)).mode & 0o777, 0o700);
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(path.join(plan.paths.recovery, 'native-host'), 'utf8'), oldLauncher);
  assert.equal(await readFile(path.join(plan.paths.recovery, 'native-host-manifest.json'), 'utf8'), oldManifest);
  assert.deepEqual(await readFile(path.join(plan.paths.stableExtension, 'chrome-review-adapter.js')), adapterBefore);
  assert.deepEqual(await readFile(path.join(plan.paths.trustedBootstrap, 'runtime-entry.js')), Buffer.from(plan.runtimeEntry.contents));
  for (const file of inspection.trustedBootstrap.files) assert.deepEqual(await readFile(path.join(plan.paths.trustedBootstrap, file.relativePath)), file.bytes);
});
