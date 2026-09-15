import { constants, closeSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReceiptStore } from '../review/receipt-store.js';
import { loadReviewPolicy, reviewPolicyDigest } from '../review/policy-registry.js';
import { sha256Bytes } from '../review/canonical-json.js';
import { chromeReceipt } from '../test/fixtures/chrome-receipt.js';

const GOLDEN = new URL('../test/fixtures/receipts/v1/review-receipts', import.meta.url);
const V1_TAIL = 'c2a28877cf698c504739dd2f3089c14b0f128c66bc8dcbc1791e292fa650aeb5';
const GOLDEN_RECEIPTS = ['2026-09-14T00-00-00.000Z_v1-golden', '2026-09-14T00-00-00.001Z_v1-golden'];
const RECEIPT_FILES = ['attestation.json', 'policy-snapshot.json', 'receipt.json', 'receipt.sha256', 'report.md',
  ...['before', 'verification', 'after'].map(phase => `os/${phase}/evidence.json`),
  ...['active-version', 'candidate-version', 'dependency-lock', 'source-hashes', 'test-results'].map(name => `project/${name}.json`)];
const GOLDEN_FILES = ['.custody-head', 'latest-failure.json', ...GOLDEN_RECEIPTS.flatMap(directory => RECEIPT_FILES.map(name => `${directory}/${name}`))];
const GOLDEN_TOPOLOGY = new Map([['', 'directory'], ...GOLDEN_FILES.map(name => [name, 'file'])]);
for (const name of GOLDEN_FILES) for (let directory = path.dirname(name); directory !== '.'; directory = path.dirname(directory)) GOLDEN_TOPOLOGY.set(directory, 'directory');

function assertHeld(nodes) {
  for (const node of nodes) {
    const named = lstatSync(node.target), held = fstatSync(node.fd);
    for (const info of [named, held]) {
      if (info.dev !== node.info.dev || info.ino !== node.info.ino || info.isSymbolicLink() ||
        (node.directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024)) throw new Error('Receipt inode changed');
    }
    if (node.children && JSON.stringify(readdirSync(node.target).sort()) !== JSON.stringify(node.children)) throw new Error('Receipt inventory changed');
  }
}

// Open all original inodes before any permission change. O_NOFOLLOW protects
// each leaf; held ancestor identities and inventory are checked before descent
// and again before use. Sealing/cleanup only fchmod these held descriptors.
function withHeldTree(root, operation, { directoriesOnly = false } = {}) {
  const nodes = [];
  function visit(name) {
    assertHeld(nodes);
    const target = path.join(root, name), info = lstatSync(target);
    if (directoriesOnly && name && !info.isDirectory()) return; // Never follow cleanup links.
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024))) throw new Error('Nonregular receipt storage');
    const directory = info.isDirectory();
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
    const node = { name, target, info, directory, fd, children: null }; nodes.push(node);
    assertHeld(nodes);
    if (directory) {
      node.children = readdirSync(target).sort();
      for (const child of node.children) visit(path.join(name, child));
    }
  }
  try {
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Concrete receipt root required');
    visit(''); assertHeld(nodes);
    const result = operation(nodes); assertHeld(nodes); return result;
  } finally { for (const node of nodes.reverse()) closeSync(node.fd); }
}
function expectedGoldenHashes() {
  const text = readFileSync(new URL('../test/fixtures/receipts/v1/README.md', import.meta.url), 'utf8');
  const entries = [...text.matchAll(/^([a-f0-9]{64})  review-receipts\/(.+)$/gm)].map(([, hash, name]) => [name, hash]);
  const expected = new Map(entries);
  if (entries.length !== GOLDEN_FILES.length || expected.size !== GOLDEN_FILES.length || GOLDEN_FILES.some(name => !expected.has(name))) throw new Error('Golden receipt inventory mismatch');
  return expected;
}
function assertGoldenInventory(nodes, canonicalOnly) {
  const present = new Map(nodes.map(node => [node.name, node.directory ? 'directory' : 'file']));
  const selected = name => !canonicalOnly || GOLDEN_RECEIPTS.some(directory => name === directory || name.startsWith(directory + '/'));
  for (const [name, kind] of GOLDEN_TOPOLOGY) if (selected(name) && present.get(name) !== kind) throw new Error('Golden receipt topology mismatch');
  for (const node of nodes) if (selected(node.name) && !GOLDEN_TOPOLOGY.has(node.name)) {
    if (node.name !== '.pending' || !node.directory || node.children.length !== 0) throw new Error('Unexpected golden receipt entry');
  }
}
function goldenSnapshot(root, { canonicalOnly = false, seal = false } = {}) {
  const expected = expectedGoldenHashes();
  return withHeldTree(root, nodes => {
    assertGoldenInventory(nodes, canonicalOnly);
    const bytes = new Map();
    for (const node of nodes) if (!node.directory && expected.has(node.name)) {
      if (canonicalOnly && !node.name.startsWith('2026-')) continue;
      const value = readFileSync(node.fd);
      if (sha256Bytes(value) !== expected.get(node.name)) throw new Error('Golden receipt byte mismatch');
      bytes.set(node.name, value);
    }
    assertHeld(nodes);
    if (seal) for (const node of [...nodes].reverse()) if (GOLDEN_RECEIPTS.some(directory => node.name === directory || node.name.startsWith(directory + '/'))) {
      assertHeld(nodes);
      fchmodSync(node.fd, node.directory ? 0o555 : 0o444);
    }
    return bytes;
  });
}
async function copyGoldenSnapshot(root, bytes) {
  // Fixed paths and held source bytes replace recursive copying of mutable
  // golden pathnames. The complete new tree is validated before fchmod.
  await mkdir(root, { mode: 0o700 });
  for (const [name, kind] of [...GOLDEN_TOPOLOGY].sort(([a], [b]) => a.length - b.length)) {
    if (name && kind === 'directory') await mkdir(path.join(root, name), { mode: 0o700 });
  }
  await mkdir(path.join(root, '.pending'), { mode: 0o700 });
  for (const [name, value] of bytes) await writeFile(path.join(root, name), value, { flag: 'wx', mode: 0o600 });
  goldenSnapshot(root, { seal: true });
}
function unsealTemporary(root) {
  withHeldTree(root, nodes => {
    for (const node of nodes) { assertHeld(nodes); fchmodSync(node.fd, 0o700); }
  }, { directoriesOnly: true });
}
async function appendFixture(store) {
  const event = eventType => ({ reviewId: 'review-1', eventType, outcome: eventType,
    verifierIdentities: [{ name: 'fixture-verifier', version: '2' }], activeBundleDigest: 'a'.repeat(64), candidateBundleDigest: 'a'.repeat(64),
    projectEvidence: { activeVersion: {}, candidateVersion: {}, sourceHashes: {}, dependencyLock: {}, testResults: {} },
    osEvidence: { before: {}, verification: {}, after: {} },
  });
  for (const type of ['available', 'staged', 'deterministic-review', 'codex-review', 'chrome-semantic-review']) await store.finalizeEvent(event(type));
  await store.finalizeEvent({ ...event('eligible'), semanticReview: chromeReceipt() });
}

