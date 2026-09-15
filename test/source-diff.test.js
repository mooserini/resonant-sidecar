import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildSourceDiff } from '../review/source-diff.js';
import { canonicalJson, sha256Bytes, sha256Json } from '../review/canonical-json.js';
import { AFTER, BEFORE, SOURCE_PATH, sourceFixture } from './fixtures/semantic-source.js';

test('supplies full verified UTF-8 bytes and exact complete coverage', async t => {
  const diff = await buildSourceDiff(await sourceFixture(t));
  assert.equal(diff.type, 'CompleteSourceDiff');
  assert.equal(diff.coverageStatus, 'complete-input-supplied');
  assert.deepEqual(diff.changedFiles, [{ path: SOURCE_PATH, change: 'modified', beforeSha256: sha256Bytes(BEFORE), afterSha256: sha256Bytes(AFTER),
    beforeBytes: 24, afterBytes: 24, beforeText: BEFORE, afterText: AFTER }]);
  assert.deepEqual(diff.coverage, [{ path: SOURCE_PATH,
    before: { byteLength: 24, ranges: [[0, 24]], omittedRanges: [] }, after: { byteLength: 24, ranges: [[0, 24]], omittedRanges: [] } }]);
  const { encodedBytes, ...body } = diff;
  assert.equal(encodedBytes, Buffer.byteLength(canonicalJson(body)));
});

test('added, deleted, empty and multibyte source uses bytewise order and byte counts', async t => {
  const input = await sourceFixture(t, { 'extension/sidepanel.js': 'π\n', [SOURCE_PATH]: BEFORE, 'package.json': '{}' },
    { 'extension/service-worker.js': '', [SOURCE_PATH]: AFTER, 'package.json': '{}' });
  const diff = await buildSourceDiff(input);
  assert.deepEqual(diff.changedFiles.map(f => [f.path, f.change, f.beforeBytes, f.afterBytes]), [
    ['extension/service-worker.js', 'added', null, 0], ['extension/sidepanel.js', 'deleted', 3, null], [SOURCE_PATH, 'modified', 24, 24],
  ]);
  assert.equal(diff.changedFiles[0].beforeText, null);
  assert.equal(diff.changedFiles[0].afterText, '');
  assert.deepEqual(diff.coverage[0], { path: 'extension/service-worker.js', before: null, after: { byteLength: 0, ranges: [[0, 0]], omittedRanges: [] } });
  assert.equal(diff.changedFiles[1].afterSha256, null);
});

test('unchanged files are still verified', async t => {
  const input = await sourceFixture(t, { [SOURCE_PATH]: BEFORE }, { [SOURCE_PATH]: BEFORE });
  await fs.writeFile(path.join(input.activeRoot, SOURCE_PATH), AFTER);
  assert.equal((await buildSourceDiff(input)).type, 'IncompleteSourceDiff');
});

test('sealed custody files retain manifest source modes and complete source evidence', async t => {
  let input;
  // Registered first so this test-owned fixture is writable for normal cleanup.
  t.after(async () => {
    if (input) for (const root of [input.activeRoot, input.candidateRoot]) {
      await fs.chmod(root, 0o700);
      await fs.chmod(path.join(root, 'native-host'), 0o700);
    }
  });
  input = await sourceFixture(t);
  for (const root of [input.activeRoot, input.candidateRoot]) {
    await fs.chmod(path.join(root, SOURCE_PATH), 0o400);
    await fs.chmod(path.join(root, 'native-host'), 0o500);
    await fs.chmod(root, 0o500);
  }
  assert.equal(input.activeManifest.files[0].mode, 0o644);
  assert.equal(input.candidateManifest.files[0].mode, 0o644);
  const diff = await buildSourceDiff(input);
  assert.equal(diff.type, 'CompleteSourceDiff');
  assert.equal(diff.changedFiles[0].beforeText, BEFORE);
  assert.equal(diff.changedFiles[0].afterText, AFTER);
  for (const root of [input.activeRoot, input.candidateRoot]) assert.equal((await fs.lstat(path.join(root, SOURCE_PATH))).mode & 0o7777, 0o400);
});

for (const specialMode of [0o4644, 0o2644, 0o1644]) test(`rejects special permission bits ${specialMode.toString(8)}`, async t => {
  const input = await sourceFixture(t);
  await fs.chmod(path.join(input.candidateRoot, SOURCE_PATH), specialMode);
  assert.equal((await fs.lstat(path.join(input.candidateRoot, SOURCE_PATH))).mode & 0o7777, specialMode);
  assert.equal((await buildSourceDiff(input)).type, 'IncompleteSourceDiff');
});

