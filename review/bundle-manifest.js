import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Bytes, sha256Json } from './canonical-json.js';

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepack',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'postpack',
  'preversion',
  'version',
  'postversion',
]);
const DEPENDENCY_LOCKFILES = [
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

function compareBytewise(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be a plain object`);
}

function assertStringArray(value, name) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return [...value].sort(compareBytewise);
}

function assertSha256(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
}

export function assertSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Bundle path must be a non-empty relative path');
  }
  if (value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new TypeError(`Bundle path must be a normalized POSIX relative path: ${value}`);
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`Bundle path must be a normalized POSIX relative path: ${value}`);
  }
  return value;
}

async function readJson(root, relativePath, name) {
  const filePath = await assertRegularPath(root, assertSafeRelativePath(relativePath));
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new TypeError(`Missing ${name}: ${filePath}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypeError(`Invalid ${name}: ${filePath}`, { cause: error });
  }
}

async function assertRegularPath(root, relativePath) {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new TypeError(`Bundle root is a symbolic link: ${root}`);
  if (!rootInfo.isDirectory()) throw new TypeError(`Bundle root is not a directory: ${root}`);

  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(`Bundle input is a symbolic link: ${relativePath}`);
    if (segment !== relativePath.split('/').at(-1) && !info.isDirectory()) {
      throw new TypeError(`Bundle input parent is not a directory: ${relativePath}`);
    }
    if (segment === relativePath.split('/').at(-1) && !info.isFile()) {
      throw new TypeError(`Bundle input is not a regular file: ${relativePath}`);
    }
  }
  return current;
}

function orderedRuntimeDependencies(packageJson) {
  const groups = [packageJson.dependencies ?? {}, packageJson.optionalDependencies ?? {}];
  for (const group of groups) {
    if (!isPlainObject(group) || Object.values(group).some(specifier => typeof specifier !== 'string')) {
      throw new TypeError('package.json runtime dependencies must map names to exact strings');
    }
  }
  const declared = Object.assign({}, ...groups);
  return Object.entries(declared)
    .sort(([left], [right]) => compareBytewise(left, right))
    .map(([name, specifier]) => ({ name, specifier }));
}

async function readDependencyLockfiles(root) {
  const entries = [];
  for (const relativePath of DEPENDENCY_LOCKFILES) {
    const absolutePath = path.join(root, relativePath);
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink()) throw new TypeError(`Dependency lockfile is a symbolic link: ${relativePath}`);
    if (!info.isFile()) throw new TypeError(`Dependency lockfile is not a regular file: ${relativePath}`);
    const bytes = await readFile(absolutePath);
    entries.push({ path: relativePath, bytes: bytes.length, sha256: sha256Bytes(bytes) });
  }
  return entries.sort((left, right) => compareBytewise(left.path, right.path));
}

export async function readDeclaredCapabilities(root) {
  const extensionManifest = await readJson(root, 'extension/manifest.json', 'extension manifest');
  assertPlainObject(extensionManifest, 'extension manifest');
  const packageJson = await readJson(root, 'package.json', 'package.json');
  assertPlainObject(packageJson, 'package.json');

  const scripts = packageJson.scripts ?? {};
  assertPlainObject(scripts, 'package.json scripts');
  const lifecycleScripts = Object.keys(scripts)
    .filter(name => LIFECYCLE_SCRIPTS.has(name))
    .sort(compareBytewise);

  return {
    chromePermissions: assertStringArray(extensionManifest.permissions ?? [], 'extension manifest permissions'),
    hostPermissions: assertStringArray(extensionManifest.host_permissions ?? [], 'extension manifest host_permissions'),
    lifecycleScripts,
    listeners: [],
  };
}

export async function readDependencyIdentity(root) {
  const packageJson = await readJson(root, 'package.json', 'package.json');
  assertPlainObject(packageJson, 'package.json');
  if (packageJson.packageManager !== undefined && typeof packageJson.packageManager !== 'string') {
    throw new TypeError('package.json packageManager must be a string');
  }
  return {
    lockfiles: await readDependencyLockfiles(root),
    packageManager: packageJson.packageManager ?? null,
    runtime: orderedRuntimeDependencies(packageJson),
  };
}

function assertFileEntry(value) {
  assertPlainObject(value, 'Bundle file entry');
  const expectedKeys = ['bytes', 'mode', 'path', 'sha256'];
  if (Object.keys(value).sort().join(',') !== expectedKeys.join(',')) {
    throw new TypeError('Bundle file entry has unexpected fields');
  }
  assertSafeRelativePath(value.path);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new TypeError(`Bundle file byte count is invalid: ${value.path}`);
  }
  assertSha256(value.sha256, `Bundle file hash for ${value.path}`);
  if (!Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o777) {
    throw new TypeError(`Bundle file mode is invalid: ${value.path}`);
  }
}

function assertCapabilities(value) {
  assertPlainObject(value, 'Bundle capabilities');
  const expectedKeys = ['chromePermissions', 'hostPermissions', 'lifecycleScripts', 'listeners'];
  if (Object.keys(value).sort().join(',') !== expectedKeys.join(',')) {
    throw new TypeError('Bundle capabilities have unexpected fields');
  }
  for (const key of expectedKeys) {
    const ordered = assertStringArray(value[key], `Bundle capabilities ${key}`);
    if (ordered.some((entry, index) => entry !== value[key][index])) {
      throw new TypeError(`Bundle capabilities ${key} must be bytewise sorted`);
    }
  }
}

