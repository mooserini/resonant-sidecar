import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildInstallPlan,
  installNativeHost,
  parseInstallerArgs,
} from '../scripts/install-macos.js';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

test('requires an exact unpacked extension id before installation', () => {
  assert.throws(() => parseInstallerArgs(['--install']), /extension-id/i);
  assert.throws(
    () => parseInstallerArgs(['--extension-id', 'not-an-extension-id']),
    /extension-id/i,
  );
  assert.deepEqual(parseInstallerArgs([]), { install: false, extensionId: null });
  assert.deepEqual(
    parseInstallerArgs(['--install', '--extension-id', EXTENSION_ID]),
    { install: true, extensionId: EXTENSION_ID },
  );
});

test('builds an exact-origin Chrome Dev native-host plan with no network endpoint', () => {
  const plan = buildInstallPlan({
    extensionId: EXTENSION_ID,
    homeDir: '/Users/example',
    nodePath: '/opt/node/bin/node',
    codexPath: '/Users/example/.local/bin/codex',
    projectRoot: '/Users/example/resonant-sidecar',
  });

  assert.equal(
    plan.manifestPath,
    '/Users/example/Library/Application Support/Google/Chrome Dev/NativeMessagingHosts/com.resonantmirror.sidecar.json',
  );
  assert.deepEqual(plan.manifest.allowed_origins, [
    `chrome-extension://${EXTENSION_ID}/`,
  ]);
  assert.equal(plan.manifest.type, 'stdio');
  assert.equal(plan.manifest.path, plan.launcherPath);
  assert.doesNotMatch(plan.launcher, /--remote-debugging|localhost|127\.0\.0\.1|websocket/i);
  assert.match(plan.launcher, /exec/);
  assert.match(plan.launcher, /RESONANT_CODEX_COMMAND/);
});

test('installs launcher and manifest with user-only file modes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resonant-sidecar-install-'));
  const plan = buildInstallPlan({
    extensionId: EXTENSION_ID,
    homeDir: root,
    nodePath: '/opt/node/bin/node',
    codexPath: '/opt/codex/bin/codex',
    projectRoot: '/opt/resonant-sidecar',
  });

  await installNativeHost(plan);

  assert.deepEqual(JSON.parse(await readFile(plan.manifestPath, 'utf8')), plan.manifest);
  assert.equal((await stat(plan.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(plan.launcherPath)).mode & 0o777, 0o700);
});