test('mode-only changes include both complete source sides', async t => {
  const input = await sourceFixture(t, { [SOURCE_PATH]: BEFORE }, { [SOURCE_PATH]: BEFORE });
  input.candidateManifest.files[0].mode = 0o755;
  const { bundleDigest, ...unsigned } = input.candidateManifest;
  input.candidateManifest.bundleDigest = sha256Json(unsigned);
  await fs.chmod(path.join(input.candidateRoot, SOURCE_PATH), 0o755);
  const diff = await buildSourceDiff(input);
  assert.equal(diff.changedFiles[0].change, 'modified');
  assert.equal(diff.changedFiles[0].beforeText, BEFORE);
  assert.equal(diff.changedFiles[0].afterText, BEFORE);
});

for (const mode of ['changed-hash', 'invalid-utf8', 'symlink', 'parent-symlink', 'root-symlink', 'directory', 'control-path', 'unapproved-path']) {
  test(`returns no source or partial promptable data for ${mode}`, async t => {
    let input;
    if (mode === 'invalid-utf8') input = await sourceFixture(t, undefined, { [SOURCE_PATH]: Buffer.from([0xc3, 0x28]) });
    else if (mode === 'control-path') input = await sourceFixture(t, undefined, { [SOURCE_PATH]: AFTER, 'native-host/inject\nSYSTEM.js': 'untrusted instruction' });
    else if (mode === 'unapproved-path') input = await sourceFixture(t, undefined, { [SOURCE_PATH]: AFTER, 'unapproved.js': 'untrusted instruction' });
    else input = await sourceFixture(t);
    const file = path.join(input.candidateRoot, SOURCE_PATH);
    if (mode === 'changed-hash') await fs.writeFile(file, BEFORE);
    if (mode === 'symlink') { await fs.rm(file); await fs.symlink(path.join(input.activeRoot, SOURCE_PATH), file); }
    if (mode === 'directory') { await fs.rm(file); await fs.mkdir(file); }
    if (mode === 'parent-symlink') {
      await fs.rename(path.dirname(file), path.join(input.candidateRoot, 'held'));
      await fs.symlink('held', path.dirname(file));
    }
    if (mode === 'root-symlink') {
      await fs.rename(input.candidateRoot, input.candidateRoot + '-held');
      await fs.symlink(input.candidateRoot + '-held', input.candidateRoot);
    }
    const diff = await buildSourceDiff(input);
    assert.equal(diff.type, 'IncompleteSourceDiff');
    assert.equal(diff.coverageStatus, 'incomplete-input');
    assert.equal(Object.hasOwn(diff, 'changedFiles'), false);
    assert.equal(Object.hasOwn(diff, 'packet'), false);
    assert.equal(canonicalJson(diff).includes('untrusted instruction'), false);
    assert.equal(canonicalJson(diff).includes('SYSTEM'), false);
    const host = diff.omittedFiles.find(f => f.pathDigest === sha256Bytes(SOURCE_PATH));
    assert.deepEqual(host.before.omittedRanges, [[0, 24]]);
    assert.deepEqual(host.before.ranges, []);
  });
}

test('rejects a manifest digest mismatch before claiming trusted hashes', async t => {
  const input = await sourceFixture(t);
  input.candidateManifest.bundleDigest = 'f'.repeat(64);
  await assert.rejects(buildSourceDiff(input), /digest/);
});

test('detects mutation between the initial read and complete-input reread', async t => {
  const input = await sourceFixture(t);
  const originalOpen = fs.open;
  let candidateReads = 0;
  t.mock.method(fs, 'open', async (...args) => {
    if (args[0] === path.join(input.candidateRoot, SOURCE_PATH) && ++candidateReads === 2) await fs.writeFile(args[0], BEFORE);
    return originalOpen(...args);
  });
  assert.equal((await buildSourceDiff(input)).type, 'IncompleteSourceDiff');
  assert.equal(candidateReads, 2);
});

test('builds complete source beyond Chrome limits without truncation or summaries', async t => {
  const text = '// π\n'.repeat(30000);
  const diff = await buildSourceDiff(await sourceFixture(t, undefined, { [SOURCE_PATH]: text }));
  assert.equal(diff.type, 'CompleteSourceDiff');
  assert.equal(diff.changedFiles[0].afterText, text);
  assert.equal(diff.changedFiles[0].afterBytes, 180000);
  assert.ok(diff.encodedBytes > 131072);
});