function assertDependencies(value) {
  assertPlainObject(value, 'Bundle dependencies');
  if (Object.keys(value).sort().join(',') !== 'lockfiles,packageManager,runtime') {
    throw new TypeError('Bundle dependencies have unexpected fields');
  }
  if (value.packageManager !== null && typeof value.packageManager !== 'string') {
    throw new TypeError('Bundle dependency packageManager is invalid');
  }
  if (!Array.isArray(value.runtime)) throw new TypeError('Bundle runtime dependencies must be an array');
  let previous = null;
  for (const dependency of value.runtime) {
    assertPlainObject(dependency, 'Bundle runtime dependency');
    if (Object.keys(dependency).sort().join(',') !== 'name,specifier' || typeof dependency.name !== 'string' || typeof dependency.specifier !== 'string') {
      throw new TypeError('Bundle runtime dependency is invalid');
    }
    if (previous !== null && compareBytewise(previous, dependency.name) >= 0) {
      throw new TypeError('Bundle runtime dependencies must be bytewise sorted and unique');
    }
    previous = dependency.name;
  }
  if (!Array.isArray(value.lockfiles)) throw new TypeError('Bundle dependency lockfiles must be an array');
  let previousLockfile = null;
  for (const lockfile of value.lockfiles) {
    assertPlainObject(lockfile, 'Bundle dependency lockfile');
    if (Object.keys(lockfile).sort().join(',') !== 'bytes,path,sha256') {
      throw new TypeError('Bundle dependency lockfile has unexpected fields');
    }
    assertSafeRelativePath(lockfile.path);
    if (!Number.isSafeInteger(lockfile.bytes) || lockfile.bytes < 0) {
      throw new TypeError(`Bundle dependency lockfile byte count is invalid: ${lockfile.path}`);
    }
    assertSha256(lockfile.sha256, `Bundle dependency lockfile hash for ${lockfile.path}`);
    if (previousLockfile !== null && compareBytewise(previousLockfile, lockfile.path) >= 0) {
      throw new TypeError('Bundle dependency lockfiles must be bytewise sorted and unique');
    }
    previousLockfile = lockfile.path;
  }
}

export function assertBundleManifest(value) {
  assertPlainObject(value, 'Bundle manifest');
  const expectedKeys = ['bundleDigest', 'capabilities', 'dependencies', 'files', 'schemaVersion', 'sourceCommit'];
  if (Object.keys(value).sort().join(',') !== expectedKeys.join(',')) {
    throw new TypeError('Bundle manifest has unexpected fields');
  }
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw new TypeError('Bundle manifest schemaVersion is invalid');
  }
  if (typeof value.sourceCommit !== 'string' || !SOURCE_COMMIT.test(value.sourceCommit)) {
    throw new TypeError('Bundle manifest sourceCommit must be a lowercase 40-character Git commit');
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new TypeError('Bundle manifest files must be a non-empty array');
  }
  let previousPath = null;
  for (const entry of value.files) {
    assertFileEntry(entry);
    if (previousPath !== null && compareBytewise(previousPath, entry.path) >= 0) {
      throw new TypeError('Bundle manifest files must be bytewise sorted and unique');
    }
    previousPath = entry.path;
  }
  assertCapabilities(value.capabilities);
  assertDependencies(value.dependencies);
  assertSha256(value.bundleDigest, 'Bundle manifest bundleDigest');

  const unsigned = {
    schemaVersion: value.schemaVersion,
    sourceCommit: value.sourceCommit,
    files: value.files,
    capabilities: value.capabilities,
    dependencies: value.dependencies,
  };
  if (sha256Json(unsigned) !== value.bundleDigest) {
    throw new TypeError('Bundle manifest bundle digest does not match its contents');
  }
  return value;
}

export async function buildBundleManifest({ root, files, sourceCommit, schemaVersion }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError('Bundle files must be a non-empty array');
  }
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError('Bundle schemaVersion is invalid');
  }
  if (typeof sourceCommit !== 'string' || !SOURCE_COMMIT.test(sourceCommit)) {
    throw new TypeError('Bundle sourceCommit must be a lowercase 40-character Git commit');
  }

  const orderedPaths = files.map(assertSafeRelativePath).sort(compareBytewise);
  if (orderedPaths.some((entry, index) => entry === orderedPaths[index - 1])) {
    throw new TypeError('Bundle files contain a duplicate path');
  }

  const entries = [];
  for (const relativePath of orderedPaths) {
    const absolutePath = await assertRegularPath(root, relativePath);
    const bytes = await readFile(absolutePath);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) throw new TypeError(`Bundle input is a symbolic link: ${relativePath}`);
    if (!info.isFile()) throw new TypeError(`Bundle input is not a regular file: ${relativePath}`);
    entries.push({
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      mode: info.mode & 0o777,
    });
  }

  const [capabilities, dependencies] = await Promise.all([
    readDeclaredCapabilities(root),
    readDependencyIdentity(root),
  ]);
  const unsigned = { schemaVersion, sourceCommit, files: entries, capabilities, dependencies };
  return assertBundleManifest({ ...unsigned, bundleDigest: sha256Json(unsigned) });
}
