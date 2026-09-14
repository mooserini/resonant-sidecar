import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';

import { assertBundleManifest, buildBundleManifest } from '../review/bundle-manifest.js';

const root = path.resolve('test/fixtures/bundles/minimal-pass');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const FILES = [
  'extension/manifest.json',
  'native-host/host.js',
  'package.json',
];

test('builds a complete manifest from regular files in normalized bytewise order', async () => {
  const manifest = await buildBundleManifest({
    root,
    files: ['package.json', 'native-host/host.js', 'extension/manifest.json'],
    sourceCommit: COMMIT,
    schemaVersion: 1,
  });

  assert.deepEqual(manifest.files, [
    {
      path: 'extension/manifest.json',
      bytes: 138,
      sha256: '715354dab0869d53f68d77df28a4a155d48b7cac025171b760daf4ae59327c3a',
      mode: 0o644,
    },
    {
      path: 'native-host/host.js',
      bytes: 34,
      sha256: '78e23c74515a47290d203c5dc9cd4fc6ba7012f8e98f3e7aaee75b507a1c04cc',
      mode: 0o644,
    },
    {
      path: 'package.json',
      bytes: 104,
      sha256: '53a11e24d63e460a1babb85e3335eb998d61fcb56162acf7a8b92233a2f0d1b7',
      mode: 0o644,
    },
  ]);
  assert.deepEqual(manifest.capabilities, {
    chromePermissions: ['nativeMessaging', 'sidePanel', 'storage'],
    hostPermissions: [],
    lifecycleScripts: [],
    listeners: [],
  });
  assert.deepEqual(manifest.dependencies, {
    lockfiles: [],
    packageManager: 'npm@10.8.2',
    runtime: [],
  });
  assert.equal(manifest.bundleDigest, 'c9a80fc40919a46ebe8c4d21ce214808bba11cd046d85efb63d7ad50db049b9d');
});

test('bundle digest is independent of traversal order and rejects symlinks', async t => {
  const first = await buildBundleManifest({ root, files: FILES, sourceCommit: COMMIT, schemaVersion: 1 });
  const second = await buildBundleManifest({
    root,
    files: [...FILES].reverse(),
    sourceCommit: COMMIT,
    schemaVersion: 1,
  });
  assert.equal(first.bundleDigest, second.bundleDigest);

  const escape = path.join(root, 'extension', 'escape');
  await rm(escape, { force: true });
  await symlink('/tmp/outside', escape);
  t.after(async () => {
    await rm(escape, { force: true });
  });

  assert.equal((await lstat(escape)).isSymbolicLink(), true);
  await assert.rejects(
    () => buildBundleManifest({
      root,
      files: [...FILES, 'extension/escape'],
      sourceCommit: COMMIT,
      schemaVersion: 1,
    }),
    /symbolic link/i,
  );
});

test('rejects a symlinked manifest read for declared capabilities', async t => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'resonant-sidecar-bundle-'));
  t.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await cp(root, temporaryRoot, { recursive: true });
  const manifest = path.join(temporaryRoot, 'extension', 'manifest.json');
  await rename(manifest, path.join(temporaryRoot, 'extension', 'manifest-real.json'));
  await symlink('manifest-real.json', manifest);

  await assert.rejects(
    () => buildBundleManifest({
      root: temporaryRoot,
      files: ['package.json', 'native-host/host.js'],
      sourceCommit: COMMIT,
      schemaVersion: 1,
    }),
    /symbolic link/i,
  );
});

test('rejects each optional Chrome permission declaration', async t => {
  for (const optionalDeclaration of [
    { optional_permissions: ['tabs'] },
    { optional_host_permissions: ['<all_urls>'] },
  ]) {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'resonant-sidecar-bundle-'));
    t.after(async () => {
      await rm(temporaryRoot, { recursive: true, force: true });
    });
    await cp(root, temporaryRoot, { recursive: true });
    await writeFile(path.join(temporaryRoot, 'extension', 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Minimal Pass',
      version: '1.0.0',
      permissions: ['nativeMessaging', 'sidePanel', 'storage'],
      ...optionalDeclaration,
    }));

    await assert.rejects(
      () => buildBundleManifest({
        root: temporaryRoot,
        files: FILES,
        sourceCommit: COMMIT,
        schemaVersion: 1,
      }),
      /optional.*permission/i,
    );
  }
});

test('records every npm lifecycle hook including preprepare and postprepare', async t => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'resonant-sidecar-bundle-'));
  t.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await cp(root, temporaryRoot, { recursive: true });
  await writeFile(path.join(temporaryRoot, 'package.json'), JSON.stringify({
    name: 'minimal-pass',
    version: '1.0.0',
    private: true,
    packageManager: 'npm@10.8.2',
    scripts: {
      preprepare: 'echo before',
      postprepare: 'echo after',
    },
  }));

  const manifest = await buildBundleManifest({
    root: temporaryRoot,
    files: FILES,
    sourceCommit: COMMIT,
    schemaVersion: 1,
  });
  assert.deepEqual(manifest.capabilities.lifecycleScripts, ['postprepare', 'preprepare']);
});

test('records publish and postpublish lifecycle hooks', async t => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'resonant-sidecar-bundle-'));
  t.after(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await cp(root, temporaryRoot, { recursive: true });
  await writeFile(path.join(temporaryRoot, 'package.json'), JSON.stringify({
    name: 'minimal-pass',
    version: '1.0.0',
    private: true,
    packageManager: 'npm@10.8.2',
    scripts: {
      publish: 'echo publish',
      postpublish: 'echo after',
    },
  }));

  const manifest = await buildBundleManifest({
    root: temporaryRoot,
    files: FILES,
    sourceCommit: COMMIT,
    schemaVersion: 1,
  });
  assert.deepEqual(manifest.capabilities.lifecycleScripts, ['postpublish', 'publish']);
});

test('rejects traversal, duplicate paths, and manifest tampering', async () => {
  await assert.rejects(
    () => buildBundleManifest({ root, files: ['../package.json'], sourceCommit: COMMIT, schemaVersion: 1 }),
    /relative path/i,
  );
  await assert.rejects(
    () => buildBundleManifest({ root, files: ['package.json', 'package.json'], sourceCommit: COMMIT, schemaVersion: 1 }),
    /duplicate/i,
  );

  const manifest = await buildBundleManifest({ root, files: FILES, sourceCommit: COMMIT, schemaVersion: 1 });
  assert.equal(assertBundleManifest(manifest).bundleDigest, manifest.bundleDigest);
  assert.throws(
    () => assertBundleManifest({ ...manifest, bundleDigest: '0'.repeat(64) }),
    /bundle digest/i,
  );
});
