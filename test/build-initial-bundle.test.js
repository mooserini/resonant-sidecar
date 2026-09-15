import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import policy from '../policy/review-policy.v2.json' with { type: 'json' };
import { sha256Bytes } from '../review/canonical-json.js';
import { TRUSTED_BOOTSTRAP_FILES, inspectInitialBundle, materializeInitialBundle } from '../scripts/build-initial-bundle.js';
import { loadReviewPolicy } from '../review/policy-registry.js';

test('V2 inspector closes the exact frozen 38-file bootstrap and eight-file extension graph', async () => {
  const v2 = loadReviewPolicy(2);
  const stable = v2.trustedControlPaths.filter(file => file.startsWith('extension/'));
  const bootstrap = v2.trustedControlPaths.filter(file => !file.startsWith('extension/') && !file.startsWith('scripts/'));
  assert.equal(bootstrap.length, 38);
  assert.deepEqual(TRUSTED_BOOTSTRAP_FILES, bootstrap);
  const files = Object.fromEntries(await Promise.all([...new Set([...v2.trustedControlPaths, ...v2.approvedBundlePaths])].map(async file => [file, await readFile(new URL(`../${file}`, import.meta.url))])));
  const result = await inspectInitialBundle({ repoRoot: '/repo', policy: v2, git: fakeRepository(files).git });
  assert.equal(result.bundle.manifest.schemaVersion, 1);
  assert.deepEqual(result.stableExtension.files.map(file => file.relativePath), stable);
  assert.deepEqual(result.controlPlane.files.map(file => file.path), v2.trustedControlPaths);
  assert.equal(result.controlPlane.contractDigest, sha256Bytes(files['review/chrome-review-contract.js']));
});

test('V2 inspector refuses split Chrome contracts and escaping stable imports', async () => {
  const v2 = loadReviewPolicy(2);
  const files = Object.fromEntries(await Promise.all([...new Set([...v2.trustedControlPaths, ...v2.approvedBundlePaths])].map(async file => [file, await readFile(new URL(`../${file}`, import.meta.url))])));
  for (const [file, suffix, pattern] of [
    ['extension/chrome-review-contract.js', '\n// split contract\n', /contract/i],
    ['extension/chrome-review-adapter.js', "\nimport '../native-host/host.js';\n", /import graph/i],
  ]) await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy: v2, git: fakeRepository({ ...files, [file]: Buffer.concat([files[file], Buffer.from(suffix)]) }).git }), pattern);
});

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
  for (const name of new Set([...policy.approvedBundlePaths, ...policy.trustedControlPaths])) files[name] = `// ${name}\n`;
  files['extension/manifest.json'] = JSON.stringify({ manifest_version: 3, permissions: policy.approvedCapabilities.chromePermissions, host_permissions: [] });
  files['package.json'] = JSON.stringify({ type: 'module', engines: { node: '>=22' }, scripts: { test: 'node --test' } });
  files['policy/review-policy.v1.json'] = JSON.stringify(loadReviewPolicy(1));
  files['policy/review-policy.v2.json'] = JSON.stringify(policy);
  files['policy/chrome-language-model.v2.schema.json'] = '{}';
  files['extension/chrome-review-contract.js'] = files['review/chrome-review-contract.js'];
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
  ['fake node builtin', "import value from 'node:definitely-not-a-real-builtin';\n", /builtin|ambient|import graph/i],
  ['comment-separated static import', "import/* gap */ value from 'ambient-package';\n", /ambient|import graph/i],
  ['comment-separated dynamic import', "await import /* gap */ ('ambient-package');\n", /ambient|import graph/i],
  ['template-composed relative dynamic import', "await import(`${'./native-proxy.js'}`);\n", /non-literal|import graph/i],
  ['template-composed node dynamic import', "await import(`${'node:fs'}`);\n", /non-literal|import graph/i],
  ['dynamic import inside a template interpolation', "const load = `${await import('ambient-package')}`;\n", /ambient|import graph/i],
  ['non-literal dynamic import', "const target = './host.js'; await import(target);\n", /non-literal|import graph/i],
  ['unlisted relative dynamic import', "await import('./not-pinned.js');\n", /escapes|import graph/i],
  ['direct eval import', "eval(\"import('ambient-eval-package')\");\n", /code generation|runtime loader|ambient/i],
  ['indirect eval import', "(0, eval)(\"import('ambient-eval-package')\");\n", /code generation|runtime loader|ambient/i],
  ['member eval import', "globalThis.eval(\"import('ambient-eval-package')\");\n", /code generation|runtime loader|ambient/i],
  ['Function constructor import', "new Function(\"return import('ambient-function-package')\");\n", /code generation|runtime loader|ambient/i],
  ['Function-family constructor import', "new AsyncFunction(\"return import('ambient-function-package')\");\n", /code generation|runtime loader|ambient/i],
  ['member Function import', "new globalThis.Function(\"return import('ambient-function-package')\");\n", /code generation|runtime loader|ambient/i],
  ['constructor-property import', "(async () => {}).constructor(\"return import('ambient-constructor-package')\");\n", /code generation|runtime loader|ambient/i],
  ['constructor-bracket import', "(function () {})['constructor'](\"return import('ambient-constructor-package')\")();\n", /code generation|runtime loader|ambient/i],
  ['CommonJS require', "require('ambient-require-package');\n", /runtime loader|ambient/i],
  ['createRequire loader', "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('ambient-require-package');\n", /runtime loader|ambient/i],
  ['process builtin loader', "process.getBuiltinModule('module').createRequire(import.meta.url)('ambient-require-package');\n", /runtime loader|ambient/i],
]) test(`trusted closure rejects ${name}`, async () => {
  const files = repositoryFiles(); files['bootstrap/host.js'] = source;
  await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files).git }), pattern);
});

