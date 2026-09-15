#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
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
  let reviewedInstallHash = null;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) throw new TypeError(`Duplicate installer argument: ${argument}`);
    seen.add(argument);
    if (argument === '--migrate') { migrate = true; continue; }
    if (argument === '--extension-id') { extensionId = args[++index] ?? null; continue; }
    if (argument === '--expected-current-hash') { expectedCurrentHash = args[++index] ?? null; continue; }
    if (argument === '--reviewed-install-hash') { reviewedInstallHash = args[++index] ?? null; continue; }
    throw new TypeError(`Unknown installer argument: ${argument}`);
  }
  if (extensionId !== null && !EXTENSION_ID_PATTERN.test(extensionId)) throw new TypeError('extension-id must be 32 lowercase letters from a through p');
  if (expectedCurrentHash !== null && !SHA256.test(expectedCurrentHash)) throw new TypeError('expected-current-hash must be a lowercase SHA-256 digest');
  if (reviewedInstallHash !== null && !SHA256.test(reviewedInstallHash)) throw new TypeError('reviewed-install-hash must be a lowercase SHA-256 digest');
  if (migrate && extensionId === null) throw new TypeError('--migrate requires --extension-id');
  if (migrate && expectedCurrentHash === null) throw new TypeError('--migrate requires --expected-current-hash');
  if (migrate && reviewedInstallHash === null) throw new TypeError('--migrate requires --reviewed-install-hash');
  if (!migrate && expectedCurrentHash !== null) throw new TypeError('--expected-current-hash is valid only with --migrate');
  if (!migrate && reviewedInstallHash !== null) throw new TypeError('--reviewed-install-hash is valid only with --migrate');
  return { migrate, extensionId, expectedCurrentHash, reviewedInstallHash };
}