/** Supplied storage is copied without normalization: ReceiptStore may mark a
 * corrupt chain, so all verification effects belong to this disposable copy.
 * No recovery, receipt repair, installer, or live runtime operation is called. */
export async function verifyReceiptChain({ root = null } = {}) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-receipt-verification-')));
  const copy = path.join(temporary, 'review-receipts');
  const source = root === null ? 'disposable-mixed-fixture' : 'supplied-root-snapshot';
  try {
    if (root !== null) {
      if (!path.isAbsolute(root) || path.normalize(root) !== root || path.basename(root) !== 'review-receipts' || await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('Explicit receipt directory required');
      withHeldTree(root, () => {});
      await cp(root, copy, { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
      withHeldTree(root, () => {}); withHeldTree(copy, () => {});
    } else {
      await copyGoldenSnapshot(copy, goldenSnapshot(fileURLToPath(GOLDEN)));
    }
    let tick = 0, fixtureId = 0;
    const store = new ReceiptStore({ root: copy, policy: loadReviewPolicy(2), immutable: async () => {},
      clock: () => new Date(Date.parse('2026-09-14T12:00:00.000Z') + tick++),
      ...(root === null ? { randomUUID: () => `mixed-fixture-${++fixtureId}` } : {}),
    });
    if (root === null) {
      const prefix = await store.verifyChain();
      if (prefix.state !== 'intact' || prefix.tailHash !== V1_TAIL) throw new Error('Golden V1 chain failed');
      await appendFixture(store); goldenSnapshot(copy, { canonicalOnly: true }); goldenSnapshot(fileURLToPath(GOLDEN));
    }
    const chain = await store.verifyChain();
    if (chain.state !== 'intact') return { source, state: 'custody-broken' };
    const versions = [...new Set(chain.receipts.map(receipt => receipt.policySnapshotHash === reviewPolicyDigest(1) ? 1 : 2))];
    const v1Tail = chain.receipts.findLast(receipt => receipt.policySnapshotHash === reviewPolicyDigest(1))?.receiptHash ?? null;
    return { source, proof: 'receipt-chain', state: chain.state, policyVersions: versions, count: chain.count, v1Tail, tailHash: chain.tailHash };
  } catch {
    return { source, state: 'custody-broken' };
  } finally {
    // Only this concrete mkdtemp tree is made writable and removed.
    try { unsealTemporary(temporary); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--root' && path.isAbsolute(args[1]))) {
    process.stderr.write('Usage: node scripts/verify-receipt-chain.js [--root /absolute/project/review-receipts]\n'); process.exitCode = 2;
  } else {
    const result = await verifyReceiptChain({ root: args[1] ?? null });
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.state === 'intact' ? 0 : 1;
  }
}
