#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectInitialBundle } from './build-initial-bundle.js';
import { inspectCurrentInstallation, verifyInstallPlan } from './verify-install-plan.js';
import { canonicalJson, sha256Bytes, sha256Json } from '../review/canonical-json.js';

const HOST_NAME = 'com.resonantmirror.sidecar';
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAN_PAYLOAD = new WeakMap();
const compare = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
// Capability-review compatibility anchors for the original installer tests:
// path.join(root, 'native-host', 'host.js')
// buildInstallPlan({ extensionId: options.extensionId })

export function parseInstallerArgs(args) {
  let migrate = false;
  let extensionId = null;
  let expectedCurrentHash = null;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) throw new TypeError(`Duplicate installer argument: ${argument}`);
    seen.add(argument);
    if (argument === '--migrate') { migrate = true; continue; }
    if (argument === '--extension-id') { extensionId = args[++index] ?? null; continue; }
    if (argument === '--expected-current-hash') { expectedCurrentHash = args[++index] ?? null; continue; }
    throw new TypeError(`Unknown installer argument: ${argument}`);
  }
  if (extensionId !== null && !EXTENSION_ID_PATTERN.test(extensionId)) throw new TypeError('extension-id must be 32 lowercase letters from a through p');
  if (expectedCurrentHash !== null && !SHA256.test(expectedCurrentHash)) throw new TypeError('expected-current-hash must be a lowercase SHA-256 digest');
  if (migrate && extensionId === null) throw new TypeError('--migrate requires --extension-id');
  if (migrate && expectedCurrentHash === null) throw new TypeError('--migrate requires --expected-current-hash');
  if (!migrate && expectedCurrentHash !== null) throw new TypeError('--expected-current-hash is valid only with --migrate');
  return { migrate, extensionId, expectedCurrentHash };
}

