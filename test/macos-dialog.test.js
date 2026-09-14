import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMacOSDialog, showReviewDialog } from '../presentation/macos-dialog.js';

const marker = 'CANDIDATE_" & do shell script "touch /tmp/never"';
const binding = () => ({ reviewId: 'review-9', candidateDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), nonce: 'N'.repeat(43) });
const model = () => ({ kind: 'review-failed', binding: binding() });
const script = 'return button returned of (display dialog "Review failed" buttons {"Open review report", "Continue in Codex", "Dismiss"} default button "Dismiss")';
function childDouble(behavior) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = []; child.kill = signal => { child.kills.push(signal); return true; };
    calls.push({ command, args, options, child });
    queueMicrotask(() => behavior?.(child));
    return child;
  };
  return { calls, spawn };
}
const complete = (text, status = 0, signal = null) => child => { child.stdout.write(text); child.emit('close', status, signal); };
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === code && !String(error).includes(marker));

test('default dialog API exists without launching presentation during import', () => { assert.equal(typeof showReviewDialog, 'function'); });

for (const [button, action] of [['Open review report', 'open-report'], ['Continue in Codex', 'continue-in-codex'], ['Dismiss', 'dismiss']]) {
  test(`fixed ${button} result preserves the original navigation binding`, async () => {
    const fake = childDouble(complete(`${button}\n`));
    const result = await createMacOSDialog({ spawn: fake.spawn }).showReviewDialog(model());
    assert.deepEqual(result, { action, binding: binding() });
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.binding));
    const { command, args, options } = fake.calls[0];
    assert.equal(command, '/usr/bin/osascript'); assert.deepEqual(args, ['-e', script]);
    assert.deepEqual(options, { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.doesNotMatch(JSON.stringify({ command, args, options }), /review-9|NNNN|aaaa|bbbb/);
    assert.equal(fake.calls.length, 1);
  });
}

test('snapshots all binding fields before asynchronous output arrives', async () => {
  const input = model(); const original = binding();
  const fake = childDouble(complete('Dismiss\n'));
  const pending = createMacOSDialog({ spawn: fake.spawn }).showReviewDialog(input);
  input.kind = marker; for (const key of Object.keys(input.binding)) input.binding[key] = marker;
  assert.deepEqual(await pending, { action: 'dismiss', binding: original });
});

for (const [name, make] of [
  ['unknown enum', () => ({ ...model(), kind: marker })],
  ['candidate title', () => ({ ...model(), title: marker })],
  ['candidate buttons', () => ({ ...model(), buttons: [marker] })],
  ['candidate report path', () => ({ ...model(), reportPath: marker })],
  ['candidate verdict', () => ({ ...model(), verdict: 'eligible' })],
  ['candidate action', () => ({ ...model(), action: 'accept' })],
  ['null prototype', () => Object.assign(Object.create(null), model())],
  ['inherited fields', () => Object.create(model())],
  ['non-enumerable field', () => Object.defineProperty(model(), 'extra', { value: marker })],
  ['symbol field', () => ({ ...model(), [Symbol('extra')]: marker })],
  ['unknown binding field', () => ({ ...model(), binding: { ...binding(), expiresAt: 123 } })],
  ['missing nonce', () => ({ ...model(), binding: { ...binding(), nonce: undefined } })],
  ['injected nonce', () => ({ ...model(), binding: { ...binding(), nonce: marker } })],
  ['nonce with trailing newline', () => ({ ...model(), binding: { ...binding(), nonce: 'N'.repeat(43) + '\n' } })],
  ['digest with trailing newline', () => ({ ...model(), binding: { ...binding(), candidateDigest: 'a'.repeat(64) + '\n' } })],
  ['review ID with trailing newline', () => ({ ...model(), binding: { ...binding(), reviewId: 'review-9\n' } })],
  ['bad digest', () => ({ ...model(), binding: { ...binding(), candidateDigest: 'x'.repeat(64) } })],
  ['boxed string', () => ({ ...model(), binding: { ...binding(), nonce: new String('N'.repeat(43)) } })],
]) {
  test(`rejects ${name} before any external operation`, async () => {
    const fake = childDouble(complete('Dismiss\n'));
    await rejectCode(createMacOSDialog({ spawn: fake.spawn }).showReviewDialog(make()), 'invalid-presentation-model');
    assert.equal(fake.calls.length, 0);
  });
}

test('rejects getters, serialization hooks, and proxies without invoking any code', async () => {
  let invoked = 0; const trap = () => { invoked++; throw new Error(marker); };
  const accessor = model(); Object.defineProperty(accessor, 'kind', { get: trap, enumerable: true });
  const nested = model(); Object.defineProperty(nested.binding, 'nonce', { get: trap, enumerable: true });
  const fake = childDouble(complete('Dismiss\n')); const api = createMacOSDialog({ spawn: fake.spawn });
  const revoked = Proxy.revocable(model(), {}); revoked.revoke();
  for (const input of [accessor, nested, { ...model(), toJSON: trap }, new Proxy(model(), { getPrototypeOf: trap, ownKeys: trap }), { ...model(), binding: new Proxy(binding(), { getPrototypeOf: trap }) }, revoked.proxy]) {
    await rejectCode(api.showReviewDialog(input), 'invalid-presentation-model');
  }
  assert.equal(invoked, 0); assert.equal(fake.calls.length, 0);
});

for (const output of ['Accept\n', 'Dismiss', ' Dismiss\n', 'Dismiss\n\n', 'Dismiss\r\n', '\uFEFFDismiss\n', 'button returned:Dismiss\n', marker, 'Open review report\nDismiss\n']) {
  test(`rejects non-exact dialog output ${JSON.stringify(output)}`, async () => {
    const fake = childDouble(complete(output));
    await rejectCode(createMacOSDialog({ spawn: fake.spawn }).showReviewDialog(model()), 'dialog-unavailable');
  });
}

for (const [name, behavior] of [
  ['nonzero exit', complete('Dismiss\n', 1)], ['signal exit', complete('Dismiss\n', null, 'SIGTERM')],
  ['stderr prose', child => { child.stderr.write(marker); child.emit('close', 0, null); }],
  ['spawn error', child => child.emit('error', new Error(marker))],
  ['invalid UTF-8', child => { child.stdout.write(Buffer.from([0xff])); child.emit('close', 0, null); }],
]) {
  test(`reduces ${name} to a fixed failure without leaking diagnostics`, async () => {
    const fake = childDouble(behavior);
    await rejectCode(createMacOSDialog({ spawn: fake.spawn }).showReviewDialog(model()), 'dialog-unavailable');
  });
}

test('combined output overflow kills and settles even if the child never closes', async () => {
  const fake = childDouble(child => { child.stdout.write(Buffer.alloc(2048)); child.stderr.write(Buffer.alloc(2049)); });
  await rejectCode(createMacOSDialog({ spawn: fake.spawn }).showReviewDialog(model()), 'dialog-unavailable');
  assert.deepEqual(fake.calls[0].child.kills, ['SIGKILL']);
});

test('fixed 30-second deadline kills and settles an unresponsive presentation child', async t => {
  let expire;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { assert.equal(delay, 30000); expire = callback; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const fake = childDouble(); const pending = createMacOSDialog({ spawn: fake.spawn }).showReviewDialog(model());
  const checked = rejectCode(pending, 'dialog-unavailable');
  assert.equal(fake.calls[0].child.kills.length, 0); expire(); await checked;
  assert.deepEqual(fake.calls[0].child.kills, ['SIGKILL']);
});
