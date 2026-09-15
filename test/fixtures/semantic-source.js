import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256Bytes, sha256Json } from '../../review/canonical-json.js';

export const BEFORE = 'export const value = 1;\n';
export const AFTER = 'export const value = 2;\n';
export const SOURCE_PATH = 'native-host/host.js';

export function manifestFor(files) {
  const unsigned = {
    schemaVersion: 1, sourceCommit: 'a'.repeat(40),
    files: Object.entries(files).map(([name, text]) => ({ path: name, sha256: sha256Bytes(text), bytes: Buffer.byteLength(text), mode: 0o644 }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
    capabilities: { chromePermissions: [], hostPermissions: [], lifecycleScripts: [], listeners: [] },
    dependencies: { lockfiles: [], packageManager: null, runtime: [] },
  };
  return { ...unsigned, bundleDigest: sha256Json(unsigned) };
}

export async function sourceFixture(t, before = { [SOURCE_PATH]: BEFORE }, after = { [SOURCE_PATH]: AFTER }) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'semantic-source-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [side, files] of [['active', before], ['candidate', after]]) {
    await mkdir(path.join(root, side));
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, side, name)), { recursive: true });
      await writeFile(path.join(root, side, name), text, { mode: 0o644 });
    }
  }
  return { activeRoot: path.join(root, 'active'), candidateRoot: path.join(root, 'candidate'),
    activeManifest: manifestFor(before), candidateManifest: manifestFor(after) };
}