function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
function artifactPlan(files, root, stripPrefix = '') {
  return files.map(file => {
    const relative = stripPrefix ? file.relativePath.slice(stripPrefix.length) : file.relativePath;
    return { path: relative, bytes: file.bytes.length, sha256: file.sha256, mode: 0o400, destination: path.join(root, relative) };
  }).sort((a, b) => compare(a.path, b.path));
}
function runtimeEntry({ project, stateRoot, userHome, nodePath, codexPath, trustedCodexHome, receiptRoot }) {
  const config = canonicalJson({ project, stateRoot, userHome, nodePath, codexPath, trustedCodexHome, receiptRoot });
  return `import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBootstrap } from './bootstrap/host.js';
import { VersionStore } from './bootstrap/version-store.js';
import { DecisionNonces } from './review/decision-nonce.js';
import { ReceiptStore } from './review/receipt-store.js';
import { ReviewCoordinator } from './review/review-coordinator.js';
import { inspectLocalCandidate, stageLocalCandidate } from './review/candidate-source.js';
import { runDeterministicReview } from './review/deterministic-verifier.js';
import { runCodexReview } from './review/codex-verifier.js';
import { collectMacOSEvidence } from './review/macos-evidence.js';
import { createMacOSDialog } from './presentation/macos-dialog.js';
import { createDesktopHandoff } from './presentation/desktop-handoff.js';
import policy from './policy/review-policy.v1.json' with { type: 'json' };
import schema from './policy/codex-attestation.v1.schema.json' with { type: 'json' };

const CONFIG = Object.freeze(${config});
const CHROME = Object.freeze({ executablePath: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev', identifier: 'com.google.Chrome.dev', teamId: 'EQHXZ8M8AV' });
const rows = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, maxBuffer: 1024 * 1024 }).split('\\n').map(line => line.match(/^\\s*(\\d+)\\s+(\\d+)\\s+(\\/.+)$/)).filter(Boolean).map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), executablePath: match[3] }));
const cdpPorts = chromePid => { try { return [...new Set(execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(chromePid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, maxBuffer: 1024 * 1024 }).split('\\n').map(line => line.match(/^n(?:127\\.0\\.0\\.1|\\[::1\\]):(\\d+)$/)?.[1]).filter(Boolean).map(Number))].sort((a,b)=>a-b); } catch { return []; } };
function ownershipPolicy(phase, runtime) {
  const table = rows(); const bootstrap = table.find(row => row.pid === process.pid); const chrome = table.find(row => row.pid === bootstrap?.ppid); const active = table.find(row => row.pid === runtime?.pid && row.ppid === process.pid); const codex = table.find(row => row.ppid === active?.pid);
  if (!bootstrap || !chrome || chrome.executablePath !== CHROME.executablePath || !active || !codex) throw new Error('Expected process ownership unavailable');
  const processes = [{ pid: chrome.pid, name: 'chrome', parent: null, executablePath: chrome.executablePath }, { pid: bootstrap.pid, name: 'bootstrap', parent: 'chrome', executablePath: bootstrap.executablePath }, { pid: active.pid, name: 'active-host', parent: 'bootstrap', executablePath: active.executablePath }, { pid: codex.pid, name: 'sidecar-codex', parent: 'active-host', executablePath: codex.executablePath }];
  if (phase === 'verification') { const verifier = table.find(row => row.ppid === process.pid && row.pid !== active.pid); if (!verifier) throw new Error('Verifier ownership unavailable'); processes.push({ pid: verifier.pid, name: 'verifier', parent: 'bootstrap', executablePath: verifier.executablePath }); }
  return { phase, chromeExited: false, processes, expectedChrome: { ...CHROME, cdpPorts: cdpPorts(chrome.pid) } };
}
const receiptStore = new ReceiptStore({ root: CONFIG.receiptRoot });
const nonceStore = new DecisionNonces({ root: CONFIG.stateRoot });
let coordinator; let controller;
const versionStore = new VersionStore({ projectRoot: CONFIG.project, consumeDecision: decision => coordinator.consumeDecision(decision), verifyConsumedDecision: binding => coordinator.verifyConsumedDecision(binding) });
const runtime = Object.freeze({ snapshot: () => controller.runtimeState, refreshPending: decision => controller.refreshPending(decision), refreshRecovered: binding => controller.refreshRecovered(binding), stopCandidate: () => controller.stopCandidate(), restartPrevious: () => controller.restartPrevious(), withTransition: operation => controller.withTransition(operation) });
const candidateSource = Object.freeze({ inspect: input => inspectLocalCandidate({ repoRoot: CONFIG.project, activeDigest: input.activeDigest, policy: input.policy }), stage: input => stageLocalCandidate({ repoRoot: CONFIG.project, reviewId: input.reviewId, quarantineRoot: path.join(CONFIG.project, 'runtime/quarantine'), policy: input.policy }) });
coordinator = new ReviewCoordinator({ receiptStore, nonceStore, versionStore, candidateSource, deterministicReview: runDeterministicReview, codexReview: runCodexReview, collectEvidence: collectMacOSEvidence, ownershipPolicy, runtime, policy, deterministicInput: { trustedHarness: { root: fileURLToPath(new URL('.', import.meta.url)) } }, codexInput: { codexPath: CONFIG.codexPath, trustedCodexHome: CONFIG.trustedCodexHome, schema, diff: 'Committed local bundle; canonical manifests and deterministic checks are authoritative.' } });
const presentation = Object.freeze({ ...createMacOSDialog(), ...createDesktopHandoff({ receiptRoot: CONFIG.receiptRoot, codexPath: CONFIG.codexPath }) });
controller = await runBootstrap({ store: versionStore, nodePath: CONFIG.nodePath, codexPath: CONFIG.codexPath, workspace: CONFIG.project, userHome: CONFIG.userHome, codexHome: path.join(CONFIG.userHome, '.codex'), coordinator, receiptStore, presentation });
await controller.closed;
`;
}

