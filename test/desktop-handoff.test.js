import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, chmod, mkdir, readdir, rm, writeFile, realpath } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { ReceiptStore } from '../review/receipt-store.js';
import { createDesktopHandoff, openReviewReport, openChromeDeveloperProject } from '../presentation/desktop-handoff.js';

const marker = 'UNTRUSTED_DIAGNOSTIC';
const failed = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === code && !String(error).includes(marker));
function processDouble(effect = () => {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    calls.push({ command, args, options });
    queueMicrotask(() => { effect(child, calls.at(-1)); child.emit('close', 0, null); });
    return child;
  };
  return { calls, spawn };
}
async function fixture(t) {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), 'sidecar-presentation-')));
  const root = path.join(project, 'review-receipts');
  const store = new ReceiptStore({ root, immutable: async () => {}, clock: () => new Date('2026-09-14T00:00:00Z'), randomUUID: () => 'receipt-9' });
  const receipt = await store.finalizeEvent({ reviewId: 'review-9', eventType: 'review-failed', outcome: 'review-failed', verifierIdentities: [{ name: 'trusted', version: '1' }], activeBundleDigest: 'a'.repeat(64), candidateBundleDigest: 'b'.repeat(64), projectEvidence: { activeVersion: {}, candidateVersion: {}, sourceHashes: {}, dependencyLock: {}, testResults: {} }, osEvidence: { before: {}, verification: {}, after: {} } });
  const report = path.join(receipt.directory, 'report.md');
  const codexPath = path.join(project, 'codex'); await writeFile(codexPath, 'trusted executable fixture', { mode: 0o700 });
  t.after(async () => {
    async function unlock(dir) { await chmod(dir, 0o700); for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await unlock(path.join(dir, entry.name)); }
    await unlock(project); await rm(project, { recursive: true });
  });
  return { project, root, store, receipt, report, codexPath };
}

test('default handoff APIs exist without opening apps during import', () => { assert.equal(typeof openReviewReport, 'function'); assert.equal(typeof openChromeDeveloperProject, 'function'); });

test('opens only the report belonging to a fully verified finalized receipt', async t => {
  const f = await fixture(t); const fake = processDouble();
  const api = createDesktopHandoff({ receiptRoot: f.root, codexPath: f.codexPath, spawn: fake.spawn });
  assert.deepEqual(await api.openReviewReport(f.report), { status: 'opened' });
  assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].command, '/usr/bin/open');
  assert.deepEqual(fake.calls[0].args, [f.report]);
  assert.deepEqual(fake.calls[0].options, { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
});

for (const target of ['outside', 'prefix', 'traversal', 'wrong-basename', 'pending', 'comparison', 'boxed', 'null', 'option']) {
  test(`rejects ${target} report selection before launch`, async t => {
    const f = await fixture(t); const fake = processDouble();
    const paths = { outside: path.join(f.project, 'report.md'), prefix: `${f.root}-other/report.md`, traversal: `${f.receipt.directory}/../${path.basename(f.receipt.directory)}/report.md`, 'wrong-basename': path.join(f.receipt.directory, 'receipt.json'), pending: path.join(f.root, '.pending', 'receipt-9', 'report.md'), comparison: path.join(f.root, 'runtime-comparisons', 'report.md'), boxed: new String(f.report), null: null, option: '-a Calculator' };
    await failed(createDesktopHandoff({ receiptRoot: f.root, spawn: fake.spawn }).openReviewReport(paths[target]), 'report-unavailable');
    assert.equal(fake.calls.length, 0);
  });
}