for (const [name, source] of [
  ['escaped eval identifier', String.raw`\u0065val("import('ambient')")`],
  ['escaped constructor identifier', String.raw`(async()=>{}).constr\u0075ctor("return import('ambient')")()`],
  ['computed createRequire property', `m['create' + 'Require'](import.meta.url)('ambient')`],
  ['escaped computed loader property', String.raw`m['create' + 'Requ\u0069re'](import.meta.url)('ambient')`],
  ['computed builtin loader chain', `process['getBuiltin' + 'Module']('module')['create' + 'Require'](import.meta.url)('ambient')`],
]) {
  test(`trusted closure rejects ${name}`, async () => {
    const files = repositoryFiles(); files['bootstrap/host.js'] = source;
    await assert.rejects(() => inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files).git }), /loader|generation|syntax/i);
  });
}

test('trusted closure allows only explicit node builtins and pinned literal relatives', async () => {
  const files = repositoryFiles();
  files['bootstrap/host.js'] = "import { readFile } from 'node:fs/promises';\nexport { default as proxy } from './native-proxy.js';\nawait import('../review/canonical-json.js');\nawait import('node:test');\nvoid readFile;\n";
  assert.equal((await inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files).git })).declarationComparison.passed, true);
});

test('trusted closure ignores import-shaped text in comments and string literals', async () => {
  const files = repositoryFiles();
  files['bootstrap/host.js'] = [
    "// import('ambient-comment-package')",
    "const message = \"Unapproved candidate import'); then await load('ambient-string-package\";",
    "const pattern = /import\\('ambient-regex-package'\\)/;",
    "const template = `import('ambient-template-text')`;",
    "const interpolation = `safe:${'value'}`;",
    "import { readFile } from 'node:fs/promises';",
    "export function encode(value) { return Buffer.from(value, 'utf8'); }",
    'void message; void pattern; void template; void interpolation; void readFile; void encode;',
    '',
  ].join('\n');
  assert.equal((await inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files).git })).declarationComparison.passed, true);
});

test('trusted closure recognizes regex literals after control-flow conditions', async () => {
  const files = repositoryFiles();
  files['bootstrap/host.js'] = [
    "if (true) /import\\('ambient-if-regex'\\)/.test('safe');",
    "while (false) /import\\('ambient-while-regex'\\)/.test('safe');",
    "for (; false;) /import\\('ambient-for-regex'\\)/.test('safe');",
    "import { readFile } from 'node:fs/promises';",
    "import test from 'node:test';",
    'void readFile; void test;',
    '',
  ].join('\n');
  assert.equal((await inspectInitialBundle({ repoRoot: '/repo', policy, git: fakeRepository(files).git })).declarationComparison.passed, true);
});

test('trusted closure ignores safe import-shaped regex text inside template interpolation', async () => {
  const files = repositoryFiles();
  files['bootstrap/host.js'] = [
    "const safe = `${/import\\('ambient-regex-package'\\)/.test('safe')}`;",
    "const nested = `outer:${true ? /eval\\(.*import/.test('safe') : false}`;",
    "import { readFile } from 'node:fs/promises';",
    'void safe; void nested; void readFile;',
    '',
  ].join('\n');
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
