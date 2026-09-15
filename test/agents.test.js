import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

import { AGENT_IDS, resolveAgent } from '../native-host/agents.js';

test('resolves only hermes, grok, and codex', () => {
  assert.deepEqual(AGENT_IDS, ['hermes', 'grok', 'codex']);
  assert.equal(resolveAgent('copilot').id, 'grok');
  assert.equal(resolveAgent('hermes').kind, 'acp');
  assert.equal(resolveAgent('hermes').args[0], 'acp');
  assert.equal(resolveAgent('grok').kind, 'acp');
  assert.deepEqual(resolveAgent('grok').args, ['agent', '--no-leader', 'stdio']);
  assert.equal(resolveAgent('codex').id, 'codex');
});

test('hermes command prefers the local bin', () => {
  const expected = path.join(os.homedir(), '.local', 'bin', 'hermes');
  const resolved = resolveAgent('hermes').command;
  assert.ok(resolved === expected || resolved === 'hermes' || resolved.endsWith('/hermes'));
});
