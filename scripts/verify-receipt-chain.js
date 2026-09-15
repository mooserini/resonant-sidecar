import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReceiptStore } from '../review/receipt-store.js';
import { loadReviewPolicy, reviewPolicyDigest } from '../review/policy-registry.js';
import { sha256Bytes } from '../review/canonical-json.js';
import { chromeReceipt } from '../test/fixtures/chrome-receipt.js';

const GOLDEN = new URL('../test/fixtures/receipts/v1/review-receipts/', import.meta.url);
const V1_TAIL = 'c2a28877cf698c504739dd2f3089c14b0f128c66bc8dcbc1791e292fa650aeb5';

async function walkDirectories(root, operation) {
  await operation(root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await walkDirectories(path.join(root, entry.name), operation);
  }
}
async function sealGolden(root) {
  await mkdir(path.join(root, '.pending'), { recursive: true, mode: 0o700 });
  for (const name of await readdir(root)) if (name.startsWith('2026-')) {
    await walkDirectories(path.join(root, name), async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isFile()) await chmod(path.join(directory, entry.name), 0o444);
      await chmod(directory, 0o555);
    });
  }
}
async function assertCopyable(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name), metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error('Linked receipt storage');
    if (metadata.isDirectory()) await assertCopyable(target);
    else if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 4 * 1024 * 1024) throw new Error('Nonregular receipt storage');
  }
}
async function goldenHashes(root, canonicalOnly = false) {
  const text = await readFile(new URL('../test/fixtures/receipts/v1/README.md', import.meta.url), 'utf8');
  const expected = [...text.matchAll(/^([a-f0-9]{64})  review-receipts\/(.+)$/gm)];
  if (expected.length !== 28) throw new Error('Golden receipt inventory mismatch');
  for (const [, hash, name] of expected) {
    if (canonicalOnly && !name.startsWith('2026-')) continue;
    if (sha256Bytes(await readFile(path.join(root, name))) !== hash) throw new Error('Golden receipt byte mismatch');
  }
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
      await assertCopyable(root);
      await cp(root, copy, { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
      await assertCopyable(root);
    } else {
      await goldenHashes(fileURLToPath(GOLDEN));
      await cp(GOLDEN, copy, { recursive: true }); await sealGolden(copy);
    }
    let tick = 0;
    const store = new ReceiptStore({ root: copy, policy: loadReviewPolicy(2), immutable: async () => {}, clock: () => new Date(Date.parse('2026-09-14T12:00:00.000Z') + tick++) });
    if (root === null) {
      const prefix = await store.verifyChain();
      if (prefix.state !== 'intact' || prefix.tailHash !== V1_TAIL) throw new Error('Golden V1 chain failed');
      await appendFixture(store); await goldenHashes(copy, true); await goldenHashes(fileURLToPath(GOLDEN));
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
    await walkDirectories(temporary, directory => chmod(directory, 0o700));
    await rm(temporary, { recursive: true, force: true });
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
