#!/usr/bin/env node

import { constants } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sha256Bytes, sha256Json } from '../review/canonical-json.js';

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const MAX_FILE = 16 * 1024 * 1024;
const fail = message => { throw new Error(`Install plan rejected: ${message}`); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys, name) => {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(`${name} fields`);
};
function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f]/.test(value)) fail(`${name} path`);
}

async function readHeld(file, expectedMode) {
  absolute(file, 'current installation');
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_FILE || (metadata.mode & 0o777) !== expectedMode) fail('current installation custody');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    if (held.dev !== metadata.dev || held.ino !== metadata.ino) fail('current installation changed');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(file);
    if (after.size !== metadata.size || current.dev !== metadata.dev || current.ino !== metadata.ino || bytes.length !== metadata.size) fail('current installation changed');
    return Object.freeze({ present: true, path: file, bytes: bytes.length, sha256: sha256Bytes(bytes), mode: expectedMode });
  } finally { await handle.close(); }
}

export async function inspectCurrentInstallation({ launcher, manifest } = {}) {
  const observedLauncher = await readHeld(launcher, 0o700);
  const observedManifest = await readHeld(manifest, 0o600);
  const identity = {
    launcher: Object.fromEntries(['path', 'bytes', 'sha256', 'mode'].map(key => [key, observedLauncher[key]])),
    manifest: Object.fromEntries(['path', 'bytes', 'sha256', 'mode'].map(key => [key, observedManifest[key]])),
  };
  return Object.freeze({ ...identity, currentHash: sha256Json(identity) });
}

function verifyArtifactList(files, name, root) {
  if (!Array.isArray(files) || files.length === 0) fail(`${name} files`);
  let prior = null;
  for (const file of files) {
    exact(file, ['path', 'bytes', 'sha256', 'mode', 'destination'], `${name} file`);
    if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('..') || file.path.includes('\\') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA256.test(file.sha256) || file.mode !== 0o400) fail(`${name} file`);
    absolute(file.destination, `${name} destination`);
    if (file.destination !== path.join(root, file.path)) fail(`${name} destination containment`);
    if (prior !== null && Buffer.compare(Buffer.from(prior), Buffer.from(file.path)) >= 0) fail(`${name} ordering`);
    prior = file.path;
  }
}

