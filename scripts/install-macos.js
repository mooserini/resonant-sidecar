#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.resonantmirror.sidecar';
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseInstallerArgs(args) {
  let install = false;
  let extensionId = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--install') {
      install = true;
      continue;
    }
    if (argument === '--extension-id') {
      extensionId = args[index + 1] || null;
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown installer argument: ${argument}`);
  }

  if (extensionId !== null && !EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new TypeError('extension-id must be 32 lowercase letters from a through p');
  }
  if (install && extensionId === null) {
    throw new TypeError('--install requires --extension-id');
  }
  return { install, extensionId };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function buildInstallPlan({
  extensionId,
  homeDir = os.homedir(),
  nodePath = process.execPath,
  codexPath = path.join(os.homedir(), '.local', 'bin', 'codex'),
  projectRoot: root = projectRoot,
}) {
  if (!EXTENSION_ID_PATTERN.test(extensionId || '')) {
    throw new TypeError('A valid extension-id is required to build the install plan');
  }

  const supportRoot = path.join(homeDir, 'Library', 'Application Support');
  const launcherPath = path.join(supportRoot, 'Resonant Sidecar', 'native-host');
  const manifestPath = path.join(
    supportRoot,
    'Google',
    'Chrome Dev',
    'NativeMessagingHosts',
    `${HOST_NAME}.json`,
  );
  const hostPath = path.join(root, 'native-host', 'host.js');
  const launcher = [
    '#!/bin/sh',
    `export RESONANT_CODEX_COMMAND=${shellQuote(codexPath)}`,
    `export RESONANT_WORKSPACE=${shellQuote(root)}`,
    `exec ${shellQuote(nodePath)} ${shellQuote(hostPath)}`,
    '',
  ].join('\n');
  const manifest = {
    name: HOST_NAME,
    description: 'Local Codex conversation sidecar',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  return { launcherPath, manifestPath, launcher, manifest };
}

async function writeAtomic(destination, contents, mode) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode });
  await chmod(temporary, mode);
  await rename(temporary, destination);
}

export async function installNativeHost(plan) {
  await writeAtomic(plan.launcherPath, plan.launcher, 0o700);
  await writeAtomic(
    plan.manifestPath,
    `${JSON.stringify(plan.manifest, null, 2)}\n`,
    0o600,
  );
}

async function main() {
  const options = parseInstallerArgs(process.argv.slice(2));
  if (!options.extensionId) {
    process.stdout.write([
      'Dry run only; no files changed.',
      `Extension directory: ${path.join(projectRoot, 'extension')}`,
      'After loading it unpacked in Chrome Dev, run:',
      '  node scripts/install-macos.js --install --extension-id <32-character-id>',
      '',
    ].join('\n'));
    return;
  }

  const plan = buildInstallPlan({ extensionId: options.extensionId });
  if (!options.install) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      launcherPath: plan.launcherPath,
      manifestPath: plan.manifestPath,
      manifest: plan.manifest,
    }, null, 2)}\n`);
    return;
  }

  await installNativeHost(plan);
  process.stdout.write(`${JSON.stringify({
    mode: 'installed',
    launcherPath: plan.launcherPath,
    manifestPath: plan.manifestPath,
    allowedOrigin: plan.manifest.allowed_origins[0],
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
