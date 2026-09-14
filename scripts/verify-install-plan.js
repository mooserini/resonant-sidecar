#!/usr/bin/env node

import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
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
  exact(plan, ['schemaVersion', 'mode', 'browser', 'extensionId', 'expectedCurrentHash', 'sourceCommit', 'extensionIdentity', 'registration', 'runtimeDirectory', 'paths', 'before', 'bundle', 'trustedBootstrap', 'stableExtension', 'activePin', 'launcher', 'manifest', 'receipts', 'installHash'], 'plan');
  if (plan.schemaVersion !== 1 || plan.mode !== 'dry-run' || plan.browser !== 'Google Chrome Dev' || !EXTENSION_ID.test(plan.extensionId) || !SHA256.test(plan.expectedCurrentHash) || !COMMIT.test(plan.sourceCommit)) fail('identity');
  exact(plan.paths, ['launcher', 'manifest', 'runtime', 'trustedBootstrap', 'stableExtension', 'activeVersion', 'activeBundle', 'activePin', 'recovery', 'migrationReceipts', 'journal'], 'paths');
  for (const [name, value] of Object.entries(plan.paths)) absolute(value, name);
  if (!plan.paths.manifest.includes('/Google/Chrome Dev/NativeMessagingHosts/') || plan.paths.manifest.includes('/Google/Chrome/NativeMessagingHosts/')) fail('browser target');
  if (new Set(Object.values(plan.paths)).size !== Object.keys(plan.paths).length) fail('path collision');
  if (plan.paths.activeVersion !== path.join(plan.paths.runtime, 'versions', plan.bundle?.digest ?? '') || plan.paths.activeBundle !== path.join(plan.paths.activeVersion, 'bundle') || plan.paths.activePin !== path.join(plan.paths.runtime, 'active', 'pin.json') || !plan.paths.recovery.startsWith(`${plan.paths.runtime}${path.sep}`) || !plan.paths.recovery.endsWith(plan.expectedCurrentHash) || !plan.paths.migrationReceipts.startsWith(`${plan.paths.runtime}${path.sep}`) || plan.paths.journal !== path.join(plan.paths.runtime, 'migration-journal.json')) fail('path containment');

  exact(plan.extensionIdentity, ['expectedId', 'observedStablePathId', 'state'], 'extension identity');
  if (plan.extensionIdentity.expectedId !== plan.extensionId || plan.extensionIdentity.observedStablePathId !== null || plan.extensionIdentity.state !== 'unverified') fail('extension identity proof');
  exact(plan.registration, ['state', 'launcherSha256', 'manifestSha256'], 'registration');
  if (plan.registration.state !== 'unchanged-pending-stable-id-proof' || !SHA256.test(plan.registration.launcherSha256) || !SHA256.test(plan.registration.manifestSha256)) fail('registration state');
  exact(plan.runtimeDirectory, ['destination', 'mode'], 'runtime directory');
  if (plan.runtimeDirectory.destination !== plan.paths.runtime || plan.runtimeDirectory.mode !== 0o700) fail('runtime directory custody');

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

  exact(plan.launcher, ['contents', 'sha256', 'mode'], 'launcher');
  if (plan.launcher.mode !== 0o700 || plan.launcher.sha256 !== sha256Bytes(plan.launcher.contents) || !plan.launcher.contents.includes(`${plan.paths.trustedBootstrap}/runtime-entry.js`) || /native-host\/host\.js/.test(plan.launcher.contents)) fail('launcher authority');
  exact(plan.manifest, ['contents', 'sha256', 'mode'], 'manifest');
  if (plan.manifest.mode !== 0o600 || plan.manifest.sha256 !== sha256Bytes(`${canonicalJson(plan.manifest.contents)}\n`)) fail('manifest digest');
  exact(plan.manifest.contents, ['name', 'description', 'path', 'type', 'allowed_origins'], 'manifest contents');
  if (plan.manifest.contents.name !== 'com.resonantmirror.sidecar' || plan.manifest.contents.path !== plan.paths.launcher || plan.manifest.contents.type !== 'stdio' || canonicalJson(plan.manifest.contents.allowed_origins) !== canonicalJson([`chrome-extension://${plan.extensionId}/`])) fail('native manifest');
  for (const receipt of Object.values(plan.receipts)) {
    exact(receipt, ['schemaVersion', 'eventType', 'sourceCommit', 'currentHash', 'bundleDigest', 'trustedBootstrapDigest'], 'migration receipt');
    if (receipt.schemaVersion !== 1 || receipt.sourceCommit !== plan.sourceCommit || receipt.currentHash !== plan.expectedCurrentHash || receipt.bundleDigest !== plan.bundle.digest || receipt.trustedBootstrapDigest !== plan.trustedBootstrap.digest) fail('migration receipt');
  }
  const unsigned = { ...plan }; delete unsigned.installHash;
  if (plan.installHash !== sha256Json(unsigned)) fail('install hash');
  return plan;
}

async function main() {
  const [planPath, ...rest] = process.argv.slice(2);
  if (!planPath || rest.length) fail('expected exactly one absolute plan path');
  absolute(planPath, 'reviewed plan');
  const metadata = await lstat(planPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_FILE) fail('reviewed plan custody');
  let plan;
  try { plan = JSON.parse(await readFile(planPath, 'utf8')); }
  catch { fail('reviewed plan JSON'); }
  verifyInstallPlan(plan);
  process.stdout.write(`${plan.installHash}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