export function verifyInstallPlan(plan) {
  exact(plan, ['schemaVersion', 'mode', 'browser', 'extensionId', 'expectedCurrentHash', 'sourceCommit', 'extensionIdentity', 'registration', 'runtimeDirectory', 'reviewHome', 'codexExecutable', 'paths', 'before', 'bundle', 'trustedBootstrap', 'runtimeEntry', 'stableExtension', 'activePin', 'baseline', 'launcher', 'manifest', 'inventoryHash', 'receipts', 'installHash'], 'plan');
  if (plan.schemaVersion !== 1 || plan.mode !== 'dry-run' || plan.browser !== 'Google Chrome Dev' || !EXTENSION_ID.test(plan.extensionId) || !SHA256.test(plan.expectedCurrentHash) || !COMMIT.test(plan.sourceCommit)) fail('identity');
  exact(plan.paths, ['launcher', 'manifest', 'runtime', 'trustedBootstrap', 'stableExtension', 'reviewHome', 'activeVersion', 'activeBundle', 'activePin', 'recoveryState', 'installationWitness', 'recovery', 'migrationReceipts', 'journal'], 'paths');
  for (const [name, value] of Object.entries(plan.paths)) absolute(value, name);
  if (!plan.paths.manifest.includes('/Google/Chrome Dev/NativeMessagingHosts/') || plan.paths.manifest.includes('/Google/Chrome/NativeMessagingHosts/')) fail('browser target');
  if (new Set(Object.values(plan.paths)).size !== Object.keys(plan.paths).length) fail('path collision');
  if (plan.paths.activeVersion !== path.join(plan.paths.runtime, 'versions', plan.bundle?.digest ?? '') || plan.paths.activeBundle !== path.join(plan.paths.activeVersion, 'bundle') || plan.paths.activePin !== path.join(plan.paths.runtime, 'active', 'pin.json') || plan.paths.recoveryState !== path.join(plan.paths.runtime, 'recovery-state.json') || plan.paths.installationWitness !== path.join(plan.paths.runtime, 'installations', 'migration-v1.json') || !plan.paths.recovery.startsWith(`${plan.paths.runtime}${path.sep}`) || !plan.paths.recovery.endsWith(plan.expectedCurrentHash) || !plan.paths.migrationReceipts.startsWith(`${plan.paths.runtime}${path.sep}`) || plan.paths.journal !== path.join(plan.paths.runtime, 'migration-journal.json')) fail('path containment');

  exact(plan.extensionIdentity, ['expectedId', 'observedStablePathId', 'state'], 'extension identity');
  if (plan.extensionIdentity.expectedId !== plan.extensionId || plan.extensionIdentity.observedStablePathId !== null || plan.extensionIdentity.state !== 'unverified') fail('extension identity proof');
  exact(plan.registration, ['state', 'launcherSha256', 'manifestSha256'], 'registration');
  if (plan.registration.state !== 'unchanged-pending-stable-id-proof' || !SHA256.test(plan.registration.launcherSha256) || !SHA256.test(plan.registration.manifestSha256)) fail('registration state');
  exact(plan.runtimeDirectory, ['destination', 'mode'], 'runtime directory');
  if (plan.runtimeDirectory.destination !== plan.paths.runtime || plan.runtimeDirectory.mode !== 0o700) fail('runtime directory custody');
  exact(plan.reviewHome, ['destination', 'mode'], 'review home');
  if (plan.reviewHome.destination !== plan.paths.reviewHome || plan.reviewHome.mode !== 0o700) fail('review home custody');
  exact(plan.codexExecutable, ['path', 'bytes', 'sha256', 'mode'], 'Codex executable');
  absolute(plan.codexExecutable.path, 'Codex executable');
  if (!Number.isSafeInteger(plan.codexExecutable.bytes) || plan.codexExecutable.bytes < 1 || !SHA256.test(plan.codexExecutable.sha256) || !Number.isInteger(plan.codexExecutable.mode) || (plan.codexExecutable.mode & 0o111) === 0 || (plan.codexExecutable.mode & 0o022) !== 0) fail('Codex executable custody');

  exact(plan.before, ['currentHash', 'launcher', 'manifest'], 'before');
  if (plan.before.currentHash !== plan.expectedCurrentHash) fail('stale expected hash');
  for (const [name, item] of [['launcher', plan.before.launcher], ['manifest', plan.before.manifest]]) {
    exact(item, ['path', 'bytes', 'sha256', 'mode'], `before ${name}`);
    absolute(item.path, `before ${name}`);
    if (!SHA256.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.mode !== (name === 'launcher' ? 0o700 : 0o600) || item.path !== plan.paths[name]) fail(`before ${name}`);
  }
  const beforeIdentity = { launcher: plan.before.launcher, manifest: plan.before.manifest };
  if (sha256Json(beforeIdentity) !== plan.before.currentHash) fail('current hash');
  if (plan.registration.launcherSha256 !== plan.before.launcher.sha256 || plan.registration.manifestSha256 !== plan.before.manifest.sha256) fail('registration identity');

  exact(plan.bundle, ['digest', 'manifestDigest', 'manifestArtifact', 'files'], 'bundle');
  exact(plan.trustedBootstrap, ['digest', 'entryDigest', 'files'], 'trusted bootstrap');
  exact(plan.stableExtension, ['digest', 'files'], 'stable extension');
  if (![plan.bundle.digest, plan.bundle.manifestDigest, plan.trustedBootstrap.digest, plan.trustedBootstrap.entryDigest, plan.stableExtension.digest].every(value => SHA256.test(value))) fail('artifact digest');
  verifyArtifactList(plan.bundle.files, 'bundle', plan.paths.activeBundle);
  verifyArtifactList(plan.trustedBootstrap.files, 'trusted bootstrap', plan.paths.trustedBootstrap);
  verifyArtifactList(plan.stableExtension.files, 'stable extension', plan.paths.stableExtension);
  exact(plan.bundle.manifestArtifact, ['path', 'bytes', 'sha256', 'mode', 'destination'], 'bundle manifest artifact');
  if (plan.bundle.manifestArtifact.path !== 'manifest.json' || plan.bundle.manifestArtifact.destination !== path.join(plan.paths.activeVersion, 'manifest.json') || plan.bundle.manifestArtifact.mode !== 0o400 || !Number.isSafeInteger(plan.bundle.manifestArtifact.bytes) || plan.bundle.manifestArtifact.bytes < 1 || plan.bundle.manifestArtifact.sha256 !== plan.bundle.manifestDigest) fail('bundle manifest artifact');
  exact(plan.activePin, ['contents', 'bytes', 'sha256', 'mode', 'destination'], 'active pin');
  if (plan.activePin.destination !== plan.paths.activePin || plan.activePin.mode !== 0o600 || plan.activePin.bytes !== Buffer.byteLength(plan.activePin.contents) || plan.activePin.sha256 !== sha256Bytes(plan.activePin.contents)) fail('active pin');
  let pin;
  try { pin = JSON.parse(plan.activePin.contents); } catch { fail('active pin JSON'); }
  if (!plain(pin) || canonicalJson(pin) + '\n' !== plan.activePin.contents || pin.schemaVersion !== 1 || pin.digest !== plan.bundle.digest || pin.reviewId !== 'migration-v1' || Object.keys(pin).sort().join(',') !== 'digest,reviewId,schemaVersion') fail('active pin contents');
  if (!plan.bundle.files.some(file => file.path === 'native-host/host.js') || !plan.trustedBootstrap.files.some(file => file.path === 'bootstrap/host.js')) fail('runtime entry graph');
  exact(plan.runtimeEntry, ['contents', 'bytes', 'sha256', 'mode', 'destination'], 'runtime entry');
  if (plan.runtimeEntry.destination !== path.join(plan.paths.trustedBootstrap, 'runtime-entry.js') || plan.runtimeEntry.mode !== 0o400 || plan.runtimeEntry.bytes !== Buffer.byteLength(plan.runtimeEntry.contents) || plan.runtimeEntry.sha256 !== sha256Bytes(plan.runtimeEntry.contents) || plan.runtimeEntry.sha256 !== plan.trustedBootstrap.entryDigest || !plan.runtimeEntry.contents.includes(`\"codexPath\":\"${plan.codexExecutable.path}\"`) || !plan.runtimeEntry.contents.includes('root: input.active.bundleRoot')) fail('runtime entry binding');
  const entryInInventory = plan.trustedBootstrap.files.find(file => file.path === 'runtime-entry.js');
  if (!entryInInventory || entryInInventory.sha256 !== plan.runtimeEntry.sha256 || entryInInventory.bytes !== plan.runtimeEntry.bytes || entryInInventory.destination !== plan.runtimeEntry.destination) fail('runtime entry inventory');
  exact(plan.baseline, ['recoveryState', 'installationWitness'], 'baseline');
  for (const [name, item, expectedDestination, expectedMode] of [['recovery state', plan.baseline.recoveryState, plan.paths.recoveryState, 0o600], ['installation witness', plan.baseline.installationWitness, plan.paths.installationWitness, 0o400]]) {
    exact(item, ['contents', 'bytes', 'sha256', 'mode', 'destination'], name);
    if (item.destination !== expectedDestination || item.mode !== expectedMode || item.bytes !== Buffer.byteLength(item.contents) || item.sha256 !== sha256Bytes(item.contents)) fail(`${name} artifact`);
  }
  let recoveryState; let installationWitness;
  try { recoveryState = JSON.parse(plan.baseline.recoveryState.contents); installationWitness = JSON.parse(plan.baseline.installationWitness.contents); } catch { fail('baseline JSON'); }
  if (canonicalJson(recoveryState) + '\n' !== plan.baseline.recoveryState.contents || canonicalJson(installationWitness) + '\n' !== plan.baseline.installationWitness.contents || canonicalJson(installationWitness) !== canonicalJson(pin) || recoveryState.phase !== 'complete' || canonicalJson(recoveryState.candidate) !== canonicalJson(pin) || recoveryState.previous !== null || recoveryState.priorPrevious !== null || recoveryState.failureRef !== null || !SHA256.test(recoveryState.decisionHash)) fail('baseline state');

  exact(plan.launcher, ['contents', 'sha256', 'mode'], 'launcher');
  if (plan.launcher.mode !== 0o700 || plan.launcher.sha256 !== sha256Bytes(plan.launcher.contents) || !plan.launcher.contents.includes(`${plan.paths.trustedBootstrap}/runtime-entry.js`) || /native-host\/host\.js/.test(plan.launcher.contents)) fail('launcher authority');
  exact(plan.manifest, ['contents', 'sha256', 'mode'], 'manifest');
  if (plan.manifest.mode !== 0o600 || plan.manifest.sha256 !== sha256Bytes(`${canonicalJson(plan.manifest.contents)}\n`)) fail('manifest digest');
  exact(plan.manifest.contents, ['name', 'description', 'path', 'type', 'allowed_origins'], 'manifest contents');
  if (plan.manifest.contents.name !== 'com.resonantmirror.sidecar' || plan.manifest.contents.path !== plan.paths.launcher || plan.manifest.contents.type !== 'stdio' || canonicalJson(plan.manifest.contents.allowed_origins) !== canonicalJson([`chrome-extension://${plan.extensionId}/`])) fail('native manifest');
  if (!SHA256.test(plan.inventoryHash)) fail('inventory hash');
  const inventory = [...plan.bundle.files, ...plan.trustedBootstrap.files, ...plan.stableExtension.files, plan.bundle.manifestArtifact, plan.activePin, plan.baseline.recoveryState, plan.baseline.installationWitness].map(({ path: artifactPath, destination, bytes, sha256, mode }) => ({ path: artifactPath ?? path.relative(plan.paths.runtime, destination), destination, bytes, sha256, mode })).sort((a, b) => Buffer.compare(Buffer.from(a.destination), Buffer.from(b.destination)));
  if (plan.inventoryHash !== sha256Json(inventory)) fail('inventory hash');
  const approval = { ...plan }; delete approval.installHash; delete approval.receipts;
  if (plan.installHash !== sha256Json(approval)) fail('install hash');
  exact(plan.receipts, ['before', 'migration', 'after'], 'migration receipts');
  let predecessor = null;
  for (const [name, eventType] of [['before', 'migration-before'], ['migration', 'migration-prepared'], ['after', 'migration-files-prepared']]) {
    const receipt = plan.receipts[name];
    exact(receipt, ['schemaVersion', 'eventType', 'installHash', 'sourceCommit', 'currentHash', 'bundleDigest', 'trustedBootstrapDigest', 'stableExtensionDigest', 'runtimeEntryDigest', 'inventoryHash', 'inventory', 'registration', 'previousReceiptHash', 'receiptHash'], 'migration receipt');
    exact(receipt.registration, ['launcher', 'manifest'], 'migration registration');
    for (const [kind, item] of Object.entries(receipt.registration)) {
      exact(item, ['path', 'bytes', 'sha256', 'mode'], `migration ${kind}`);
      if (canonicalJson(item) !== canonicalJson(plan.before[kind])) fail('migration registration');
    }
    const unsignedReceipt = { ...receipt }; delete unsignedReceipt.receiptHash;
    if (receipt.schemaVersion !== 1 || receipt.eventType !== eventType || receipt.installHash !== plan.installHash || receipt.sourceCommit !== plan.sourceCommit || receipt.currentHash !== plan.expectedCurrentHash || receipt.bundleDigest !== plan.bundle.digest || receipt.trustedBootstrapDigest !== plan.trustedBootstrap.digest || receipt.stableExtensionDigest !== plan.stableExtension.digest || receipt.runtimeEntryDigest !== plan.runtimeEntry.sha256 || receipt.inventoryHash !== plan.inventoryHash || canonicalJson(receipt.inventory) !== canonicalJson(inventory) || receipt.previousReceiptHash !== predecessor || receipt.receiptHash !== sha256Json(unsignedReceipt)) fail('migration receipt chain');
    predecessor = receipt.receiptHash;
  }
  return plan;
}

