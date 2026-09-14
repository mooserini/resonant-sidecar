import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { assertBundleManifest, buildBundleManifest } from './bundle-manifest.js';
import { canonicalJson, sha256Bytes, sha256Json } from './canonical-json.js';
import { compareCapabilities } from './capability-diff.js';
import { sanitizeEvidence } from './redaction.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PINNED_POLICY = JSON.parse(await readFile(new URL('../policy/review-policy.v1.json', import.meta.url)));
const HARNESS = path.join(ROOT, 'review/trusted-harness.js');
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 65536;
const TIMEOUT_MS = 10000;

function failure(name, reasonCode) { return { name, passed: false, reasonCode }; }

async function sealedSnapshot(staged, policy) {
  const manifest = assertBundleManifest(staged.manifest);
  if (manifest.schemaVersion !== policy.schemaVersion) throw new Error('schema');
  const expected = [...policy.approvedBundlePaths].sort();
  if (canonicalJson(manifest.files.map(file => file.path)) !== canonicalJson(expected)) throw new Error('inventory');
  const found = [];
  async function walk(directory, prefix = '') {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o500) throw new Error('directory');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${name}/`);
      else if (entry.isFile()) found.push(name);
      else throw new Error('special-file');
    }
  }
  await walk(staged.bundleRoot);
  if (canonicalJson(found.sort()) !== canonicalJson(expected)) throw new Error('inventory');
  if (path.resolve(staged.manifestPath) !== path.join(path.dirname(path.resolve(staged.bundleRoot)), 'staging-manifest.json')) throw new Error('manifest-path');
  const manifestInfo = await lstat(staged.manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || (manifestInfo.mode & 0o777) !== 0o400) throw new Error('manifest-mode');
  if (canonicalJson(assertBundleManifest(JSON.parse(await readFile(staged.manifestPath, 'utf8')))) !== canonicalJson(manifest)) throw new Error('manifest');
  const sources = {};
  let total = 0;
  for (const file of manifest.files) {
    if (file.bytes > MAX_INPUT_BYTES || (total += file.bytes) > MAX_INPUT_BYTES) throw new Error('size');
    const handle = await open(path.join(staged.bundleRoot, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o400 || info.size !== file.bytes) throw new Error('file');
      const bytes = await handle.readFile();
      if (bytes.length !== file.bytes || sha256Bytes(bytes) !== file.sha256) throw new Error('digest');
      sources[file.path] = UTF8.decode(bytes);
    } finally { await handle.close(); }
  }
  // Recompute declarations as well as file hashes; retained source modes are
  // distinct from the read-only quarantine modes applied by staging.
  const rebuilt = await buildBundleManifest({ root: staged.bundleRoot, files: expected, sourceCommit: manifest.sourceCommit, schemaVersion: manifest.schemaVersion });
  rebuilt.files = rebuilt.files.map(file => ({ ...file, mode: manifest.files.find(original => original.path === file.path).mode }));
  const { bundleDigest: ignored, ...unsigned } = rebuilt;
  if (sha256Json(unsigned) !== manifest.bundleDigest) throw new Error('digest');
  return sources;
}

async function boundedRun(invocation) {
  return new Promise(resolve => {
    let child;
    let timer;
    let total = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    const stdout = [];
    const stderr = [];
    const finish = exitCode => {
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut, outputLimitExceeded });
    };
    try {
      child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { finish(-1); return; }
    timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, invocation.timeoutMs);
    for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', bytes => {
        total += bytes.length;
        if (total > invocation.maxOutputBytes) { outputLimitExceeded = true; child.kill('SIGKILL'); }
        else output.push(bytes);
      });
    }
    child.once('error', () => finish(-1));
    child.once('close', code => finish(Number.isInteger(code) ? code : -1));
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.input);
  });
}

export async function runDeterministicReview({ staged, active, policy, trustedHarness = { root: ROOT } }) {
  const checks = [];
  const verifierIdentities = [];
  let resultPolicy = PINNED_POLICY;
  const finish = () => {
    const result = { passed: checks.every(check => check.passed), checks, verifierIdentities,
      policySnapshotHash: sha256Json(resultPolicy),
      ...(activeManifest && staged?.manifest ? { activeBundleDigest: activeManifest.bundleDigest, candidateBundleDigest: staged.manifest.bundleDigest } : {}),
    };
    try { return sanitizeEvidence(result, resultPolicy); }
    catch { return { passed: false, checks: [failure('sanitization', 'sanitization-failed')] }; }
  };
  let activeManifest;
  try {
    if (canonicalJson(policy) !== canonicalJson(PINNED_POLICY) || path.resolve(trustedHarness.root) !== path.resolve(ROOT)) throw new Error('policy');
    resultPolicy = policy;
  } catch { checks.push(failure('schema', 'policy-invalid')); return finish(); }
  let sources;
  let activeSources;
  try {
    activeManifest = assertBundleManifest(active.manifest ?? active);
    sources = await sealedSnapshot(staged, policy);
    const activeRoot = active.root ?? ROOT;
    const rebuiltActive = await buildBundleManifest({ root: activeRoot, files: activeManifest.files.map(file => file.path), sourceCommit: activeManifest.sourceCommit, schemaVersion: activeManifest.schemaVersion });
    if (rebuiltActive.bundleDigest !== activeManifest.bundleDigest) throw new Error('active');
    activeSources = Object.fromEntries(await Promise.all(activeManifest.files.map(async file => [file.path, await readFile(path.join(activeRoot, file.path), 'utf8')])));
    checks.push({ name: 'schema', passed: true }, { name: 'staged-integrity', passed: true });
  } catch { checks.push(failure('staged-integrity', 'staged-integrity-failed')); return finish(); }
  const delta = compareCapabilities({ active: { manifest: activeManifest, sources: activeSources }, candidate: { manifest: staged.manifest, sources }, policy });
  checks.push(...delta.checks);
  if (!delta.passed) return finish();
  try {
    if (process.platform !== 'darwin') throw new Error('sandbox-unavailable');
    const executable = await realpath(process.execPath);
    // VM contexts are not a security boundary. macOS enforces the outer ban on
    // network, writes, and child processes, including after a VM escape.
    const profile = `(version 1)(deny default)(allow file-read*)(allow sysctl-read)(allow process-exec (literal ${JSON.stringify(executable)}))`;
    for (const [name, file] of [['node', executable], ['sandbox-launcher', '/usr/bin/sandbox-exec'], ['trusted-harness', HARNESS], ['deterministic-verifier', fileURLToPath(import.meta.url)]]) {
      verifierIdentities.push({ name, sha256: sha256Bytes(await readFile(file)) });
    }
    verifierIdentities.push({ name: 'sandbox-profile', sha256: sha256Bytes(profile) });
    const runner = trustedHarness.runner ?? boundedRun;
    for (const command of policy.trustedTestCommands) {
      // Revalidate before every use. The subprocess receives these exact bytes
      // on stdin and never loads candidate files or candidate test paths.
      sources = await sealedSnapshot(staged, policy);
      const syntax = command[1] === '--check';
      const name = syntax ? `syntax-${policy.approvedBundlePaths.indexOf(command[2])}` : command.at(-1);
      const args = syntax ? ['--check', '--input-type=module'] : ['--experimental-vm-modules', HARNESS, name];
      const input = syntax ? sources[command[2]] : JSON.stringify(sources);
      let output;
      try {
        output = await runner({ command: '/usr/bin/sandbox-exec', args: ['-p', profile, executable, ...args], input, cwd: ROOT, env: { LANG: 'C', LC_ALL: 'C' }, shell: false, timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
      } catch { output = null; }
      const valid = output && Number.isSafeInteger(output.exitCode) && Buffer.isBuffer(output.stdout) && Buffer.isBuffer(output.stderr) && output.stdout.length + output.stderr.length <= MAX_OUTPUT_BYTES;
      const passed = Boolean(valid && output.exitCode === 0 && !output.timedOut && !output.outputLimitExceeded);
      checks.push({ name, command, passed, exitCode: valid ? output.exitCode : -1, outputDigest: sha256Json({ stdoutDigest: sha256Bytes(valid ? output.stdout : Buffer.alloc(0)), stderrDigest: sha256Bytes(valid ? output.stderr : Buffer.alloc(0)) }), ...(passed ? {} : { reasonCode: syntax ? 'syntax-failed' : 'trusted-test-failed' }) });
      if (!passed) return finish();
    }
    await sealedSnapshot(staged, policy);
    checks.push({ name: 'sanitization', passed: true });
  } catch { checks.push(failure('staged-integrity', 'staged-integrity-failed')); }
  return finish();
}
