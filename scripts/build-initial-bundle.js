#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertBundleManifest, assertSafeRelativePath } from '../review/bundle-manifest.js';
import { canonicalJson, sha256Bytes, sha256Json } from '../review/canonical-json.js';
import { localGit } from '../review/git-runner.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_POLICY = JSON.parse(await readFile(new URL('../policy/review-policy.v1.json', import.meta.url), 'utf8'));
const PINNED_POLICY_DIGEST = '2c800a3dbb7520e37129213f0dabb648bca6cde03ed3180c91faee1f868f0821';
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_MODE = new Map([['100644', 0o644]]);
const LIFECYCLE = new Set(['preinstall', 'install', 'postinstall', 'preuninstall', 'uninstall', 'postuninstall', 'prepack', 'prepare', 'preprepare', 'postprepare', 'prepublish', 'publish', 'postpublish', 'prepublishOnly', 'postpack', 'preversion', 'version', 'postversion', 'pretest', 'posttest', 'prestop', 'stop', 'poststop', 'prestart', 'start', 'poststart', 'prerestart', 'restart', 'postrestart', 'preshrinkwrap', 'shrinkwrap', 'postshrinkwrap']);
const compare = (left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

// This is an installer-owned trust graph, not the candidate-bundle allowlist.
// Every relative import reachable from runtime-entry.js must terminate here.
export const TRUSTED_BOOTSTRAP_FILES = Object.freeze([
  'bootstrap/host.js',
  'bootstrap/native-proxy.js',
  'bootstrap/recovery-state.js',
  'bootstrap/runtime-lock.js',
  'bootstrap/version-store.js',
  'native-host/native-framing.js',
  'native-host/sidecar-protocol.js',
  'policy/codex-attestation.v1.schema.json',
  'policy/review-policy.v1.json',
  'presentation/desktop-handoff.js',
  'presentation/macos-dialog.js',
  'review/bundle-manifest.js',
  'review/candidate-source.js',
  'review/canonical-json.js',
  'review/capability-diff.js',
  'review/codex-prompt.js',
  'review/codex-verifier.js',
  'review/decision-nonce.js',
  'review/deterministic-verifier.js',
  'review/git-runner.js',
  'review/macos-evidence.js',
  'review/process-ownership.js',
  'review/receipt-store.js',
  'review/redaction.js',
  'review/review-coordinator.js',
  'review/review-state.js',
  'review/trusted-harness.js',
].sort(compare));

function fail(message) { throw new Error(`Initial bundle inspection failed: ${message}`); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function exactPolicy(policy) {
  if (!plain(policy) || sha256Json(PINNED_POLICY) !== PINNED_POLICY_DIGEST || canonicalJson(policy) !== canonicalJson(PINNED_POLICY)) fail('untrusted policy');
  return policy;
}
async function gitBytes(git, repoRoot, args) {
  const result = await git.run({ repoRoot, args });
  if (!result || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr) || result.stderr.length) fail('Git inspection output');
  return result.stdout;
}
async function head(git, repoRoot) {
  const value = (await gitBytes(git, repoRoot, ['rev-parse', '--verify', 'HEAD'])).toString('utf8').trim();
  if (!COMMIT.test(value)) fail('invalid committed HEAD');
  return value;
}
function gitOid(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash('sha1').update(header).update(bytes).digest('hex');
}
function parseTree(bytes, expected) {
  const result = new Map();
  for (const record of bytes.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(\d{6}) blob ([0-9a-f]{40})\t([^\n]+)$/);
    if (!match || result.has(match[3])) fail('invalid Git tree');
    result.set(match[3], { modeText: match[1], oid: match[2] });
  }
  if (result.size !== expected.length || expected.some(name => !result.has(name))) fail('source tree is incomplete');
  return result;
}
function decodeJson(bytes, name) {
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!plain(value)) throw new Error(); return value; }
  catch { fail(`invalid ${name}`); }
}
function capabilities(extensionManifest, packageJson) {
  const scripts = packageJson.scripts ?? {};
  if (!plain(scripts)) fail('invalid package scripts');
  const lifecycleScripts = Object.keys(scripts).filter(name => LIFECYCLE.has(name)).sort(compare);
  if (lifecycleScripts.length) fail('lifecycle hooks are forbidden');
  const chromePermissions = [...(extensionManifest.permissions ?? [])].sort(compare);
  const hostPermissions = [...(extensionManifest.host_permissions ?? [])].sort(compare);
  if ([chromePermissions, hostPermissions].some(values => values.some(value => typeof value !== 'string'))) fail('invalid Chrome permissions');
  if (extensionManifest.optional_permissions || extensionManifest.optional_host_permissions) fail('optional permissions are forbidden');
  return { chromePermissions, hostPermissions, lifecycleScripts: Object.hasOwn(scripts, 'test') ? ['test'] : [], listeners: [] };
}
function dependencies(packageJson) {
  for (const key of ['dependencies', 'optionalDependencies']) if (packageJson[key] && Object.keys(packageJson[key]).length) fail('runtime dependencies require a separate migration');
  return { lockfiles: [], packageManager: packageJson.packageManager ?? null, runtime: [] };
}
function artifacts(snapshot, names) {
  return names.map(relativePath => {
    const item = snapshot.get(relativePath);
    return Object.freeze({ relativePath, bytes: Buffer.from(item.bytes), mode: item.mode, sha256: sha256Bytes(item.bytes) });
  });
}