for (const alteration of ['report-symlink', 'directory-symlink', 'root-symlink', 'ancestor-symlink', 'report-directory', 'hardlink', 'writable', 'tampered-report', 'tampered-evidence', 'missing-witness']) {
  test(`rejects ${alteration} through real custody checks`, async t => {
    const f = await fixture(t); const fake = processDouble(); let root = f.root; let report = f.report;
    if (alteration === 'report-symlink') { fs.chmodSync(f.receipt.directory, 0o700); fs.renameSync(f.report, `${f.report}.original`); fs.symlinkSync(`${f.report}.original`, f.report); fs.chmodSync(f.receipt.directory, 0o555); }
    if (alteration === 'directory-symlink') { fs.renameSync(f.receipt.directory, `${f.receipt.directory}-held`); fs.symlinkSync(`${f.receipt.directory}-held`, f.receipt.directory); }
    if (alteration === 'root-symlink') { fs.renameSync(f.root, `${f.root}-held`); fs.symlinkSync(`${f.root}-held`, f.root); }
    if (alteration === 'ancestor-symlink') { const alias = path.join(f.project, 'alias'); fs.symlinkSync(f.project, alias); root = path.join(alias, 'review-receipts'); report = path.join(root, path.basename(f.receipt.directory), 'report.md'); }
    if (alteration === 'report-directory') { fs.chmodSync(f.receipt.directory, 0o700); fs.unlinkSync(f.report); fs.mkdirSync(f.report); fs.chmodSync(f.receipt.directory, 0o555); }
    if (alteration === 'hardlink') fs.linkSync(f.report, path.join(f.project, 'linked'));
    if (alteration === 'writable') fs.chmodSync(f.report, 0o644);
    if (alteration === 'tampered-report' || alteration === 'tampered-evidence') { const file = alteration === 'tampered-report' ? f.report : path.join(f.receipt.directory, 'project', 'test-results.json'); fs.chmodSync(file, 0o600); fs.writeFileSync(file, marker); fs.chmodSync(file, 0o444); }
    if (alteration === 'missing-witness') fs.unlinkSync(path.join(f.root, '.custody-head'));
    await failed(createDesktopHandoff({ receiptRoot: root, spawn: fake.spawn }).openReviewReport(report), 'report-unavailable');
    assert.equal(fake.calls.length, 0);
  });
}

test('caller assertion cannot replace ReceiptStore verification', async t => {
  const f = await fixture(t); const fake = processDouble();
  fs.chmodSync(f.report, 0o600); fs.writeFileSync(f.report, marker); fs.chmodSync(f.report, 0o444);
  const api = createDesktopHandoff({ receiptRoot: f.root, spawn: fake.spawn, receiptStore: { verifyChain: async () => ({ state: 'intact', receipts: [f.receipt] }) } });
  await failed(api.openReviewReport(f.report), 'report-unavailable'); assert.equal(fake.calls.length, 0);
});

test('observable replacement during open cannot be reported as successful', async t => {
  const f = await fixture(t);
  const fake = processDouble(() => { fs.chmodSync(f.receipt.directory, 0o700); fs.renameSync(f.report, `${f.report}.held`); fs.writeFileSync(f.report, marker, { mode: 0o444 }); fs.chmodSync(f.receipt.directory, 0o555); });
  await failed(createDesktopHandoff({ receiptRoot: f.root, spawn: fake.spawn }).openReviewReport(f.report), 'report-unavailable');
  assert.equal(fake.calls.length, 1);
});

for (const alteration of ['report-bytes', 'report-inode', 'root-inode', 'report-mode']) {
  test(`detects ${alteration} substitution after chain verification and before dispatch`, async t => {
    const f = await fixture(t); const fake = processDouble();
    const original = ReceiptStore.prototype.verifyChain;
    t.mock.method(ReceiptStore.prototype, 'verifyChain', async function () {
      const result = await original.call(this);
      if (alteration === 'report-bytes') { fs.chmodSync(f.report, 0o600); fs.writeFileSync(f.report, marker); fs.chmodSync(f.report, 0o444); }
      if (alteration === 'report-inode') { fs.chmodSync(f.receipt.directory, 0o700); fs.renameSync(f.report, `${f.report}.held`); fs.copyFileSync(`${f.report}.held`, f.report); fs.chmodSync(f.report, 0o444); fs.chmodSync(f.receipt.directory, 0o555); }
      if (alteration === 'root-inode') { fs.renameSync(f.root, `${f.root}-held`); fs.mkdirSync(f.root, { mode: 0o700 }); }
      if (alteration === 'report-mode') fs.chmodSync(f.report, 0o644);
      return result;
    });
    await failed(createDesktopHandoff({ receiptRoot: f.root, spawn: fake.spawn }).openReviewReport(f.report), 'report-unavailable');
    assert.equal(fake.calls.length, 0);
  });
}

test('a read-only report in an apparently canonical directory is not a finalized receipt', async t => {
  const f = await fixture(t); const fake = processDouble();
  const directory = path.join(f.root, '2026-09-14T01-00-00.000Z_unfinalized');
  await mkdir(directory); const report = path.join(directory, 'report.md');
  await writeFile(report, marker, { mode: 0o444 }); await chmod(directory, 0o555);
  await failed(createDesktopHandoff({ receiptRoot: f.root, spawn: fake.spawn }).openReviewReport(report), 'report-unavailable');
  assert.equal(fake.calls.length, 0);
});

