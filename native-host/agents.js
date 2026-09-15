import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AGENT_IDS = Object.freeze(['hermes', 'grok', 'codex']);

function existing(file) {
  try {
    if (file && fs.existsSync(file)) return fs.realpathSync(file);
  } catch { /* keep searching */ }
  return null;
}

function homeBin(name) {
  return path.join(os.homedir(), '.local', 'bin', name);
}

export function resolveAgent(name) {
  const id = AGENT_IDS.includes(name) ? name : 'grok';
  const home = os.homedir();

  if (id === 'hermes') {
    return Object.freeze({
      id,
      kind: 'acp',
      command: process.env.RESONANT_HERMES_COMMAND || existing(homeBin('hermes')) || 'hermes',
      args: ['acp'],
    });
  }

  if (id === 'grok') {
    return Object.freeze({
      id,
      kind: 'acp',
      command: process.env.RESONANT_GROK_COMMAND
        || existing(homeBin('grok'))
        || existing(path.join(home, '.grok', 'bin', 'grok'))
        || 'grok',
      args: ['agent', '--no-leader', 'stdio'],
    });
  }

  const acp = process.env.RESONANT_CODEX_ACP;
  if (acp) {
    return Object.freeze({ id: 'codex', kind: 'acp', command: acp, args: [] });
  }
  return Object.freeze({
    id: 'codex',
    kind: 'app-server',
    command: process.env.RESONANT_CODEX_COMMAND || existing(homeBin('codex')) || 'codex',
    args: ['app-server'],
  });
}