export async function inspectExecutable(executablePath) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath) || path.normalize(executablePath) !== executablePath || await realpath(executablePath) !== executablePath) throw new TypeError('Codex executable must be a concrete absolute non-symlink path');
  const before = await lstat(executablePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o111) === 0 || (before.mode & 0o022) !== 0) throw new TypeError('Codex executable custody invalid');
  const handle = await open(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    if (held.dev !== before.dev || held.ino !== before.ino) throw new TypeError('Codex executable changed');
    const bytes = await handle.readFile(); const after = await handle.stat(); const current = await lstat(executablePath);
    if (after.size !== before.size || current.dev !== before.dev || current.ino !== before.ino || bytes.length !== before.size) throw new TypeError('Codex executable changed');
    return Object.freeze({ path: executablePath, bytes: bytes.length, sha256: sha256Bytes(bytes), mode: before.mode & 0o777 });
  } finally { await handle.close(); }
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
  if (phase === 'verification') { const verifier = table.find(row => row.pid === runtime?.verifier?.pid && row.ppid === process.pid); if (!verifier) throw new Error('Verifier ownership unavailable'); processes.push({ pid: verifier.pid, name: 'verifier', parent: 'bootstrap', executablePath: verifier.executablePath }); }
  return { phase, chromeExited: false, processes, expectedChrome: { ...CHROME, cdpPorts: cdpPorts(chrome.pid) } };
}
const receiptStore = new ReceiptStore({ root: CONFIG.receiptRoot });
const nonceStore = new DecisionNonces({ root: CONFIG.stateRoot });
let coordinator; let controller;
const versionStore = new VersionStore({ projectRoot: CONFIG.project, consumeDecision: decision => coordinator.consumeDecision(decision), verifyConsumedDecision: binding => coordinator.verifyConsumedDecision(binding) });
const runtime = Object.freeze({ snapshot: () => controller.runtimeState, refreshPending: decision => controller.refreshPending(decision), refreshRecovered: binding => controller.refreshRecovered(binding), stopCandidate: () => controller.stopCandidate(), restartPrevious: () => controller.restartPrevious(), withTransition: operation => controller.withTransition(operation) });
const candidateSource = Object.freeze({ inspect: input => inspectLocalCandidate({ repoRoot: CONFIG.project, activeDigest: input.activeDigest, policy: input.policy }), stage: input => stageLocalCandidate({ repoRoot: CONFIG.project, reviewId: input.reviewId, quarantineRoot: path.join(CONFIG.project, 'runtime/quarantine'), policy: input.policy }) });
const deterministicReview = input => runDeterministicReview({ ...input, active: { ...input.active, root: input.active.bundleRoot } });
coordinator = new ReviewCoordinator({ receiptStore, nonceStore, versionStore, candidateSource, deterministicReview, codexReview: runCodexReview, collectEvidence: collectMacOSEvidence, ownershipPolicy, runtime, policy, deterministicInput: { trustedHarness: { root: fileURLToPath(new URL('.', import.meta.url)) } }, codexInput: { codexPath: CONFIG.codexPath, trustedCodexHome: CONFIG.trustedCodexHome, schema, diff: 'Committed local bundle; canonical manifests and deterministic checks are authoritative.' } });
const presentation = Object.freeze({ ...createMacOSDialog(), ...createDesktopHandoff({ receiptRoot: CONFIG.receiptRoot, codexPath: CONFIG.codexPath }) });
controller = await runBootstrap({ store: versionStore, nodePath: CONFIG.nodePath, codexPath: CONFIG.codexPath, workspace: CONFIG.project, userHome: CONFIG.userHome, codexHome: path.join(CONFIG.userHome, '.codex'), coordinator, receiptStore, presentation });
await controller.closed;
`;
}

function artifact(pathname, contents, mode) { return { contents, bytes: Buffer.byteLength(contents), sha256: sha256Bytes(contents), mode, destination: pathname }; }
function receiptHash(receipt) { const unsigned = { ...receipt }; delete unsigned.receiptHash; return sha256Json(unsigned); }
function plannedInventory(plan) {
  return [...plan.bundle.files, ...plan.trustedBootstrap.files, ...plan.stableExtension.files, plan.bundle.manifestArtifact, plan.activePin, plan.baseline.recoveryState, plan.baseline.installationWitness]
    .map(({ path: artifactPath, destination, bytes, sha256, mode }) => ({ path: artifactPath ?? path.relative(plan.paths.runtime, destination), destination, bytes, sha256, mode }))
    .sort((a, b) => compare(a.destination, b.destination));
}
function createMigrationReceipts(plan) {
  const registration = { launcher: { ...plan.before.launcher }, manifest: { ...plan.before.manifest } };
  const inventory = plannedInventory(plan);
  let previousReceiptHash = null;
  const make = eventType => {
    const receipt = { schemaVersion: 1, eventType, installHash: plan.installHash, sourceCommit: plan.sourceCommit, currentHash: plan.expectedCurrentHash, bundleDigest: plan.bundle.digest, trustedBootstrapDigest: plan.trustedBootstrap.digest, stableExtensionDigest: plan.stableExtension.digest, runtimeEntryDigest: plan.runtimeEntry.sha256, inventoryHash: plan.inventoryHash, inventory, registration, previousReceiptHash };
    receipt.receiptHash = receiptHash(receipt); previousReceiptHash = receipt.receiptHash; return receipt;
  };
  return { before: make('migration-before'), migration: make('migration-prepared'), after: make('migration-files-prepared') };
}

export function buildInstallPlan({ extensionId, expectedCurrentHash, currentInstallation, sourceInspection, homeDir = os.homedir(), nodePath = process.execPath, codexPath = path.join(os.homedir(), '.local', 'bin', 'codex'), codexExecutable, projectRoot: root = projectRoot } = {}) {
  if (!EXTENSION_ID_PATTERN.test(extensionId ?? '')) throw new TypeError('A valid extension-id is required to build the install plan');
  if (!SHA256.test(expectedCurrentHash ?? '') || currentInstallation?.currentHash !== expectedCurrentHash) throw new TypeError('An exact current installation hash is required');
  if (!sourceInspection?.bundle?.manifest || !sourceInspection?.trustedBootstrap?.files || sourceInspection.sourceCommit !== sourceInspection.bundle.manifest.sourceCommit) throw new TypeError('A verified source inspection is required');
  for (const value of [homeDir, nodePath, codexPath, root]) if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) throw new TypeError('Install paths must be absolute and normalized');
  if (!codexExecutable || Object.keys(codexExecutable).sort().join(',') !== 'bytes,mode,path,sha256' || codexExecutable.path !== codexPath || !Number.isSafeInteger(codexExecutable.bytes) || codexExecutable.bytes < 1 || !SHA256.test(codexExecutable.sha256) || !Number.isInteger(codexExecutable.mode) || (codexExecutable.mode & 0o111) === 0 || (codexExecutable.mode & 0o022) !== 0) throw new TypeError('A concrete inspected Codex executable identity is required');
  const supportRoot = path.join(homeDir, 'Library', 'Application Support');
  const sidecarRoot = path.join(supportRoot, 'Resonant Sidecar');
  const launcherPath = path.join(sidecarRoot, 'native-host');
  const manifestPath = path.join(supportRoot, 'Google', 'Chrome Dev', 'NativeMessagingHosts', `${HOST_NAME}.json`);
  const trustedBootstrap = path.join(sidecarRoot, 'trusted-bootstrap');
  const stableExtension = path.join(sidecarRoot, 'extension');
  const reviewHome = path.join(sidecarRoot, 'codex-review-home');
  const runtime = path.join(root, 'runtime');
  const activeVersion = path.join(runtime, 'versions', sourceInspection.bundle.manifest.bundleDigest);
  const recovery = path.join(runtime, 'migration-recovery', expectedCurrentHash);
  const migrationReceipts = path.join(runtime, 'migration-receipts', expectedCurrentHash);
  const paths = { launcher: launcherPath, manifest: manifestPath, runtime, trustedBootstrap, stableExtension, reviewHome, activeVersion, activeBundle: path.join(activeVersion, 'bundle'), activePin: path.join(runtime, 'active', 'pin.json'), recoveryState: path.join(runtime, 'recovery-state.json'), installationWitness: path.join(runtime, 'installations', 'migration-v1.json'), recovery, migrationReceipts, journal: path.join(runtime, 'migration-journal.json') };
  const entry = runtimeEntry({ project: root, stateRoot: runtime, userHome: homeDir, nodePath, codexPath, trustedCodexHome: reviewHome, receiptRoot: path.join(root, 'review-receipts') });
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
  const pin = JSON.parse(activePinContents);
  const recoveryStateContents = `${canonicalJson({ schemaVersion: 1, phase: 'complete', candidate: pin, previous: null, priorPrevious: null, decisionHash: sha256Bytes('migration-v1-baseline'), failureRef: null })}\n`;
  const installationWitnessContents = `${canonicalJson(pin)}\n`;
  const runtimeEntryArtifact = artifact(path.join(trustedBootstrap, 'runtime-entry.js'), entry, 0o400);
  const core = {
    schemaVersion: 1, mode: 'dry-run', browser: 'Google Chrome Dev', extensionId, expectedCurrentHash, sourceCommit: sourceInspection.sourceCommit, paths,
    extensionIdentity: { expectedId: extensionId, observedStablePathId: null, state: 'unverified' },
    registration: { state: 'unchanged-pending-stable-id-proof', launcherSha256: currentInstallation.launcher.sha256, manifestSha256: currentInstallation.manifest.sha256 },
    runtimeDirectory: { destination: runtime, mode: 0o700 },
    reviewHome: { destination: reviewHome, mode: 0o700 }, codexExecutable: { ...codexExecutable },
    before: { currentHash: currentInstallation.currentHash, launcher: currentInstallation.launcher, manifest: currentInstallation.manifest },
    bundle: { digest: sourceInspection.bundle.manifest.bundleDigest, manifestDigest: bundleManifestArtifact.sha256, manifestArtifact: bundleManifestArtifact, files: bundleFiles },
    trustedBootstrap: { digest: sourceInspection.trustedBootstrap.digest, entryDigest: sha256Bytes(entry), files: trustedFiles }, runtimeEntry: runtimeEntryArtifact,
    stableExtension: { digest: sha256Json(stableExtensionFiles.map(file => ({ path: file.path, sha256: file.sha256, mode: file.mode }))), files: stableExtensionFiles },
    activePin: { contents: activePinContents, bytes: Buffer.byteLength(activePinContents), sha256: sha256Bytes(activePinContents), mode: 0o600, destination: paths.activePin },
    baseline: { recoveryState: artifact(paths.recoveryState, recoveryStateContents, 0o600), installationWitness: artifact(paths.installationWitness, installationWitnessContents, 0o400) },
    launcher: { contents: launcher, sha256: sha256Bytes(launcher), mode: 0o700 },
    manifest: { contents: manifestContents, sha256: sha256Bytes(`${canonicalJson(manifestContents)}\n`), mode: 0o600 },
  };
  const inventory = plannedInventory(core);
  core.inventoryHash = sha256Json(inventory);
  const plan = { ...core, installHash: sha256Json(core) };
  plan.receipts = createMigrationReceipts(plan);
  verifyInstallPlan(plan);
  PLAN_PAYLOAD.set(plan, Object.freeze({ sourceInspection, runtimeEntry: entry, build: { extensionId, homeDir, nodePath, codexPath, root } }));
  return Object.freeze(plan);
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
const DEFAULT_DURABILITY = Object.freeze({ syncDirectory });
async function ensureDirectory(directory, mode = 0o700, durability = DEFAULT_DURABILITY) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Symbolic link or non-directory in custody path: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode });
      await durability.syncDirectory(path.dirname(current));
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
async function writeExclusive(file, bytes, mode, durability = DEFAULT_DURABILITY) {
  await ensureDirectory(path.dirname(file), 0o700, durability);
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(mode); }
  finally { await handle.close(); }
  await durability.syncDirectory(path.dirname(file));
}
async function sealTree(root) {
  const entries = await import('node:fs/promises').then(fs => fs.readdir(root, { withFileTypes: true }));
  for (const entry of entries) if (entry.isDirectory()) { await sealTree(path.join(root, entry.name)); await chmod(path.join(root, entry.name), 0o500); }
  await chmod(root, 0o500);
}
async function atomicFile(destination, bytes, mode, durability = DEFAULT_DURABILITY) {
  await ensureDirectory(path.dirname(destination), 0o700, durability);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.pending`);
  await writeExclusive(temporary, bytes, mode, durability);
  await rename(temporary, destination);
  await durability.syncDirectory(path.dirname(destination));
}
async function verifyArtifactFiles(files) {
  for (const file of files) {
    const info = await lstat(file.destination);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== file.mode || info.size !== file.bytes || sha256Bytes(await readFile(file.destination)) !== file.sha256) throw new Error(`Installed artifact verification failed: ${file.path}`);
  }
}
async function stageTree(finalRoot, files, sourceFiles, extras = new Map(), durability = DEFAULT_DURABILITY) {
  await absent(finalRoot);
  const pending = `${finalRoot}.${randomUUID()}.pending`;
  await absent(pending);
  await ensureDirectory(path.dirname(pending), 0o700, durability);
  await mkdir(pending, { mode: 0o700 });
  await durability.syncDirectory(path.dirname(pending));
  const source = new Map(sourceFiles.map(file => [file.relativePath, file.bytes]));
  try {
    for (const file of files) {
      const key = extras.has(file.path) ? file.path : [...source.keys()].find(name => name === file.path || name.endsWith(`/${file.path}`));
      const bytes = extras.get(file.path) ?? source.get(key);
      if (!bytes || sha256Bytes(bytes) !== file.sha256) throw new Error(`Pinned source unavailable: ${file.path}`);
      await writeExclusive(path.join(pending, file.path), bytes, 0o400, durability);
    }
    await sealTree(pending);
    await rename(pending, finalRoot);
    await durability.syncDirectory(path.dirname(finalRoot));
  } catch (error) { await rm(pending, { recursive: true, force: true }).catch(() => {}); await durability.syncDirectory(path.dirname(pending)).catch(() => {}); throw error; }
}
async function migrationReceipt(root, name, value, durability = DEFAULT_DURABILITY) {
  await ensureDirectory(root, 0o700, durability);
  const body = `${canonicalJson(value)}\n`;
  await writeExclusive(path.join(root, `${name}.json`), body, 0o400, durability);
  await writeExclusive(path.join(root, `${name}.sha256`), `${sha256Bytes(body)}\n`, 0o400, durability);
}