function moduleTokens(source, name) {
  const tokens = [];
  const identifierStart = character => /[A-Za-z_$]/.test(character ?? '');
  const identifierPart = character => /[A-Za-z0-9_$]/.test(character ?? '');
  const regexPrefix = new Set(['(', '[', '{', ',', ':', ';', '=', '!', '?', '&&', '||', '??', '=>', '+', '-', '*', '%', '&', '|', '^', '~', '<', '>']);
  const regexKeyword = new Set(['case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'return', 'throw', 'typeof', 'void', 'yield', 'await']);
  const failSyntax = detail => fail(`unparseable trusted module syntax at ${name}: ${detail}`);

  function stringToken(start, quote) {
    let index = start + 1;
    let value = '';
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (character === quote) {
        tokens.push({ type: 'string', value, escaped, start });
        return index + 1;
      }
      if (character === '\\') {
        escaped = true;
        if (index + 1 >= source.length) failSyntax('unterminated string');
        value += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (character === '\n' || character === '\r') failSyntax('unterminated string');
      value += character;
      index += 1;
    }
    failSyntax('unterminated string');
  }

  function regexLiteral(start) {
    let index = start + 1;
    let characterClass = false;
    while (index < source.length) {
      const character = source[index];
      if (character === '\\') { index += 2; continue; }
      if (character === '\n' || character === '\r') failSyntax('unterminated regular expression');
      if (character === '[') characterClass = true;
      else if (character === ']') characterClass = false;
      else if (character === '/' && !characterClass) {
        index += 1;
        while (identifierPart(source[index])) index += 1;
        return index;
      }
      index += 1;
    }
    failSyntax('unterminated regular expression');
  }

  function canStartRegex() {
    const previous = tokens.at(-1);
    return !previous || (previous.type === 'punct' && regexPrefix.has(previous.value)) || (previous.type === 'identifier' && regexKeyword.has(previous.value));
  }

  function templateLiteral(start) {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '`') return index + 1;
      if (source[index] === '$' && source[index + 1] === '{') {
        index = scan(index + 2, true);
        continue;
      }
      index += 1;
    }
    failSyntax('unterminated template');
  }

  function scan(start = 0, stopAtBrace = false) {
    let index = start;
    let braceDepth = 0;
    while (index < source.length) {
      const character = source[index];
      if (/\s/.test(character)) { index += 1; continue; }
      if (character === '/' && source[index + 1] === '/') {
        index += 2;
        while (index < source.length && !['\n', '\r'].includes(source[index])) index += 1;
        continue;
      }
      if (character === '/' && source[index + 1] === '*') {
        const end = source.indexOf('*/', index + 2);
        if (end === -1) failSyntax('unterminated comment');
        index = end + 2;
        continue;
      }
      if (character === '/' && canStartRegex()) { index = regexLiteral(index); continue; }
      if (character === "'" || character === '"') { index = stringToken(index, character); continue; }
      if (character === '`') { index = templateLiteral(index); continue; }
      if (identifierStart(character)) {
        const begin = index++;
        while (identifierPart(source[index])) index += 1;
        tokens.push({ type: 'identifier', value: source.slice(begin, index), start: begin });
        continue;
      }
      if (character === '{') braceDepth += 1;
      if (character === '}') {
        if (stopAtBrace && braceDepth === 0) return index + 1;
        braceDepth -= 1;
        if (braceDepth < 0) failSyntax('unmatched closing brace');
      }
      const pair = source.slice(index, index + 2);
      const value = ['&&', '||', '??', '=>'].includes(pair) ? pair : character;
      tokens.push({ type: 'punct', value, start: index });
      index += value.length;
    }
    if (stopAtBrace) failSyntax('unterminated template expression');
    return index;
  }

  scan();
  return tokens;
}