function storedFileIdentity(metadata) {
  return { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mode: metadata.mode & 0o777, uid: metadata.uid, nlink: metadata.nlink };
}

function assertStoredFileCustody(metadata, ownerUid) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_FILE || (metadata.mode & 0o777) !== 0o400 || metadata.uid !== ownerUid) fail('stored migration receipt owner or file custody');
}

function assertStoredRootCustody(metadata, ownerUid) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700 || metadata.uid !== ownerUid) fail('stored migration receipt root owner or custody');
}

function sameStoredIdentity(metadata, expected) {
  return canonicalJson(storedFileIdentity(metadata)) === canonicalJson(expected);
}

async function readStoredReceiptFile(file, expected, ownerUid) {
  const metadata = await lstat(file);
  assertStoredFileCustody(metadata, ownerUid);
  if (!sameStoredIdentity(metadata, expected)) fail('stored migration receipt changed');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    assertStoredFileCustody(held, ownerUid);
    if (!sameStoredIdentity(held, expected)) fail('stored migration receipt changed');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(file);
    assertStoredFileCustody(after, ownerUid);
    assertStoredFileCustody(current, ownerUid);
    if (!sameStoredIdentity(after, expected) || !sameStoredIdentity(current, expected) || bytes.length !== expected.size) fail('stored migration receipt changed');
    return bytes;
  } finally { await handle.close(); }
}