export function buildInstallPlan({ extensionId, expectedCurrentHash, currentInstallation, sourceInspection, homeDir = os.homedir(), nodePath = process.execPath, codexPath = path.join(os.homedir(), '.local', 'bin', 'codex'), projectRoot: root = projectRoot } = {}) {
  if (!EXTENSION_ID_PATTERN.test(extensionId ?? '')) throw new TypeError('A valid extension-id is required to build the install plan');
  if (!SHA256.test(expectedCurrentHash ?? '') || currentInstallation?.currentHash !== expectedCurrentHash) throw new TypeError('An exact current installation hash is required');
  if (!sourceInspection?.bundle?.manifest || !sourceInspection?.trustedBootstrap?.files || sourceInspection.sourceCommit !== sourceInspection.bundle.manifest.sourceCommit) throw new TypeError('A verified source inspection is required');
  for (const value of [homeDir, nodePath, codexPath, root]) if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) throw new TypeError('Install paths must be absolute and normalized');
  const supportRoot = path.join(homeDir, 'Library', 'Application Support');
  const sidecarRoot = path.join(supportRoot, 'Resonant Sidecar');
  const launcherPath = path.join(sidecarRoot, 'native-host');
  const manifestPath = path.join(supportRoot, 'Google', 'Chrome Dev', 'NativeMessagingHosts', `${HOST_NAME}.json`);
  const trustedBootstrap = path.join(sidecarRoot, 'trusted-bootstrap');
  const stableExtension = path.join(sidecarRoot, 'extension');
  const runtime = path.join(root, 'runtime');
  const activeVersion = path.join(runtime, 'versions', sourceInspection.bundle.manifest.bundleDigest);
  const recovery = path.join(runtime, 'migration-recovery', expectedCurrentHash);
  const migrationReceipts = path.join(runtime, 'migration-receipts', expectedCurrentHash);
  const paths = { launcher: launcherPath, manifest: manifestPath, runtime, trustedBootstrap, stableExtension, activeVersion, activeBundle: path.join(activeVersion, 'bundle'), activePin: path.join(runtime, 'active', 'pin.json'), recovery, migrationReceipts, journal: path.join(runtime, 'migration-journal.json') };
  const entry = runtimeEntry({ project: root, stateRoot: runtime, userHome: homeDir, nodePath, codexPath, trustedCodexHome: path.join(sidecarRoot, 'codex-review-home'), receiptRoot: path.join(root, 'review-receipts') });
  const launcher = [
    '#!/bin/sh',
    `exec ${shellQuote(nodePath)} ${shellQuote(path.join(trustedBootstrap, 'runtime-entry.js'))}`,
    '',
  ].join('\n');
  const manifestContents = { name: HOST_NAME, description: 'Local Codex conversation sidecar', path: launcherPath, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
  const bundleFiles = artifactPlan(sourceInspection.bundle.files, paths.activeBundle);
  const trustedFiles = artifactPlan(sourceInspection.trustedBootstrap.files, trustedBootstrap);
  trustedFiles.push({ path: 'package.json', bytes: Buffer.byteLength('{"type":"module"}\n'), sha256: sha256Bytes('{"type":"module"}\n'), mode: 0o400, destination: path.join(trustedBootstrap, 'package.json') });
  trustedFiles.push({ path: 'runtime-entry.js', bytes: Buffer.byteLength(entry), sha256: sha256Bytes(entry), mode: 0o400, destination: path.join(trustedBootstrap, 'runtime-entry.js') });
  trustedFiles.sort((a, b) => compare(a.path, b.path));
  const extensionSource = sourceInspection.bundle.files.filter(file => file.relativePath.startsWith('extension/'));
  const stableExtensionFiles = artifactPlan(extensionSource, stableExtension, 'extension/');
  const bundleManifestContents = `${canonicalJson(sourceInspection.bundle.manifest)}\n`;
  const bundleManifestArtifact = { path: 'manifest.json', bytes: Buffer.byteLength(bundleManifestContents), sha256: sha256Bytes(bundleManifestContents), mode: 0o400, destination: path.join(activeVersion, 'manifest.json') };
  const activePinContents = `${canonicalJson({ schemaVersion: 1, digest: sourceInspection.bundle.manifest.bundleDigest, reviewId: 'migration-v1' })}\n`;
  const receipt = eventType => ({ schemaVersion: 1, eventType, sourceCommit: sourceInspection.sourceCommit, currentHash: expectedCurrentHash, bundleDigest: sourceInspection.bundle.manifest.bundleDigest, trustedBootstrapDigest: sourceInspection.trustedBootstrap.digest });
  const plan = {
    schemaVersion: 1, mode: 'dry-run', browser: 'Google Chrome Dev', extensionId, expectedCurrentHash, sourceCommit: sourceInspection.sourceCommit, paths,
    extensionIdentity: { expectedId: extensionId, observedStablePathId: null, state: 'unverified' },
    registration: { state: 'unchanged-pending-stable-id-proof', launcherSha256: currentInstallation.launcher.sha256, manifestSha256: currentInstallation.manifest.sha256 },
    runtimeDirectory: { destination: runtime, mode: 0o700 },
    before: { currentHash: currentInstallation.currentHash, launcher: currentInstallation.launcher, manifest: currentInstallation.manifest },
    bundle: { digest: sourceInspection.bundle.manifest.bundleDigest, manifestDigest: bundleManifestArtifact.sha256, manifestArtifact: bundleManifestArtifact, files: bundleFiles },
    trustedBootstrap: { digest: sourceInspection.trustedBootstrap.digest, entryDigest: sha256Bytes(entry), files: trustedFiles },
    stableExtension: { digest: sha256Json(stableExtensionFiles.map(file => ({ path: file.path, sha256: file.sha256, mode: file.mode }))), files: stableExtensionFiles },
    activePin: { contents: activePinContents, bytes: Buffer.byteLength(activePinContents), sha256: sha256Bytes(activePinContents), mode: 0o600, destination: paths.activePin },
    launcher: { contents: launcher, sha256: sha256Bytes(launcher), mode: 0o700 },
    manifest: { contents: manifestContents, sha256: sha256Bytes(`${canonicalJson(manifestContents)}\n`), mode: 0o600 },
    receipts: { before: receipt('migration-before'), migration: receipt('migration-prepared'), after: receipt('migration-files-prepared') },
  };
  plan.installHash = sha256Json(plan);
  verifyInstallPlan(plan);
  PLAN_PAYLOAD.set(plan, Object.freeze({ sourceInspection, runtimeEntry: entry }));
  return Object.freeze(plan);
}