test('desktop launch binds the fixed project and has no task, text, or model argv', async t => {
  const f = await fixture(t); const fake = processDouble();
  const api = createDesktopHandoff({ receiptRoot: f.root, codexPath: f.codexPath, spawn: fake.spawn });
  const result = await api.openChromeDeveloperProject();
  const chromeProject = path.join(homedir(), 'chrome');
  assert.deepEqual(result, { status: 'opened', project: { name: 'Chrome Developer', id: '78e19937-a254-4343-847d-171e0f1673d0', path: chromeProject } });
  assert.ok(Object.isFrozen(result.project));
  assert.deepEqual(fake.calls, [{ command: f.codexPath, args: ['app', chromeProject], options: { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: homedir() }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] } }]);
});

test('resolves the trusted discovery symlink and pins its concrete executable', async t => {
  const f = await fixture(t); const fake = processDouble(); const discovery = path.join(f.project, 'codex-link'); fs.symlinkSync(f.codexPath, discovery);
  const api = createDesktopHandoff({ receiptRoot: f.root, codexPath: discovery, spawn: fake.spawn });
  await api.openChromeDeveloperProject(); assert.equal(fake.calls[0].command, f.codexPath);
  fs.unlinkSync(discovery); fs.symlinkSync('/bin/sh', discovery);
  await failed(api.openChromeDeveloperProject(), 'desktop-unavailable'); assert.equal(fake.calls.length, 1);
});

test('desktop success status is independent of informational CLI output, which is discarded', async t => {
  const f = await fixture(t); const fake = processDouble(child => {
    child.stdout.write('Opening Desktop app at /Applications/Codex.app\n');
    child.stderr.write(`Opening workspace ${path.join(homedir(), 'chrome')}\n`);
  });
  const result = await createDesktopHandoff({ codexPath: f.codexPath, spawn: fake.spawn }).openChromeDeveloperProject();
  assert.deepEqual(result, { status: 'opened', project: { name: 'Chrome Developer', id: '78e19937-a254-4343-847d-171e0f1673d0', path: path.join(homedir(), 'chrome') } });
});

for (const alteration of ['mode', 'bytes', 'inode', 'symlink']) {
  test(`pinned executable ${alteration} change prevents the next desktop launch`, async t => {
    const f = await fixture(t); const fake = processDouble(); const api = createDesktopHandoff({ codexPath: f.codexPath, spawn: fake.spawn });
    await api.openChromeDeveloperProject();
    if (alteration === 'mode') fs.chmodSync(f.codexPath, 0o777);
    if (alteration === 'bytes') fs.writeFileSync(f.codexPath, marker);
    if (alteration === 'inode') { fs.renameSync(f.codexPath, `${f.codexPath}.old`); fs.writeFileSync(f.codexPath, 'trusted executable fixture', { mode: 0o700 }); }
    if (alteration === 'symlink') { fs.renameSync(f.codexPath, `${f.codexPath}.old`); fs.symlinkSync(`${f.codexPath}.old`, f.codexPath); }
    await failed(api.openChromeDeveloperProject(), 'desktop-unavailable'); assert.equal(fake.calls.length, 1);
  });
}

for (const method of ['openReviewReport', 'openChromeDeveloperProject']) {
  test(`${method} maps handle-close errors to its fixed code and closes remaining handles`, async t => {
    const f = await fixture(t); let inject = false; let threw = false; const closed = [];
    const close = fs.closeSync;
    t.mock.method(fs, 'closeSync', fd => { close(fd); if (inject) { closed.push(fd); if (!threw) { threw = true; throw new Error(marker); } } });
    const fake = processDouble(() => { inject = true; });
    const api = createDesktopHandoff({ receiptRoot: f.root, codexPath: f.codexPath, spawn: fake.spawn });
    await failed(api[method](...(method === 'openReviewReport' ? [f.report] : [])), method === 'openReviewReport' ? 'report-unavailable' : 'desktop-unavailable');
    assert.ok(closed.length > 1);
  });
  test(`${method} rejects extra caller input without launching`, async t => {
    const f = await fixture(t); const fake = processDouble(); const api = createDesktopHandoff({ receiptRoot: f.root, codexPath: f.codexPath, spawn: fake.spawn });
    await failed(method === 'openReviewReport' ? api[method](f.report, marker) : api[method]({ args: ['--model', marker] }), method === 'openReviewReport' ? 'report-unavailable' : 'desktop-unavailable');
    assert.equal(fake.calls.length, 0);
  });
  test(`${method} discards diagnostic output and reports only a fixed code`, async t => {
    const f = await fixture(t); const fake = processDouble(child => { child.stderr.write(marker); child.emit('close', 1, null); });
    const api = createDesktopHandoff({ receiptRoot: f.root, codexPath: f.codexPath, spawn: fake.spawn });
    await failed(api[method](...(method === 'openReviewReport' ? [f.report] : [])), method === 'openReviewReport' ? 'report-unavailable' : 'desktop-unavailable');
  });
}
