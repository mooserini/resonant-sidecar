import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ReceiptStore } from '../review/receipt-store.js';
import { sha256Bytes } from '../review/canonical-json.js';
import { runPresentationProcess } from './macos-dialog.js';

const DEFAULT_ROOT = fileURLToPath(new URL('../review-receipts', import.meta.url));
const CODEX_DISCOVERY = path.join(os.homedir(), '.local', 'bin', 'codex');
const PROJECT = Object.freeze({
  name: 'Chrome Developer',
  id: '78e19937-a254-4343-847d-171e0f1673d0',
  path: path.join(os.homedir(), 'chrome'),
});
const MAX_REPORT = 4 * 1024 * 1024;
const MAX_EXECUTABLE = 512 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireValue = condition => { if (!condition) fail('invalid-presentation-custody'); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
function concrete(file) {
  requireValue(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file && !file.includes('\0'));
}

// Keep every ancestor and the original regular-file inode open across custody
// verification and process completion. No lstat result alone is authority.
function holdPath(file, maxSize, expectedMode) {
  concrete(file);
  const entries = []; let current = '/';
  try {
    const parts = file.slice(1).split('/');
    for (let i = 0; i <= parts.length; i++) {
      if (i) current = path.join(current, parts[i - 1]);
      const directory = i < parts.length;
      const metadata = fs.lstatSync(current);
      requireValue(!metadata.isSymbolicLink() && (directory ? metadata.isDirectory() : metadata.isFile() && metadata.nlink === 1 && metadata.size <= maxSize));
      // Reread ancestors immediately before each pathname open.
      for (const entry of entries) requireValue(same(fs.lstatSync(entry.path), entry.metadata));
      const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (directory ? fs.constants.O_DIRECTORY : fs.constants.O_NONBLOCK));
      entries.push({ path: current, metadata, fd, directory });
      requireValue(same(metadata, fs.fstatSync(fd)));
    }
    const leaf = entries.at(-1);
    if (expectedMode !== undefined) requireValue((leaf.metadata.mode & 0o777) === expectedMode);
    const bytes = fs.readFileSync(leaf.fd);
    requireValue(bytes.length <= maxSize);
    const digest = sha256Bytes(bytes);
    function verify() {
      for (const entry of entries) {
        const fresh = fs.lstatSync(entry.path); const held = fs.fstatSync(entry.fd);
        requireValue(same(fresh, entry.metadata) && same(held, entry.metadata));
        if (!entry.directory) requireValue(fresh.isFile() && fresh.nlink === 1 && held.nlink === 1 && fresh.size === bytes.length && held.size === bytes.length);
      }
      const observed = Buffer.alloc(bytes.length);
      let offset = 0;
      while (offset < observed.length) {
        const read = fs.readSync(leaf.fd, observed, offset, observed.length - offset, offset);
        requireValue(read > 0); offset += read;
      }
      requireValue(sha256Bytes(observed) === digest);
    }
    verify();
    return { entries, metadata: leaf.metadata, bytes, digest, verify, close: () => {
      let failed = false;
      for (const entry of entries.reverse()) { try { fs.closeSync(entry.fd); } catch { failed = true; } }
      requireValue(!failed);
    } };
  } catch (error) {
    for (const entry of entries.reverse()) { try { fs.closeSync(entry.fd); } catch { /* Fixed outer failure. */ } }
    throw error;
  }
}
function emptyOutput(result) { requireValue(result.stdout.length === 0 && result.stderr.length === 0); }

// Configuration is installed by trusted bootstrap code, never passed through
// lifecycle messages. ReceiptStore itself is not injectable: callers cannot
// assert a report is finalized. The discovery path follows the installer
// convention; its concrete executable inode and digest are pinned on first use.
export function createDesktopHandoff({ receiptRoot = DEFAULT_ROOT, codexPath = CODEX_DISCOVERY, spawn: spawnChild = spawn } = {}) {
  let executablePin = null;
  return Object.freeze({
    async openReviewReport(reportPath) {
      let held;
      try {
        requireValue(arguments.length === 1); concrete(receiptRoot); concrete(reportPath);
        requireValue(path.basename(receiptRoot) === 'review-receipts' && path.basename(reportPath) === 'report.md' && path.dirname(path.dirname(reportPath)) === receiptRoot);
        requireValue(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z_[A-Za-z0-9-]+$/.test(path.basename(path.dirname(reportPath))));
        held = holdPath(reportPath, MAX_REPORT, 0o444);
        const parent = held.entries.at(-2); requireValue((parent.metadata.mode & 0o777) === 0o555);
        const store = new ReceiptStore({ root: receiptRoot });
        const chain = await store.verifyChain(); requireValue(chain.state === 'intact');
        const receipt = chain.receipts.find(item => item.directory === parent.path); requireValue(receipt !== undefined);
        // ReceiptStore v1 report bytes are derived exclusively from canonical
        // receipt fields. Bind the held report to that verified record as well.
        const expected = `# Local review receipt\n\nReview: ${receipt.reviewId}\n\nEvent: ${receipt.eventType}\n\nOutcome: ${receipt.outcome}\n\nCreated: ${receipt.createdAt}\n`;
        requireValue(held.bytes.equals(Buffer.from(expected, 'utf8')));
        held.verify();
        // No await occurs between the final identity/hash check and spawn.
        const running = runPresentationProcess('/usr/bin/open', [reportPath], spawnChild);
        emptyOutput(await running); held.verify();
        const after = await store.verifyChain(); requireValue(after.state === 'intact' && after.receipts.some(item => item.receiptHash === receipt.receiptHash && item.directory === receipt.directory));
        held.verify();
        return Object.freeze({ status: 'opened' });
      } catch { fail('report-unavailable'); }
      finally { if (held) { try { held.close(); } catch { fail('report-unavailable'); } } }
    },
    async openChromeDeveloperProject() {
      let held;
      try {
        requireValue(arguments.length === 0); concrete(codexPath);
        const executable = fs.realpathSync(codexPath);
        held = holdPath(executable, MAX_EXECUTABLE);
        requireValue((held.metadata.mode & 0o111) !== 0 && (held.metadata.mode & 0o022) === 0);
        if (executablePin) requireValue(executable === executablePin.path && same(held.metadata, executablePin.metadata) && held.digest === executablePin.digest);
        else executablePin = { path: executable, metadata: held.metadata, digest: held.digest };
        held.verify();
        const running = runPresentationProcess(executable, ['app', PROJECT.path], spawnChild, true);
        // Codex may print informational opening messages. Only its bounded
        // exit status is interpreted; stdout/stderr never become UI or authority.
        await running; held.verify(); requireValue(fs.realpathSync(codexPath) === executable);
        return Object.freeze({ status: 'opened', project: PROJECT });
      } catch { fail('desktop-unavailable'); }
      finally { if (held) { try { held.close(); } catch { fail('desktop-unavailable'); } } }
    },
  });
}

const desktop = createDesktopHandoff();
export const openReviewReport = desktop.openReviewReport;
export const openChromeDeveloperProject = desktop.openChromeDeveloperProject;
