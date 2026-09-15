import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertBundleManifest } from './bundle-manifest.js';
import { canonicalJson, sha256Bytes } from './canonical-json.js';
import { loadReviewPolicy } from './policy-registry.js';

const APPROVED_TEXT = new Set(loadReviewPolicy(2).approvedBundlePaths);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function changedManifestFiles(activeManifest, candidateManifest) {
  const before = new Map(activeManifest.files.map(file => [file.path, file]));
  const after = new Map(candidateManifest.files.map(file => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].sort(compare).flatMap(name => {
    const left = before.get(name) ?? null;
    const right = after.get(name) ?? null;
    if (left && right && left.sha256 === right.sha256 && left.bytes === right.bytes && left.mode === right.mode) return [];
    return [{ path: name, change: left === null ? 'added' : right === null ? 'deleted' : 'modified', before: left, after: right }];
  });
}

export function omittedSourceFiles(activeManifest, candidateManifest) {
  const side = file => file === null ? null : { sha256: file.sha256, byteLength: file.bytes, ranges: [], omittedRanges: [[0, file.bytes]] };
  return changedManifestFiles(activeManifest, candidateManifest).map(file => ({ pathDigest: sha256Bytes(file.path), before: side(file.before), after: side(file.after) }));
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function pathChain(root, name) {
  const entries = [root];
  for (const segment of name.split('/')) entries.push(path.join(entries.at(-1), segment));
  const chain = [];
  for (let i = 0; i < entries.length; i++) {
    const stat = await fs.lstat(entries[i], { bigint: true });
    if (stat.isSymbolicLink() || (i === entries.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new TypeError('Incomplete source input');
    chain.push(stat);
  }
  return chain;
}

async function verifiedRead(root, file) {
  // Policy membership also rejects control characters, traversal and unknown
  // file types. Never echo a candidate path in a terminal failure description.
  if (!APPROVED_TEXT.has(file.path)) throw new TypeError('Incomplete source input');
  const before = await pathChain(root, file.path);
  const handle = await fs.open(path.join(root, file.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || !sameIdentity(before.at(-1), held) || Number(held.mode & 0o777n) !== file.mode || held.size !== BigInt(file.bytes)) throw new TypeError('Incomplete source input');
    // The manifest fixes the read size, so a growing/replaced file cannot turn
    // a verified source read into an unbounded stream or silently truncated file.
    const bytes = Buffer.alloc(file.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new TypeError('Incomplete source input');
      offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await pathChain(root, file.path);
    if (extra.bytesRead !== 0 || !sameIdentity(held, await handle.stat({ bigint: true })) || before.some((stat, i) => !sameIdentity(stat, after[i])) || sha256Bytes(bytes) !== file.sha256) throw new TypeError('Incomplete source input');
    return { text: UTF8.decode(bytes), identity: held };
  } finally {
    await handle.close();
  }
}

/** Read every manifest-listed file twice, including unchanged files. Hash and
 * identity checks bind each complete UTF-8 snapshot; custody after return is
 * the coordinator's responsibility. No candidate-authored summary is accepted.
 */
export async function buildSourceDiff({ activeRoot, candidateRoot, activeManifest, candidateManifest }) {
  const active = assertBundleManifest(JSON.parse(canonicalJson(activeManifest)));
  const candidate = assertBundleManifest(JSON.parse(canonicalJson(candidateManifest)));
  const identity = { activeBundleDigest: active.bundleDigest, candidateBundleDigest: candidate.bundleDigest };
  try {
    const sources = [];
    for (const [root, manifest] of [[activeRoot, active], [candidateRoot, candidate]]) {
      const files = new Map();
      for (const file of manifest.files) files.set(file.path, await verifiedRead(root, file));
      sources.push(files);
    }
    for (const [index, [root, manifest]] of [[activeRoot, active], [candidateRoot, candidate]].entries()) {
      for (const file of manifest.files) {
        const reread = await verifiedRead(root, file);
        const first = sources[index].get(file.path);
        if (!sameIdentity(first.identity, reread.identity) || first.text !== reread.text) throw new TypeError('Incomplete source input');
      }
    }
    const changedFiles = changedManifestFiles(active, candidate).map(file => ({
      path: file.path, change: file.change,
      beforeSha256: file.before?.sha256 ?? null, afterSha256: file.after?.sha256 ?? null,
      beforeBytes: file.before?.bytes ?? null, afterBytes: file.after?.bytes ?? null,
      beforeText: file.before ? sources[0].get(file.path).text : null,
      afterText: file.after ? sources[1].get(file.path).text : null,
    }));
    const side = bytes => bytes === null ? null : { byteLength: bytes, ranges: [[0, bytes]], omittedRanges: [] };
    const coverage = changedFiles.map(file => ({ path: file.path, before: side(file.beforeBytes), after: side(file.afterBytes) }));
    const body = { type: 'CompleteSourceDiff', coverageStatus: 'complete-input-supplied', ...identity, changedFiles, coverage };
    // Size excludes the size field itself; Chrome later caps the complete packet.
    return { ...body, encodedBytes: Buffer.byteLength(canonicalJson(body)) };
  } catch {
    return { type: 'IncompleteSourceDiff', coverageStatus: 'incomplete-input', ...identity, omittedFiles: omittedSourceFiles(active, candidate) };
  }
}
