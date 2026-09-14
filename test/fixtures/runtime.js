import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBundleManifest } from '../../review/bundle-manifest.js';
import { canonicalJson } from '../../review/canonical-json.js';

export async function runtimeFixture(t) {
  const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-runtime-')));
  t.after(async () => {
    // Test-owned disposable trees only. Restore directory write permissions.
    const { readdir } = await import('node:fs/promises');
    async function writable(dir) {
      await chmod(dir, 0o700);
      for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await writable(path.join(dir, e.name));
    }
    await writable(projectRoot);
    await rm(projectRoot, { recursive: true, force: true });
  });
  const root = path.join(projectRoot, 'runtime');
  await mkdir(root, { mode: 0o700 });
  async function stage(reviewId, host = 'process.stdin.resume();') {
    const bundleRoot = path.join(root, 'quarantine', reviewId, 'bundle');
    await mkdir(path.join(bundleRoot, 'native-host'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(bundleRoot, 'extension'), { mode: 0o700 });
    const content = { 'package.json': '{"type":"module"}', 'extension/manifest.json': '{"permissions":["nativeMessaging","sidePanel","storage"]}', 'native-host/host.js': host };
    for (const [file, bytes] of Object.entries(content)) {
      await writeFile(path.join(bundleRoot, file), bytes, { mode: 0o644 });
      await chmod(path.join(bundleRoot, file), 0o644);
    }
    const manifest = await buildBundleManifest({ root: bundleRoot, files: Object.keys(content), sourceCommit: 'a'.repeat(40), schemaVersion: 1 });
    const manifestPath = path.join(path.dirname(bundleRoot), 'staging-manifest.json');
    await writeFile(manifestPath, canonicalJson(manifest) + '\n', { mode: 0o400 });
    for (const file of Object.keys(content)) await chmod(path.join(bundleRoot, file), 0o400);
    for (const dir of ['native-host', 'extension', '']) await chmod(path.join(bundleRoot, dir), 0o500);
    return { bundleRoot, manifestPath, manifest };
  }
  return { projectRoot, root, stage };
}

export const decisionFor = (staged, nonce = 'n'.repeat(32)) => ({ action: 'accept', reviewId: path.basename(path.dirname(staged.bundleRoot)), candidateDigest: staged.manifest.bundleDigest, policyDigest: 'b'.repeat(64), nonce });
export function consumer() {
  const used = new Set();
  return async decision => {
    if (used.has(decision.nonce)) throw new Error('nonce already consumed');
    used.add(decision.nonce);
    return { ...decision, consumed: true };
  };
}
