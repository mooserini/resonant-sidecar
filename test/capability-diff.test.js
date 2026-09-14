import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCapabilities } from '../review/capability-diff.js';

const policy = { approvedCapabilities: { chromePermissions: ['storage'], hostPermissions: [], listeners: [], lifecycleScripts: [] } };
function baseline() {
  return {
    files: [{ path: 'native-host/host.js', mode: 0o644, sha256: 'a'.repeat(64) }],
    capabilities: structuredClone(policy.approvedCapabilities),
    dependencies: { runtime: [], lockfiles: [], packageManager: null },
    sources: { 'native-host/host.js': 'export const value = 1;' },
  };
}

// Each case catches a missing hard-fail boundary, independently of process tests.
for (const [name, change, reason] of [
  ['Chrome permission', c => c.capabilities.chromePermissions.push('tabs'), 'chrome-permission-added'],
  ['host permission', c => c.capabilities.hostPermissions.push('<all_urls>'), 'host-permission-added'],
  ['declared listener', c => c.capabilities.listeners.push('tcp'), 'listener-added'],
  ['listener source', c => c.sources['native-host/host.js'] = "server.listen(7777);", 'listener-added'],
  ['lifecycle hook', c => c.capabilities.lifecycleScripts.push('postinstall'), 'lifecycle-script-added'],
  ['executable mode', c => c.files[0].mode = 0o755, 'executable-added'],
  ['shell command', c => c.sources['native-host/host.js'] = "exec('whoami');", 'command-authority-added'],
  ['approval grant', c => c.sources['native-host/host.js'] = "const result = { decision: 'accept' };", 'approval-authority-added'],
  ['sandbox weakening', c => c.sources['native-host/host.js'] = "const sandbox = 'danger-full-access';", 'sandbox-weakened'],
  ['trusted receipt control', c => c.files.push({ path: 'review/receipt-store.js', mode: 0o644, sha256: 'b'.repeat(64) }), 'trusted-control-modified'],
  ['dependency drift', c => c.dependencies.runtime.push({ name: 'example', specifier: '1.2.3' }), 'dependency-drift'],
  ['dependency missing integrity', c => c.dependencies.runtime.push({ name: 'example', specifier: '^1.2.3' }), 'dependency-integrity-missing'],
]) {
  test(`hard fails added ${name}`, () => {
    const active = baseline();
    const candidate = baseline();
    change(candidate);
    const result = compareCapabilities({ active, candidate, policy });
    assert.equal(result.passed, false);
    assert.ok(result.checks.some(check => check.reasonCode === reason && check.passed === false));
  });
}

test('baseline test script is inert metadata; changed script bodies still fail', () => {
  const active = baseline();
  active.capabilities.lifecycleScripts = ['test'];
  active.sources['package.json'] = JSON.stringify({ scripts: { test: 'node --test' } });
  const candidate = structuredClone(active);
  assert.equal(compareCapabilities({ active, candidate, policy }).passed, true);
  candidate.sources['package.json'] = JSON.stringify({ scripts: { test: 'node attacker.js' } });
  assert.equal(compareCapabilities({ active, candidate, policy }).passed, false);
});

test('unchanged forbidden capability is rejected against pinned policy', () => {
  const active = baseline();
  active.capabilities.hostPermissions.push('<all_urls>');
  assert.equal(compareCapabilities({ active, candidate: structuredClone(active), policy }).passed, false);
});

for (const field of ['content_scripts', 'externally_connectable', 'content_security_policy', 'web_accessible_resources', 'background']) {
  test(`new extension ${field} cannot widen authority outside permission arrays`, () => {
    const active = baseline();
    active.sources['extension/manifest.json'] = JSON.stringify({ manifest_version: 3 });
    const candidate = structuredClone(active);
    candidate.sources['extension/manifest.json'] = JSON.stringify({ manifest_version: 3, [field]: {} });
    assert.equal(compareCapabilities({ active, candidate, policy }).passed, false);
  });
}

test('HTML script and handler changes require separate authority review', () => {
  const active = baseline();
  active.files.push({ path: 'extension/sidepanel.html', mode: 0o644, sha256: 'c'.repeat(64) });
  const candidate = structuredClone(active);
  candidate.files[1].sha256 = 'd'.repeat(64);
  active.sources['extension/sidepanel.html'] = '<button>Send</button>';
  candidate.sources['extension/sidepanel.html'] = '<button onclick="fetch(location)">Send</button>';
  assert.equal(compareCapabilities({ active, candidate, policy }).passed, false);
});

test('ordinary host changes remain reviewable with unchanged process authority', () => {
  const active = baseline();
  active.sources['native-host/host.js'] = "import { spawn } from 'node:child_process';\nconst child = spawn(command, args);\nconst label = 'before';";
  const candidate = structuredClone(active);
  candidate.files[0].sha256 = 'b'.repeat(64);
  candidate.sources['native-host/host.js'] = active.sources['native-host/host.js'].replace("'before'", "'after'");
  assert.equal(compareCapabilities({ active, candidate, policy }).passed, true);
});

test('changed spawn arguments fail even with the same number of spawn calls', () => {
  const active = baseline();
  active.sources['native-host/host.js'] = 'const child = spawn(command, args);';
  const candidate = structuredClone(active);
  candidate.sources['native-host/host.js'] = "const child = spawn('/bin/sh', args);";
  assert.equal(compareCapabilities({ active, candidate, policy }).passed, false);
});
