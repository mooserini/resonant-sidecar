import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import policy from '../policy/review-policy.v1.json' with { type: 'json' };
import { sha256Bytes } from '../review/canonical-json.js';
import { TRUSTED_BOOTSTRAP_FILES, inspectInitialBundle, materializeInitialBundle } from '../scripts/build-initial-bundle.js';

const COMMIT = 'c'.repeat(40);

function fakeRepository(files, { dirty = '', mutateHead = false, modes = {} } = {}) {
  const calls = [];
  let heads = 0;
  const oid = bytes => { const body = Buffer.from(bytes); return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex'); };
  return {
    calls,
    git: { async run({ args }) {
      calls.push(args);
      if (args[0] === 'rev-parse') return { stdout: Buffer.from(mutateHead && heads++ ? 'd'.repeat(40) + '\n' : COMMIT + '\n'), stderr: Buffer.alloc(0) };
      if (args[0] === 'status') return { stdout: Buffer.from(dirty), stderr: Buffer.alloc(0) };
      if (args[0] === 'ls-tree') {
        const names = args.slice(args.indexOf('--') + 1);
        return { stdout: Buffer.concat(names.filter(name => files[name] !== undefined).map(name => Buffer.from(`${modes[name] ?? '100644'} blob ${oid(files[name])}\t${name}\0`))), stderr: Buffer.alloc(0) };
      }
      if (args[0] === 'show') return { stdout: Buffer.from(files[args[1].slice(COMMIT.length + 1)]), stderr: Buffer.alloc(0) };
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    } },
  };
}

function repositoryFiles() {
  const files = {};
  for (const name of new Set([...policy.approvedBundlePaths, ...TRUSTED_BOOTSTRAP_FILES])) files[name] = `// ${name}\n`;
  files['extension/manifest.json'] = JSON.stringify({ manifest_version: 3, permissions: policy.approvedCapabilities.chromePermissions, host_permissions: [] });
  files['package.json'] = JSON.stringify({ type: 'module', engines: { node: '>=22' }, scripts: { test: 'node --test' } });
  files['policy/review-policy.v1.json'] = JSON.stringify(policy);
  files['policy/codex-attestation.v1.schema.json'] = '{}';
  return files;
}

test('inspects a clean committed complete bundle and closed trusted bootstrap graph without writes or remote Git', async () => {
  const fake = fakeRepository(repositoryFiles());
  const result = await inspectInitialBundle({ repoRoot: '/repo', policy, git: fake.git });
  assert.equal(result.sourceCommit, COMMIT);
  assert.deepEqual(result.bundle.manifest.files.map(file => file.path), [...policy.approvedBundlePaths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.deepEqual(result.trustedBootstrap.files.map(file => file.relativePath), [...TRUSTED_BOOTSTRAP_FILES].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.equal(result.declarationComparison.passed, true);
  assert.ok(result.declarationComparison.checks.some(check => check.name === 'v1-permissions' && check.passed));
  assert.equal(fake.calls.some(args => ['fetch', 'pull', 'clone', 'checkout'].includes(args[0])), false);
  assert.equal(fake.calls.every(args => args[0] !== 'show' || args[1].startsWith(`${COMMIT}:`)), true);
});

for (const [name, source, pattern] of [
  ['bare static import', "import value from 'ambient-package';\n", /ambient|import graph/i],
  ['bare export-from', "export { value } from 'ambient-package';\n", /ambient|import graph/i],
  ['bare dynamic import', "await import('ambient-package');\n", /ambient|import graph/i],
  ['comment-separated static import', "import/* gap */ value from 'ambient-package';\n", /ambient|import graph/i],
  ['comment-separated dynamic import', "await import /* gap */ ('ambient-package');\n", /ambient|import graph/i],
  ['non-literal dynamic import', "const target = './host.js'; await import(target);\n", /non-literal|import graph/i],
  ['unlisted relative dynamic import', "await import('./not-pinned.js');\n", /escapes|import graph/i],
]) test(`trusted closure rejects ${name}`, async () => {
  const files = repositoryFiles(); files['bootstrap/host.js'] = source;
  await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files).git }), pattern);
});

test('trusted closure allows only explicit node builtins and pinned literal relatives', async () => {
  const files = repositoryFiles();
  files['bootstrap/host.js'] = "import { readFile } from 'node:fs/promises';\nexport { default as proxy } from './native-proxy.js';\nawait import('../review/canonical-json.js');\nvoid readFile;\n";
  assert.equal((await inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files).git })).declarationComparison.passed, true);
});

test('refuses dirty source, changed HEAD, missing graph entries, symlink modes, and lifecycle hooks', async () => {
  const files = repositoryFiles();
  await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files, { dirty: ' M native-host/host.js\n' }).git }), /clean/i);
  await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files, { mutateHead: true }).git }), /changed/i);
  const missing = { ...files }; delete missing['bootstrap/host.js'];
  await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(missing).git }), /tree|source/i);
  await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files, { modes: { 'bootstrap/host.js': '120000' } }).git }), /regular|mode/i);
  const hooked = { ...files, 'package.json': JSON.stringify({ type: 'module', engines: { node: '>=22' }, scripts: { postinstall: 'node x.js' } }) };
  await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(hooked).git }), /lifecycle/i);
  const alteredPolicy = { ...files, 'policy/review-policy.v1.json': JSON.stringify({ ...policy, approvedBundlePaths: ['extension/manifest.json'] }) };
  await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(alteredPolicy).git }), /policy/i);
});

test('materializes exact inspected bytes only beneath an empty explicit staging root', async () => {
  const inspected = await inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(repositoryFiles()).git });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-initial-bundle-')));
  const result = await materializeInitialBundle({ inspection: inspected, destination: path.join(root, 'stage') });
  assert.equal(result.bundleDigest, inspected.bundle.manifest.bundleDigest);
  for (const file of inspected.bundle.files) assert.deepEqual(await readFile(path.join(result.bundleRoot, file.relativePath)), file.bytes);
  for (const file of inspected.trustedBootstrap.files) assert.deepEqual(await readFile(path.join(result.trustedBootstrapRoot, file.relativePath)), file.bytes);
  await assert.rejects(() => materializeInitialBundle({ inspection: inspected, destination: path.join(root, 'stage') }), /exists|empty/i);
  await assert.rejects(() => materializeInitialBundle({ inspection: inspected, destination: root }), /empty/i);
});