function decodeCanonicalReceipt(bytes) {
  let text; let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch { fail('stored migration receipt JSON'); }
  if (!plain(value) || `${canonicalJson(value)}\n` !== text) fail('stored migration receipt canonical bytes');
  return value;
}

export async function verifyStoredMigrationChain(plan, { afterInitialInventory } = {}) {
  verifyInstallPlan(plan);
  if (afterInitialInventory !== undefined && typeof afterInitialInventory !== 'function') fail('stored migration verification hook');
  const ownerUid = process.getuid();
  const root = plan.paths.migrationReceipts;
  absolute(root, 'stored migration receipt root');
  const metadata = await lstat(root);
  assertStoredRootCustody(metadata, ownerUid);
  const rootIdentity = storedFileIdentity(metadata);
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const held = await directory.stat();
    assertStoredRootCustody(held, ownerUid);
    if (!sameStoredIdentity(held, rootIdentity)) fail('stored migration receipt root changed');
    const expectedNames = ['after.json', 'after.sha256', 'before.json', 'before.sha256', 'migration.json', 'migration.sha256'];
    const entries = await readdir(root, { withFileTypes: true });
    const observedNames = entries.map(entry => entry.name).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    if (canonicalJson(observedNames) !== canonicalJson(expectedNames) || entries.some(entry => !entry.isFile())) fail('stored migration receipt entries');
    const initialInventory = new Map();
    for (const name of expectedNames) {
      const item = await lstat(path.join(root, name));
      assertStoredFileCustody(item, ownerUid);
      initialInventory.set(name, storedFileIdentity(item));
    }
    if (afterInitialInventory) await afterInitialInventory();
    let previousReceiptHash = null;
    for (const [name, eventType] of [['before', 'migration-before'], ['migration', 'migration-prepared'], ['after', 'migration-files-prepared']]) {
      const body = await readStoredReceiptFile(path.join(root, `${name}.json`), initialInventory.get(`${name}.json`), ownerUid);
      const sidecar = await readStoredReceiptFile(path.join(root, `${name}.sha256`), initialInventory.get(`${name}.sha256`), ownerUid);
      if (!sidecar.equals(Buffer.from(`${sha256Bytes(body)}\n`, 'utf8'))) fail('stored migration receipt sidecar');
      const receipt = decodeCanonicalReceipt(body);
      const unsigned = { ...receipt }; delete unsigned.receiptHash;
      if (receipt.eventType !== eventType || receipt.previousReceiptHash !== previousReceiptHash || receipt.receiptHash !== sha256Json(unsigned)) fail('stored migration receipt chain');
      if (canonicalJson(receipt) !== canonicalJson(plan.receipts[name])) fail('stored migration receipt plan binding');
      previousReceiptHash = receipt.receiptHash;
    }
    const finalEntries = await readdir(root, { withFileTypes: true });
    const finalNames = finalEntries.map(entry => entry.name).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    if (canonicalJson(finalNames) !== canonicalJson(expectedNames) || finalEntries.some(entry => !entry.isFile())) fail('stored migration receipt entries changed');
    for (const name of expectedNames) {
      const item = await lstat(path.join(root, name));
      assertStoredFileCustody(item, ownerUid);
      if (!sameStoredIdentity(item, initialInventory.get(name))) fail('stored migration receipt inventory changed');
    }
    const after = await directory.stat(); const current = await lstat(root);
    assertStoredRootCustody(after, ownerUid); assertStoredRootCustody(current, ownerUid);
    if (!sameStoredIdentity(after, rootIdentity) || !sameStoredIdentity(current, rootIdentity)) fail('stored migration receipt root changed');
    return Object.freeze({ installHash: plan.installHash, receiptRoot: root, finalReceiptHash: previousReceiptHash });
  } finally { await directory.close(); }
}

async function readReviewedPlan(planPath) {
  absolute(planPath, 'reviewed plan');
  const metadata = await lstat(planPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_FILE) fail('reviewed plan custody');
  let plan;
  try { plan = JSON.parse(await readFile(planPath, 'utf8')); }
  catch { fail('reviewed plan JSON'); }
  return plan;
}

async function main() {
  const args = process.argv.slice(2);
  const stored = args[0] === '--stored-chain';
  const planPath = stored ? args[1] : args[0];
  if (!planPath || args.length !== (stored ? 2 : 1)) fail('expected PLAN_PATH or --stored-chain PLAN_PATH');
  const plan = await readReviewedPlan(planPath);
  verifyInstallPlan(plan);
  if (stored) process.stdout.write(`${canonicalJson(await verifyStoredMigrationChain(plan))}\n`);
  else process.stdout.write(`${plan.installHash}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
