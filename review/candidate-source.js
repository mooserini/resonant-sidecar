import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  assertBundleManifest,
  assertSafeRelativePath,
  buildBundleManifest,
} from './bundle-manifest.js';
import { canonicalJson, sha256Bytes, sha256Json } from './canonical-json.js';
import { localGit } from './git-runner.js';

const COMMIT = /^[0-9a-f]{40}$/;
const REVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REGULAR_MODES = new Set(['100644', '100755']);
const LOCKFILES = new Set([
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const LIFECYCLE_SCRIPTS = new Set([
  'preinstall', 'install', 'postinstall',
  'preuninstall', 'uninstall', 'postuninstall',
  'prepack', 'prepare', 'preprepare', 'postprepare',
  'prepublish', 'publish', 'postpublish', 'prepublishOnly', 'postpack',
  'preversion', 'version', 'postversion',
  'pretest', 'test', 'posttest',
  'prestop', 'stop', 'poststop',
  'prestart', 'start', 'poststart',
  'prerestart', 'restart', 'postrestart',
  'preshrinkwrap', 'shrinkwrap', 'postshrinkwrap',
]);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function compareBytewise(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sourceError(code) {
  const error = new Error('Candidate source rejected');
  error.name = 'CandidateSourceError';
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatePolicy(policy) {
  if (!isPlainObject(policy)
      || !Number.isSafeInteger(policy.schemaVersion)
      || policy.schemaVersion < 1
      || !Array.isArray(policy.approvedBundlePaths)
      || policy.approvedBundlePaths.length === 0) {
    throw sourceError('policy-invalid');
  }
  let files;
  try {
    files = policy.approvedBundlePaths.map(filePath => {
      assertSafeRelativePath(filePath);
      if (/\p{Cc}/u.test(filePath)) throw new TypeError('Control character');
      return filePath;
    }).sort(compareBytewise);
  } catch {
    throw sourceError('policy-invalid');
  }
  if (files.some((filePath, index) => filePath === files[index - 1])) {
    throw sourceError('policy-invalid');
  }
  return { files, schemaVersion: policy.schemaVersion };
}

function decodeJson(bytes) {
  const value = JSON.parse(UTF8.decode(bytes));
  if (!isPlainObject(value)) throw new TypeError('JSON root must be an object');
  return value;
}

function sortedStrings(value) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new TypeError('Expected string array');
  }
  return [...value].sort(compareBytewise);
}

function readCapabilities(snapshot) {
  const manifestEntry = snapshot.get('extension/manifest.json');
  const packageEntry = snapshot.get('package.json');
  if (!manifestEntry || !packageEntry) throw new TypeError('Required manifest input missing');
  const manifest = decodeJson(manifestEntry.bytes);
  const packageJson = decodeJson(packageEntry.bytes);
  if (Object.hasOwn(manifest, 'optional_permissions') || Object.hasOwn(manifest, 'optional_host_permissions')) {
    throw new TypeError('Optional permissions are unsupported');
  }
  const scripts = packageJson.scripts ?? {};
  if (!isPlainObject(scripts)) throw new TypeError('Package scripts must be an object');
  return {
    chromePermissions: sortedStrings(manifest.permissions ?? []),
    hostPermissions: sortedStrings(manifest.host_permissions ?? []),
    lifecycleScripts: Object.keys(scripts).filter(name => LIFECYCLE_SCRIPTS.has(name)).sort(compareBytewise),
    listeners: [],
  };
}

function readDependencies(snapshot) {
  const packageEntry = snapshot.get('package.json');
  if (!packageEntry) throw new TypeError('package.json missing');
  const packageJson = decodeJson(packageEntry.bytes);
  if (packageJson.packageManager !== undefined && typeof packageJson.packageManager !== 'string') {
    throw new TypeError('Invalid package manager');
  }
  const groups = [packageJson.dependencies ?? {}, packageJson.optionalDependencies ?? {}];
  for (const group of groups) {
    if (!isPlainObject(group) || Object.values(group).some(specifier => typeof specifier !== 'string')) {
      throw new TypeError('Invalid runtime dependencies');
    }
  }
  const declared = Object.assign({}, ...groups);
  const runtime = Object.entries(declared)
    .sort(([left], [right]) => compareBytewise(left, right))
    .map(([name, specifier]) => ({ name, specifier }));
  const lockfiles = [...snapshot]
    .filter(([filePath]) => LOCKFILES.has(filePath))
    .map(([filePath, entry]) => ({ path: filePath, bytes: entry.bytes.length, sha256: sha256Bytes(entry.bytes) }))
    .sort((left, right) => compareBytewise(left.path, right.path));
  return { lockfiles, packageManager: packageJson.packageManager ?? null, runtime };
}

function buildSnapshotManifest({ commit, snapshot, schemaVersion }) {
  const files = [...snapshot]
    .sort(([left], [right]) => compareBytewise(left, right))
    .map(([filePath, entry]) => ({
      path: filePath,
      bytes: entry.bytes.length,
      sha256: sha256Bytes(entry.bytes),
      mode: Number.parseInt(entry.mode.slice(-3), 8),
    }));
  const unsigned = {
    schemaVersion,
    sourceCommit: commit,
    files,
    capabilities: readCapabilities(snapshot),
    dependencies: readDependencies(snapshot),
  };
  return assertBundleManifest({ ...unsigned, bundleDigest: sha256Json(unsigned) });
}

function gitBlobOid(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function gitRun(git, repoRoot, args) {
  if (!git || typeof git.run !== 'function') throw sourceError('git-inspection-failed');
  const result = await git.run({ repoRoot, args });
  if (!isPlainObject(result) || !Buffer.isBuffer(result.stdout)) throw sourceError('git-inspection-failed');
  return result.stdout;
}

async function readCommit(git, repoRoot) {
  const value = UTF8.decode(await gitRun(git, repoRoot, ['rev-parse', 'HEAD'])).trim();
  if (!COMMIT.test(value)) throw sourceError('candidate-tree-invalid');
  return value;
}

async function assertClean(git, repoRoot, files) {
  const status = await gitRun(git, repoRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...files,
  ]);
  if (status.length !== 0) throw sourceError('bundle-inputs-dirty');
}

function parseTree(bytes, files) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    throw sourceError('candidate-tree-invalid');
  }
  const records = text.length === 0 ? [] : text.split('\0');
  if (records.at(-1) === '') records.pop();
  const entries = new Map();
  for (const record of records) {
    const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t([^\0]+)$/u.exec(record);
    if (!match) throw sourceError('candidate-tree-invalid');
    const [, mode, type, oid, filePath] = match;
    if (!files.includes(filePath) || entries.has(filePath) || type !== 'blob' || !REGULAR_MODES.has(mode)) {
      throw sourceError('candidate-tree-invalid');
    }
    entries.set(filePath, { mode, oid });
  }
  if (entries.size !== files.length || files.some(filePath => !entries.has(filePath))) {
    throw sourceError('candidate-tree-invalid');
  }
  return entries;
}