function importSpecifiers(source, name) {
  const tokens = moduleTokens(source, name);
  const specifiers = [];
  const literal = token => {
    if (token?.type !== 'string' || token.escaped) fail(`non-literal or escaped import at ${name}`);
    specifiers.push(token.value);
  };
  const statementEnd = start => {
    let round = 0;
    let square = 0;
    let curly = 0;
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type !== 'punct') continue;
      if (token.value === '(') round += 1;
      else if (token.value === ')') round -= 1;
      else if (token.value === '[') square += 1;
      else if (token.value === ']') square -= 1;
      else if (token.value === '{') curly += 1;
      else if (token.value === '}') curly -= 1;
      else if (token.value === ';' && round === 0 && square === 0 && curly === 0) return index;
    }
    return tokens.length;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'identifier' || !['import', 'export'].includes(token.value) || tokens[index - 1]?.value === '.') continue;
    if (token.value === 'import' && tokens[index + 1]?.value === '.') continue;
    if (token.value === 'import' && tokens[index + 1]?.value === '(') {
      literal(tokens[index + 2]);
      if (tokens[index + 3]?.value !== ')') fail(`non-literal dynamic import at ${name}`);
      index += 3;
      continue;
    }
    if (token.value === 'import' && tokens[index + 1]?.type === 'string') {
      literal(tokens[index + 1]);
      index += 1;
      continue;
    }
    const end = statementEnd(index + 1);
    const from = tokens.slice(index + 1, end).findIndex(candidate => candidate.type === 'identifier' && candidate.value === 'from');
    if (from !== -1) literal(tokens[index + 2 + from]);
    else if (token.value === 'import') fail(`unparseable import at ${name}`);
  }
  return specifiers;
}