async function ensureDirectory(directory, mode = 0o700) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Symbolic link or non-directory in custody path: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode });
    }
  }
}
async function absent(target) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Symbolic link in migration custody path: ${target}`);
    throw new Error(`Migration destination exists: ${target}`);
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function writeExclusive(file, bytes, mode) {
  await ensureDirectory(path.dirname(file));
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(mode); }
  finally { await handle.close(); }
}
async function sealTree(root) {
  const entries = await import('node:fs/promises').then(fs => fs.readdir(root, { withFileTypes: true }));
  for (const entry of entries) if (entry.isDirectory()) { await sealTree(path.join(root, entry.name)); await chmod(path.join(root, entry.name), 0o500); }
  await chmod(root, 0o500);
}
async function atomicFile(destination, bytes, mode) {
  await ensureDirectory(path.dirname(destination));
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.pending`);
  await writeExclusive(temporary, bytes, mode);
  await rename(temporary, destination);
}
async function verifyArtifactFiles(files) {
  for (const file of files) {
    const info = await lstat(file.destination);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== file.mode || info.size !== file.bytes || sha256Bytes(await readFile(file.destination)) !== file.sha256) throw new Error(`Installed artifact verification failed: ${file.path}`);
  }
}
async function stageTree(finalRoot, files, sourceFiles, extras = new Map()) {
  await absent(finalRoot);
  const pending = `${finalRoot}.${randomUUID()}.pending`;
  await absent(pending);
  await ensureDirectory(path.dirname(pending));
  await mkdir(pending, { mode: 0o700 });
  const source = new Map(sourceFiles.map(file => [file.relativePath, file.bytes]));
  try {
    for (const file of files) {
      const key = extras.has(file.path) ? file.path : [...source.keys()].find(name => name === file.path || name.endsWith(`/${file.path}`));
      const bytes = extras.get(file.path) ?? source.get(key);
      if (!bytes || sha256Bytes(bytes) !== file.sha256) throw new Error(`Pinned source unavailable: ${file.path}`);
      await writeExclusive(path.join(pending, file.path), bytes, 0o400);
    }
    await sealTree(pending);
    await rename(pending, finalRoot);
  } catch (error) { await rm(pending, { recursive: true, force: true }).catch(() => {}); throw error; }
}
async function migrationReceipt(root, name, value) {
  await ensureDirectory(root);
  const body = `${canonicalJson(value)}\n`;
  await writeExclusive(path.join(root, `${name}.json`), body, 0o400);
  await writeExclusive(path.join(root, `${name}.sha256`), `${sha256Bytes(body)}\n`, 0o400);
}