async function loadCandidate({ repoRoot, policy, git }) {
  const root = path.resolve(repoRoot);
  const { files, schemaVersion } = validatePolicy(policy);
  const commit = await readCommit(git, root);
  await assertClean(git, root, files);
  const tree = parseTree(
    await gitRun(git, root, ['ls-tree', '-z', commit, '--', ...files]),
    files,
  );
  const snapshot = new Map();
  for (const filePath of files) {
    const bytes = await gitRun(git, root, ['show', `${commit}:${filePath}`]);
    const treeEntry = tree.get(filePath);
    if (gitBlobOid(bytes) !== treeEntry.oid) throw sourceError('candidate-tree-invalid');
    snapshot.set(filePath, { ...treeEntry, bytes: Buffer.from(bytes) });
  }
  const endingCommit = await readCommit(git, root);
  await assertClean(git, root, files);
  if (endingCommit !== commit) throw sourceError('candidate-changed');
  let manifest;
  try {
    manifest = buildSnapshotManifest({ commit, snapshot, schemaVersion });
  } catch {
    throw sourceError('candidate-manifest-invalid');
  }
  return { commit, files, manifest, snapshot, root, schemaVersion };
}

function availabilityFailure(error) {
  const trusted = new Set([
    'policy-invalid',
    'bundle-inputs-dirty',
    'candidate-tree-invalid',
    'candidate-manifest-invalid',
    'candidate-changed',
    'git-inspection-failed',
  ]);
  return {
    state: 'blocked',
    reason: trusted.has(error?.code) ? error.code : 'git-inspection-failed',
  };
}

export async function inspectLocalCandidate({ repoRoot, activeDigest, policy, git = localGit }) {
  try {
    const candidate = await loadCandidate({ repoRoot, policy, git });
    if (candidate.manifest.bundleDigest === activeDigest) {
      return { state: 'unavailable', reason: 'already-active' };
    }
    return {
      state: 'available',
      commit: candidate.commit,
      digest: candidate.manifest.bundleDigest,
    };
  } catch (error) {
    return availabilityFailure(error);
  }
}

