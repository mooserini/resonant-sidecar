import { writeFile } from 'node:fs/promises';

export const favorable = {
  schemaVersion: 1, verdict: 'favorable', summary: 'No behavioral change.',
  behavioralDifferences: [], dependencyChanges: [], unexplainedFiles: [], policyConcerns: [],
};

export function eventsFor(text) {
  return [
    { type: 'thread.started', thread_id: 'fixture-thread' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } },
    { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 40 } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
}

// Only the external CLI is doubled: the verifier still creates, seals, parses,
// sanitizes, finalizes and removes real files.
export function fakeCodex({ text = JSON.stringify(favorable), events = eventsFor(text), exitCode = 0, stderr = '', beforeWrite, ...flags } = {}) {
  return async invocation => {
    if (invocation.args.includes('--version')) return { exitCode: 0, stdout: Buffer.from('codex-cli 0.153.2\n'), stderr: Buffer.alloc(0) };
    await beforeWrite?.(invocation);
    await writeFile(invocation.args[invocation.args.indexOf('--output-last-message') + 1], text);
    return { exitCode, stdout: Buffer.from(events), stderr: Buffer.from(stderr), ...flags };
  };
}

export async function runFakeProcess(mode) {
  if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.153.2\n'); return; }
  for await (const chunk of process.stdin) { void chunk; }
  if (mode === 'tool') {
    process.stdout.write('{"type":"thread.started","thread_id":"fixture-thread"}\n{"type":"turn.started"}\n');
    process.stdout.write('{"type":"item.started","item":{"id":"x","type":"command_execution","command":"forbidden"}}\n');
    // A killed CLI cannot reach this marker.
    setTimeout(() => { writeFile(process.argv.at(-2), 'tool process survived'); }, 1500);
  } else if (mode === 'overflow') {
    process.stderr.write('x'.repeat(262145));
    setTimeout(() => {}, 1500);
  } else if (mode === 'reject-flags') {
    process.stderr.write('error: Unknown feature flag: browser_use\n');
    process.exitCode = 2;
  } else {
    await writeFile(process.argv.at(-2), JSON.stringify(favorable));
    process.stdout.write(eventsFor(JSON.stringify(favorable)));
  }
}