function assertClosedImports(snapshot, names) {
  const allowed = new Set(names);
  for (const name of names.filter(value => value.endsWith('.js'))) {
    const source = snapshot.get(name).bytes.toString('utf8');
    for (const specifier of importSpecifiers(source, name)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) fail(`ambient import in trusted import graph at ${name}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      if (!allowed.has(resolved)) fail(`trusted import graph escapes at ${name}`);
    }
  }
}

export async function inspectInitialBundle({ repoRoot, policy = PINNED_POLICY, git = localGit } = {}) {
  exactPolicy(policy);
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot) || path.normalize(repoRoot) !== repoRoot) fail('repository path');
  const allFiles = [...new Set([...policy.approvedBundlePaths, ...TRUSTED_BOOTSTRAP_FILES])].sort(compare);
  for (const name of allFiles) assertSafeRelativePath(name);
  const sourceCommit = await head(git, repoRoot);
  const dirty = await gitBytes(git, repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty.length) fail('source must be clean');
  const tree = parseTree(await gitBytes(git, repoRoot, ['ls-tree', '-z', sourceCommit, '--', ...allFiles]), allFiles);
  const snapshot = new Map();
  for (const relativePath of allFiles) {
    const entry = tree.get(relativePath);
    const mode = SAFE_MODE.get(entry.modeText);
    if (mode === undefined) fail('source must contain regular non-executable files');
    const bytes = await gitBytes(git, repoRoot, ['show', `${sourceCommit}:${relativePath}`]);
    if (gitOid(bytes) !== entry.oid) fail('Git source digest mismatch');
    snapshot.set(relativePath, { bytes: Buffer.from(bytes), mode });
  }
  if (await head(git, repoRoot) !== sourceCommit) fail('committed HEAD changed');
  if ((await gitBytes(git, repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).length) fail('source must remain clean');
  assertClosedImports(snapshot, TRUSTED_BOOTSTRAP_FILES);

  const committedPolicy = decodeJson(snapshot.get('policy/review-policy.v1.json').bytes, 'committed policy');
  if (sha256Json(committedPolicy) !== PINNED_POLICY_DIGEST || canonicalJson(committedPolicy) !== canonicalJson(policy)) fail('committed policy changed');
  const extensionManifest = decodeJson(snapshot.get('extension/manifest.json').bytes, 'extension manifest');
  const packageJson = decodeJson(snapshot.get('package.json').bytes, 'package.json');
  const declared = capabilities(extensionManifest, packageJson);
  const deps = dependencies(packageJson);
  const bundleFiles = artifacts(snapshot, [...policy.approvedBundlePaths].sort(compare));
  const unsigned = {
    schemaVersion: policy.schemaVersion,
    sourceCommit,
    files: bundleFiles.map(file => ({ path: file.relativePath, bytes: file.bytes.length, sha256: file.sha256, mode: file.mode })),
    capabilities: declared,
    dependencies: deps,
  };
  const manifest = assertBundleManifest({ ...unsigned, bundleDigest: sha256Json(unsigned) });
  const trustedFiles = artifacts(snapshot, TRUSTED_BOOTSTRAP_FILES);
  const trustedBootstrap = {
    files: trustedFiles,
    digest: sha256Json(trustedFiles.map(file => ({ path: file.relativePath, sha256: file.sha256, mode: file.mode }))),
  };
  const permissionMatch = canonicalJson(declared.chromePermissions) === canonicalJson([...policy.approvedCapabilities.chromePermissions].sort(compare)) && declared.hostPermissions.length === 0;
  const declarationComparison = {
    passed: permissionMatch && deps.runtime.length === 0 && declared.listeners.length === 0 && declared.lifecycleScripts.every(name => name === 'test'),
    checks: [
      { name: 'v1-permissions', passed: permissionMatch },
      { name: 'v1-stdio-only', passed: declared.listeners.length === 0 },
      { name: 'v1-runtime-dependencies', passed: deps.runtime.length === 0 },
      { name: 'v1-lifecycle-hooks', passed: declared.lifecycleScripts.every(name => name === 'test') },
    ],
  };
  if (!declarationComparison.passed) fail('V1 declaration comparison failed');
  return Object.freeze({ sourceCommit, bundle: { manifest, files: bundleFiles }, trustedBootstrap, declarationComparison });
}

async function safeDestination(destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || path.normalize(destination) !== destination || destination === path.parse(destination).root) fail('invalid materialization destination');
  let current = path.parse(destination).root;
  for (const part of path.dirname(destination).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('materialization parent custody');
  }
  try { await lstat(destination); fail('materialization destination must be empty and not exist'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function writeArtifact(root, artifact, sealed = false) {
  assertSafeRelativePath(artifact.relativePath);
  const target = path.join(root, artifact.relativePath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, sealed ? 0o400 : artifact.mode);
  try { await handle.writeFile(artifact.bytes); await handle.sync(); }
  finally { await handle.close(); }
  const observed = await lstat(target);
  if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1 || sha256Bytes(await readFile(target)) !== artifact.sha256) fail('materialized bytes changed');
}

export async function materializeInitialBundle({ inspection, destination } = {}) {
  if (!inspection?.bundle?.manifest || !inspection?.trustedBootstrap?.files) fail('invalid inspection');
  assertBundleManifest(inspection.bundle.manifest);
  await safeDestination(destination);
  const temporary = `${destination}.pending`;
  await safeDestination(temporary);
  try {
    await mkdir(temporary, { mode: 0o700 });
    const bundleRoot = path.join(temporary, 'bundle');
    const trustedBootstrapRoot = path.join(temporary, 'trusted-bootstrap');
    await mkdir(bundleRoot, { mode: 0o700 });
    await mkdir(trustedBootstrapRoot, { mode: 0o700 });
    for (const file of inspection.bundle.files) await writeArtifact(bundleRoot, file);
    for (const file of inspection.trustedBootstrap.files) await writeArtifact(trustedBootstrapRoot, file);
    await writeArtifact(temporary, { relativePath: 'bundle-manifest.json', bytes: Buffer.from(`${canonicalJson(inspection.bundle.manifest)}\n`), mode: 0o600, sha256: sha256Bytes(`${canonicalJson(inspection.bundle.manifest)}\n`) });
    await rename(temporary, destination);
    return Object.freeze({ bundleDigest: inspection.bundle.manifest.bundleDigest, bundleRoot: path.join(destination, 'bundle'), trustedBootstrapRoot: path.join(destination, 'trusted-bootstrap'), manifestPath: path.join(destination, 'bundle-manifest.json') });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const result = await inspectInitialBundle({ repoRoot: projectRoot });
  process.stdout.write(`${canonicalJson({ sourceCommit: result.sourceCommit, bundleDigest: result.bundle.manifest.bundleDigest, trustedBootstrapDigest: result.trustedBootstrap.digest, declarationComparison: result.declarationComparison, files: result.bundle.manifest.files })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