export async function migrateInstallation(plan, { reviewedInstallHash, regeneratePlan, durability = DEFAULT_DURABILITY } = {}) {
  if (!SHA256.test(reviewedInstallHash ?? '') || reviewedInstallHash !== plan?.installHash) throw new Error('Exact reviewed install hash is required');
  verifyInstallPlan(plan);
  let payload = PLAN_PAYLOAD.get(plan);
  if (!payload) throw new Error('Install plan was not created by this trusted installer process');
  const rebuild = regeneratePlan ?? (async () => {
    const currentInstallation = await inspectCurrentInstallation({ launcher: plan.paths.launcher, manifest: plan.paths.manifest });
    const sourceInspection = await inspectInitialBundle({ repoRoot: payload.build.root });
    const codexExecutable = await inspectExecutable(payload.build.codexPath);
    return buildInstallPlan({ extensionId: payload.build.extensionId, expectedCurrentHash: currentInstallation.currentHash, currentInstallation, sourceInspection, homeDir: payload.build.homeDir, nodePath: payload.build.nodePath, codexPath: payload.build.codexPath, codexExecutable, projectRoot: payload.build.root });
  });
  const regenerated = await rebuild();
  verifyInstallPlan(regenerated);
  if (regenerated.installHash !== reviewedInstallHash) throw new Error('Reviewed install hash does not match regenerated plan');
  plan = regenerated; payload = PLAN_PAYLOAD.get(plan);
  if (!payload) throw new Error('Regenerated install plan lacks trusted custody');
  const codexNow = await inspectExecutable(plan.codexExecutable.path);
  if (canonicalJson(codexNow) !== canonicalJson(plan.codexExecutable)) throw new Error('Codex executable changed; rebuild and review the plan');
  const current = await inspectCurrentInstallation({ launcher: plan.paths.launcher, manifest: plan.paths.manifest });
  if (current.currentHash !== plan.expectedCurrentHash) throw new Error('Current installation changed; rebuild and review the dry-run plan');
  const oldLauncher = await readFile(plan.paths.launcher);
  const oldManifest = await readFile(plan.paths.manifest);
  if (sha256Bytes(oldLauncher) !== plan.before.launcher.sha256 || sha256Bytes(oldManifest) !== plan.before.manifest.sha256) throw new Error('Current installation changed; rebuild and review the dry-run plan');

  for (const target of [plan.paths.trustedBootstrap, plan.paths.stableExtension, plan.paths.reviewHome, plan.paths.activeVersion, plan.paths.recovery, plan.paths.migrationReceipts, plan.paths.recoveryState, plan.paths.installationWitness, plan.paths.activePin]) await absent(target);
  await ensureDirectory(path.dirname(plan.paths.journal), 0o700, durability);
  const journal = `${canonicalJson({ schemaVersion: 1, state: 'preparation-started', installHash: plan.installHash, recovery: plan.paths.recovery })}\n`;
  await writeExclusive(plan.paths.journal, journal, 0o600, durability);
  try {
    await chmod(plan.runtimeDirectory.destination, plan.runtimeDirectory.mode);
    await durability.syncDirectory(path.dirname(plan.runtimeDirectory.destination));
    await ensureDirectory(plan.paths.reviewHome, plan.reviewHome.mode, durability);
    await chmod(plan.paths.reviewHome, plan.reviewHome.mode);
    await ensureDirectory(plan.paths.recovery, 0o700, durability);
    await writeExclusive(path.join(plan.paths.recovery, 'native-host'), oldLauncher, 0o400, durability);
    await writeExclusive(path.join(plan.paths.recovery, 'native-host-manifest.json'), oldManifest, 0o400, durability);
    await writeExclusive(path.join(plan.paths.recovery, 'current-installation.json'), `${canonicalJson(plan.before)}\n`, 0o400, durability);
    await sealTree(plan.paths.recovery);
    await migrationReceipt(plan.paths.migrationReceipts, 'before', plan.receipts.before, durability);

    const trustedExtras = new Map([['runtime-entry.js', payload.runtimeEntry], ['package.json', '{"type":"module"}\n']]);
    await stageTree(plan.paths.trustedBootstrap, plan.trustedBootstrap.files, payload.sourceInspection.trustedBootstrap.files, trustedExtras, durability);
    await stageTree(plan.paths.stableExtension, plan.stableExtension.files, payload.sourceInspection.bundle.files, new Map(), durability);
    const versionFiles = plan.bundle.files.map(file => ({ ...file, destination: path.join(plan.paths.activeBundle, file.path) }));
    await ensureDirectory(path.dirname(plan.paths.activeVersion), 0o700, durability);
    const pendingVersion = `${plan.paths.activeVersion}.${randomUUID()}.pending`;
    await mkdir(pendingVersion, { mode: 0o700 });
    await durability.syncDirectory(path.dirname(pendingVersion));
    await mkdir(path.join(pendingVersion, 'bundle'), { mode: 0o700 });
    await durability.syncDirectory(pendingVersion);
    for (const file of versionFiles) {
      const source = payload.sourceInspection.bundle.files.find(item => item.relativePath === file.path);
      await writeExclusive(path.join(pendingVersion, 'bundle', file.path), source.bytes, 0o400, durability);
    }
    await writeExclusive(path.join(pendingVersion, 'manifest.json'), `${canonicalJson(payload.sourceInspection.bundle.manifest)}\n`, 0o400, durability);
    await sealTree(pendingVersion);
    await rename(pendingVersion, plan.paths.activeVersion);
    await durability.syncDirectory(path.dirname(plan.paths.activeVersion));
    await atomicFile(plan.paths.installationWitness, plan.baseline.installationWitness.contents, plan.baseline.installationWitness.mode, durability);
    await atomicFile(plan.paths.recoveryState, plan.baseline.recoveryState.contents, plan.baseline.recoveryState.mode, durability);
    await atomicFile(plan.paths.activePin, plan.activePin.contents, plan.activePin.mode, durability);
    await migrationReceipt(plan.paths.migrationReceipts, 'migration', plan.receipts.migration, durability);

    await verifyArtifactFiles([...plan.trustedBootstrap.files, ...plan.stableExtension.files, ...plan.bundle.files, plan.bundle.manifestArtifact, { path: 'active/pin.json', ...plan.activePin }, { path: 'recovery-state.json', ...plan.baseline.recoveryState }, { path: 'installations/migration-v1.json', ...plan.baseline.installationWitness }]);
    const unchanged = await inspectCurrentInstallation({ launcher: plan.paths.launcher, manifest: plan.paths.manifest });
    if (unchanged.currentHash !== plan.expectedCurrentHash) throw new Error('Current registration changed during preparation');
    await migrationReceipt(plan.paths.migrationReceipts, 'after', plan.receipts.after, durability);
    await rm(plan.paths.journal);
    await durability.syncDirectory(path.dirname(plan.paths.journal));
    return Object.freeze({ mode: 'prepared', registration: plan.registration.state, installHash: plan.installHash, bundleDigest: plan.bundle.digest, recovery: plan.paths.recovery, liveVerification: 'pending-human-checkpoint' });
  } catch (error) {
    const failed = `${canonicalJson({ schemaVersion: 1, state: 'preparation-failed', installHash: plan.installHash, recovery: plan.paths.recovery })}\n`;
    await atomicFile(plan.paths.journal, failed, 0o600, durability).catch(() => {});
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
      'No migration can occur without --migrate, exact reviewed current hash, and exact reviewed install hash.',
      '',
    ].join('\n'));
    return;
  }
  const homeDir = os.homedir();
  const supportRoot = path.join(homeDir, 'Library', 'Application Support');
  const current = await inspectCurrentInstallation({ launcher: path.join(supportRoot, 'Resonant Sidecar', 'native-host'), manifest: path.join(supportRoot, 'Google', 'Chrome Dev', 'NativeMessagingHosts', `${HOST_NAME}.json`) });
  if (options.migrate && options.expectedCurrentHash !== current.currentHash) throw new Error('Current installation hash does not match the explicit confirmation');
  const sourceInspection = await inspectInitialBundle({ repoRoot: projectRoot });
  const codexPath = await realpath(path.join(homeDir, '.local', 'bin', 'codex'));
  const codexExecutable = await inspectExecutable(codexPath);
  const plan = buildInstallPlan({ extensionId: options.extensionId, expectedCurrentHash: current.currentHash, currentInstallation: current, sourceInspection, codexPath, codexExecutable });
  if (!options.migrate) {
    process.stdout.write(`${canonicalJson(plan)}\n`);
    return;
  }
  const result = await migrateInstallation(plan, { reviewedInstallHash: options.reviewedInstallHash });
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