async function ensurePlainDirectory(directory, { create = false, mode = 0o700 } = {}) {
  if (create) await mkdir(directory, { mode }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw sourceError('quarantine-path-invalid');
  return info;
}

async function validateQuarantine(repoRoot, quarantineRoot, reviewId) {
  if (typeof reviewId !== 'string' || !REVIEW_ID.test(reviewId)) throw sourceError('quarantine-path-invalid');
  const root = path.resolve(repoRoot);
  const expected = path.join(root, 'runtime', 'quarantine');
  if (typeof quarantineRoot !== 'string' || path.resolve(quarantineRoot) !== expected) {
    throw sourceError('quarantine-path-invalid');
  }
  await ensurePlainDirectory(root);
  return { expected, reviewRoot: path.join(expected, reviewId) };
}

async function prepareQuarantine(root, quarantineRoot, reviewRoot) {
  const runtimeRoot = path.join(root, 'runtime');
  await ensurePlainDirectory(runtimeRoot, { create: true });
  await ensurePlainDirectory(quarantineRoot, { create: true });
  await chmod(quarantineRoot, 0o700);
  try {
    await mkdir(reviewRoot, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw sourceError('quarantine-exists');
    throw error;
  }
}

async function writeSnapshot(bundleRoot, candidate) {
  await mkdir(bundleRoot, { mode: 0o700 });
  for (const filePath of candidate.files) {
    const entry = candidate.snapshot.get(filePath);
    const destination = path.join(bundleRoot, ...filePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const mode = Number.parseInt(entry.mode.slice(-3), 8);
    await writeFile(destination, entry.bytes, { flag: 'wx', mode });
    await chmod(destination, mode);
  }
}

async function sealBundle(bundleRoot, files) {
  const directories = new Set([bundleRoot]);
  for (const filePath of files) {
    const absolutePath = path.join(bundleRoot, ...filePath.split('/'));
    await chmod(absolutePath, 0o400);
    let current = path.dirname(absolutePath);
    while (current !== bundleRoot) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await chmod(directory, 0o500);
  }
}

async function rereadSnapshot(bundleRoot, candidate) {
  const snapshot = new Map();
  for (const filePath of candidate.files) {
    const absolutePath = path.join(bundleRoot, ...filePath.split('/'));
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o400) {
      throw sourceError('staging-verification-failed');
    }
    snapshot.set(filePath, {
      ...candidate.snapshot.get(filePath),
      bytes: await readFile(absolutePath),
    });
  }
  return snapshot;
}

async function makeOwnedTreeWritable(target) {
  const info = await lstat(target).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(target, 0o700);
    for (const entry of await readdir(target)) {
      await makeOwnedTreeWritable(path.join(target, entry));
    }
  } else {
    await chmod(target, 0o600);
  }
}

export async function stageLocalCandidate({ repoRoot, reviewId, quarantineRoot, policy, git = localGit }) {
  const quarantine = await validateQuarantine(repoRoot, quarantineRoot, reviewId);
  const candidate = await loadCandidate({ repoRoot, policy, git });
  let created = false;
  try {
    await prepareQuarantine(candidate.root, quarantine.expected, quarantine.reviewRoot);
    created = true;
    const bundleRoot = path.join(quarantine.reviewRoot, 'bundle');
    const manifestPath = path.join(quarantine.reviewRoot, 'staging-manifest.json');
    await writeSnapshot(bundleRoot, candidate);

    const first = await buildBundleManifest({
      root: bundleRoot,
      files: candidate.files,
      sourceCommit: candidate.commit,
      schemaVersion: candidate.schemaVersion,
    });
    assertBundleManifest(first);
    if (first.bundleDigest !== candidate.manifest.bundleDigest) throw sourceError('staging-verification-failed');
    await writeFile(manifestPath, `${canonicalJson(first)}\n`, { flag: 'wx', mode: 0o600 });

    const second = await buildBundleManifest({
      root: bundleRoot,
      files: candidate.files,
      sourceCommit: candidate.commit,
      schemaVersion: candidate.schemaVersion,
    });
    if (second.bundleDigest !== first.bundleDigest) throw sourceError('staging-verification-failed');
    const persisted = assertBundleManifest(decodeJson(await readFile(manifestPath)));
    if (persisted.bundleDigest !== first.bundleDigest) throw sourceError('staging-verification-failed');

    await sealBundle(bundleRoot, candidate.files);
    await chmod(manifestPath, 0o400);
    const sealedSnapshot = await rereadSnapshot(bundleRoot, candidate);
    const sealedManifest = buildSnapshotManifest({
      commit: candidate.commit,
      snapshot: sealedSnapshot,
      schemaVersion: candidate.schemaVersion,
    });
    if (sealedManifest.bundleDigest !== first.bundleDigest) throw sourceError('staging-verification-failed');
    const sealedManifestInfo = await lstat(manifestPath);
    if (!sealedManifestInfo.isFile() || sealedManifestInfo.isSymbolicLink() || (sealedManifestInfo.mode & 0o777) !== 0o400) {
      throw sourceError('staging-verification-failed');
    }
    const sealedPersisted = assertBundleManifest(decodeJson(await readFile(manifestPath)));
    if (sealedPersisted.bundleDigest !== first.bundleDigest) throw sourceError('staging-verification-failed');

    const finalCommit = await readCommit(git, candidate.root);
    await assertClean(git, candidate.root, candidate.files);
    if (finalCommit !== candidate.commit) throw sourceError('candidate-changed');

    return Object.freeze({ bundleRoot, manifestPath, manifest: sealedManifest });
  } catch (error) {
    if (created) {
      await makeOwnedTreeWritable(quarantine.reviewRoot).catch(() => {});
      await rm(quarantine.reviewRoot, { recursive: true, force: true }).catch(() => {});
    }
    throw error?.code ? error : sourceError('staging-failed');
  }
}
