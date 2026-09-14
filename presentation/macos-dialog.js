import { spawn } from 'node:child_process';
import { types } from 'node:util';

const FAILURE_SCRIPT = 'return button returned of (display dialog "Review failed" buttons {"Open review report", "Continue in Codex", "Dismiss"} default button "Dismiss")';
const CHOICES = new Map([
  ['Open review report\n', 'open-report'],
  ['Continue in Codex\n', 'continue-in-codex'],
  ['Dismiss\n', 'dismiss'],
]);
const ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
const MAX_OUTPUT = 4096;
const TIMEOUT = 30000;

function failure(code) { return Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw failure('invalid-presentation-model');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) || Object.values(descriptors).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) throw failure('invalid-presentation-model');
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function snapshotModel(input) {
  const model = exact(input, ['kind', 'binding']);
  if (model.kind !== 'review-failed') throw failure('invalid-presentation-model');
  const binding = exact(model.binding, ['reviewId', 'candidateDigest', 'policyDigest', 'nonce']);
  if (typeof binding.reviewId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(binding.reviewId) ||
      ![binding.candidateDigest, binding.policyDigest].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
      typeof binding.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(binding.nonce)) throw failure('invalid-presentation-model');
  return Object.freeze(binding);
}

// Internal trusted-side process primitive shared by the two presentation modules.
// Callers supply fixed source-owned command/argv; no model is accepted here.
// Deadlines settle even when inherited pipes never close. Never retain errors.
export function runPresentationProcess(command, args, spawnChild = spawn, desktop = false) {
  return new Promise((resolve, reject) => {
    let child; let timer; let done = false; let count = 0;
    const stdout = []; const stderr = [];
    const finish = (ok, kill = false) => {
      if (done) return; done = true; clearTimeout(timer);
      if (kill) { try { child?.kill('SIGKILL'); } catch { /* No diagnostics cross presentation. */ } }
      child?.stdout?.destroy(); child?.stderr?.destroy();
      if (ok) resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      else reject(failure('presentation-process-failed'));
    };
    try {
      child = spawnChild(command, args, { cwd: '/', env: { ...ENV, ...(desktop ? { HOME: '/Users/thomaskenny' } : {}) }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(() => finish(false, true), TIMEOUT);
      child.once('error', () => finish(false, true));
      child.once('close', (code, signal) => finish(code === 0 && signal === null));
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
        stream.on('error', () => finish(false, true));
        stream.on('data', chunk => {
          if (done) return;
          if (!Buffer.isBuffer(chunk)) { finish(false, true); return; }
          count += chunk.length;
          if (count > MAX_OUTPUT) { finish(false, true); return; }
          chunks.push(Buffer.from(chunk));
        });
      }
    } catch { finish(false, true); }
  });
}

// Constructed only by trusted bootstrap wiring. The injected spawn is an OS
// boundary for tests, never a field supplied by a candidate or browser message.
export function createMacOSDialog({ spawn: spawnChild = spawn } = {}) {
  return Object.freeze({
    async showReviewDialog(model) {
      if (arguments.length !== 1) throw failure('invalid-presentation-model');
      // Snapshot synchronously: neither mutable input nor its nonce is reread.
      const binding = snapshotModel(model);
      try {
        const result = await runPresentationProcess('/usr/bin/osascript', ['-e', FAILURE_SCRIPT], spawnChild);
        if (result.stderr.length !== 0) throw failure('dialog-unavailable');
        const action = CHOICES.get(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout));
        if (!action) throw failure('dialog-unavailable');
        // This navigation action is deliberately not a human acceptance object.
        // Only the coordinator can issue/consume acceptance and rejection grants.
        return Object.freeze({ action, binding });
      } catch { throw failure('dialog-unavailable'); }
    },
  });
}

export const showReviewDialog = createMacOSDialog().showReviewDialog;