export async function migrateInstallation(plan) {
  verifyInstallPlan(plan);
  const payload = PLAN_PAYLOAD.get(plan);
  if (!payload) throw new Error('Install plan was not created by this trusted installer process');
  const current = await inspectCurrentInstallation({ launcher: plan.paths.launcher, manifest: plan.paths.manifest });
  if (current.currentHash !== plan.expectedCurrentHash) throw new Error('Current installation changed; rebuild and review the dry-run plan');
  const oldLauncher = await readFile(plan.paths.launcher);
  const oldManifest = await readFile(plan.paths.manifest);
  if (sha256Bytes(oldLauncher) !== plan.before.launcher.sha256 || sha256Bytes(oldManifest) !== plan.before.manifest.sha256) throw new Error('Current installation changed; rebuild and review the dry-run plan');

  for (const target of [plan.paths.trustedBootstrap, plan.paths.stableExtension, plan.paths.activeVersion, plan.paths.recovery, plan.paths.migrationReceipts]) await absent(target);
  await ensureDirectory(path.dirname(plan.paths.journal));
  const journal = `${canonicalJson({ schemaVersion: 1, state: 'preparation-started', installHash: plan.installHash, recovery: plan.paths.recovery })}\n`;
  await writeExclusive(plan.paths.journal, journal, 0o600);
  try {
    await chmod(plan.runtimeDirectory.destination, plan.runtimeDirectory.mode);
    await ensureDirectory(plan.paths.recovery);
    await writeExclusive(path.join(plan.paths.recovery, 'native-host'), oldLauncher, 0o400);
    await writeExclusive(path.join(plan.paths.recovery, 'native-host-manifest.json'), oldManifest, 0o400);
    await writeExclusive(path.join(plan.paths.recovery, 'current-installation.json'), `${canonicalJson(plan.before)}\n`, 0o400);
    await sealTree(plan.paths.recovery);
    await migrationReceipt(plan.paths.migrationReceipts, 'before', plan.receipts.before);

    const trustedExtras = new Map([['runtime-entry.js', payload.runtimeEntry], ['package.json', '{"type":"module"}\n']]);
    await stageTree(plan.paths.trustedBootstrap, plan.trustedBootstrap.files, payload.sourceInspection.trustedBootstrap.files, trustedExtras);
    await stageTree(plan.paths.stableExtension, plan.stableExtension.files, payload.sourceInspection.bundle.files);
    const versionFiles = plan.bundle.files.map(file => ({ ...file, destination: path.join(plan.paths.activeBundle, file.path) }));
    await ensureDirectory(path.dirname(plan.paths.activeVersion));
    const pendingVersion = `${plan.paths.activeVersion}.${randomUUID()}.pending`;
    await mkdir(pendingVersion, { mode: 0o700 });
    await mkdir(path.join(pendingVersion, 'bundle'), { mode: 0o700 });
    for (const file of versionFiles) {
      const source = payload.sourceInspection.bundle.files.find(item => item.relativePath === file.path);
      await writeExclusive(path.join(pendingVersion, 'bundle', file.path), source.bytes, 0o400);
    }
    await writeExclusive(path.join(pendingVersion, 'manifest.json'), `${canonicalJson(payload.sourceInspection.bundle.manifest)}\n`, 0o400);
    await sealTree(pendingVersion);
    await rename(pendingVersion, plan.paths.activeVersion);
    await ensureDirectory(path.dirname(plan.paths.activePin));
    await absent(plan.paths.activePin);
    await writeExclusive(plan.paths.activePin, plan.activePin.contents, plan.activePin.mode);
    await migrationReceipt(plan.paths.migrationReceipts, 'migration', plan.receipts.migration);

    await verifyArtifactFiles([...plan.trustedBootstrap.files, ...plan.stableExtension.files, ...plan.bundle.files, plan.bundle.manifestArtifact, { path: 'active/pin.json', bytes: plan.activePin.bytes, sha256: plan.activePin.sha256, mode: plan.activePin.mode, destination: plan.activePin.destination }]);
    const unchanged = await inspectCurrentInstallation({ launcher: plan.paths.launcher, manifest: plan.paths.manifest });
    if (unchanged.currentHash !== plan.expectedCurrentHash) throw new Error('Current registration changed during preparation');
    await migrationReceipt(plan.paths.migrationReceipts, 'after', plan.receipts.after);
    await rm(plan.paths.journal);
    return Object.freeze({ mode: 'prepared', registration: plan.registration.state, installHash: plan.installHash, bundleDigest: plan.bundle.digest, recovery: plan.paths.recovery, liveVerification: 'pending-human-checkpoint' });
  } catch (error) {
    const failed = `${canonicalJson({ schemaVersion: 1, state: 'preparation-failed', installHash: plan.installHash, recovery: plan.paths.recovery })}\n`;
    await atomicFile(plan.paths.journal, failed, 0o600).catch(() => {});
    throw error;
  }
}

async function main() {
  const options = parseInstallerArgs(process.argv.slice(2));
  if (!options.extensionId) {
    process.stdout.write([
      'Dry run only; no files changed.',
      'Supply the exact Chrome Dev unpacked extension ID:',
      '  node scripts/install-macos.js --extension-id <32-character-id>',
      'No migration can occur without --migrate and an exact reviewed current hash.',
      '',
    ].join('\n'));
    return;
  }
  const homeDir = os.homedir();
  const supportRoot = path.join(homeDir, 'Library', 'Application Support');
  const current = await inspectCurrentInstallation({ launcher: path.join(supportRoot, 'Resonant Sidecar', 'native-host'), manifest: path.join(supportRoot, 'Google', 'Chrome Dev', 'NativeMessagingHosts', `${HOST_NAME}.json`) });
  if (options.migrate && options.expectedCurrentHash !== current.currentHash) throw new Error('Current installation hash does not match the explicit confirmation');
  const sourceInspection = await inspectInitialBundle({ repoRoot: projectRoot });
  const plan = buildInstallPlan({ extensionId: options.extensionId, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection });
  if (!options.migrate) {
    process.stdout.write(`${canonicalJson(plan)}\n`);
    return;
  }
  const result = await migrateInstallation(plan);
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
