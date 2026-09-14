import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBundleManifest } from './bundle-manifest.js';
import { canonicalJson, sha256Bytes, sha256Json } from './canonical-json.js';
import { buildCodexReviewPrompt } from './codex-prompt.js';
import { sanitizeEvidence } from './redaction.js';

const POLICY = JSON.parse(await readFile(new URL('../policy/review-policy.v1.json', import.meta.url)));
const SCHEMA = JSON.parse(await readFile(new URL('../policy/codex-attestation.v1.schema.json', import.meta.url)));
const MAX_INPUT = 1024 * 1024;
const MAX_DIFF = 512 * 1024;
const MAX_FINAL = 65536;
const MAX_EVENTS = 256 * 1024;
const TIMEOUT_MS = 60000;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const FIXED_ARGS = Object.freeze([
  '-a', 'never', '-s', 'read-only', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
  '--json', '--skip-git-repo-check',
  '--disable', 'shell_tool', '--disable', 'browser_use', '--disable', 'browser_use_external',
  '--disable', 'browser_use_full_cdp_access', '--disable', 'computer_use', '--disable', 'in_app_browser',
  '--disable', 'apps', '--disable', 'plugins', '-c', 'web_search="disabled"',
]);

function requireValue(condition) { if (!condition) throw new Error('Invalid verifier boundary'); }
function exact(value, keys) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValue(Object.keys(value).sort().join(',') === [...keys].sort().join(','));
}
function failure(reasonCode) { return { passed: false, reasonCode, attestation: null }; }

// JSON.parse silently accepts duplicate properties. Reject ambiguous objects
// before schema checks (including JSONL events), while allowing JSON whitespace.
function parseJson(text) {
  const value = JSON.parse(text);
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  const objects = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '{') objects.push(new Set());
    else if (tokens[i] === '}') objects.pop();
    else if (tokens[i].startsWith('"') && tokens[i + 1] === ':') {
      const key = JSON.parse(tokens[i]);
      requireValue(objects.length > 0 && !objects.at(-1).has(key));
      objects.at(-1).add(key);
    }
  }
  return value;
}

// Interpret only the small trusted v1 schema vocabulary. Never accept a
// candidate-selected schema, remote references, coercion or extra properties.
function validate(value, rule) {
  if (rule.$ref) { requireValue(rule.$ref === '#/$defs/findings'); return validate(value, SCHEMA.$defs.findings); }
  if (Object.hasOwn(rule, 'const')) requireValue(value === rule.const);
  if (rule.enum) requireValue(rule.enum.includes(value));
  if (rule.type === 'object') {
    exact(value, rule.required);
    for (const [key, child] of Object.entries(rule.properties)) validate(value[key], child);
  } else if (rule.type === 'array') {
    requireValue(Array.isArray(value) && value.length <= rule.maxItems);
    for (const item of value) validate(item, rule.items);
  } else if (rule.type === 'string') requireValue(typeof value === 'string' && [...value].length <= rule.maxLength);
}

function eventParser() {
  let phase = 'initial';
  let finalText = null;
  const pending = new Set();
  const completed = new Set();
  return {
    accept(line) {
      const event = parseJson(line);
      requireValue(typeof event.type === 'string');
      if (event.type === 'thread.started') {
        exact(event, ['type', 'thread_id']);
        requireValue(phase === 'initial' && typeof event.thread_id === 'string');
        phase = 'thread';
      } else if (event.type === 'turn.started') {
        exact(event, ['type']); requireValue(phase === 'thread'); phase = 'turn';
      } else if (event.type === 'item.started' || event.type === 'item.completed') {
        exact(event, ['type', 'item']); requireValue(phase === 'turn');
        exact(event.item, ['id', 'type', 'text']);
        requireValue(['reasoning', 'agent_message'].includes(event.item.type));
        requireValue(typeof event.item.id === 'string' && typeof event.item.text === 'string' && !completed.has(event.item.id));
        if (event.type === 'item.started') {
          requireValue(!pending.has(event.item.id)); pending.add(event.item.id);
        } else {
          pending.delete(event.item.id); completed.add(event.item.id);
          if (event.item.type === 'agent_message') { requireValue(finalText === null); finalText = event.item.text; }
        }
      } else if (event.type === 'turn.completed') {
        exact(event, ['type', 'usage']);
        exact(event.usage, ['input_tokens', 'cached_input_tokens', 'output_tokens']);
        requireValue(Object.values(event.usage).every(n => Number.isSafeInteger(n) && n >= 0));
        requireValue(phase === 'turn' && finalText !== null && pending.size === 0); phase = 'done';
      } else throw new Error('Forbidden or unknown event');
    },
    finish() { requireValue(phase === 'done'); return finalText; },
  };
}

async function boundedRun(invocation) {
  return new Promise(resolve => {
    let timer; let child; let total = 0; let pending = Buffer.alloc(0);
    let timedOut = false; let outputLimitExceeded = false; let eventRejected = false;
    const stdout = []; const stderr = []; const parser = eventParser();
    const finish = exitCode => {
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut, outputLimitExceeded, eventRejected });
    };
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    try {
      child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { finish(-1); return; }
    timer = setTimeout(() => { timedOut = true; stop(); }, invocation.timeoutMs);
    for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', bytes => {
      total += bytes.length;
      if (total > invocation.maxOutputBytes) { outputLimitExceeded = true; stop(); return; }
      output.push(bytes);
      if (stream === child.stdout && invocation.auditEvents !== false && !eventRejected) {
        pending = Buffer.concat([pending, bytes]);
        let end;
        while ((end = pending.indexOf(10)) !== -1) {
          const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
          try { parser.accept(UTF8.decode(line)); }
          catch { eventRejected = true; stop(); break; }
        }
      }
    });
    child.once('error', () => finish(-1));
    child.once('close', code => finish(Number.isInteger(code) ? code : -1));
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.input);
  });
}

async function trustedPaths(codexPath, codexHome) {
  for (const file of [codexPath, codexHome]) requireValue(typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file && await realpath(file) === file);
  const executable = await lstat(codexPath);
  requireValue(executable.isFile() && !executable.isSymbolicLink() && (executable.mode & 0o111) !== 0 && (executable.mode & 0o022) === 0);
  const home = await lstat(codexHome);
  requireValue(home.isDirectory() && (home.mode & 0o777) === 0o700 && home.uid === process.getuid());
  // A dedicated auth-only home: no skills, MCP config, instructions, plugins,
  // hooks or inherited user settings. Provisioning auth is a separate action.
  for (const name of await readdir(codexHome)) {
    requireValue(name === 'auth.json');
    const auth = await lstat(path.join(codexHome, name));
    requireValue(auth.isFile() && !auth.isSymbolicLink() && auth.nlink === 1 && (auth.mode & 0o777) === 0o600 && auth.uid === process.getuid());
  }
  return sha256Bytes(await readFile(codexPath));
}

/** The trusted bootstrap owns config/runner/finalizeResult. Candidate data may
 * populate only active/candidate/diff; never pass candidate objects as options.
 * finalizeResult receives sanitized evidence only, suitable for ReceiptStore's
 * attestation and project.testResults. This function never writes a receipt.
 */
export async function runCodexReview(input = {}) {
  if (typeof input.finalizeResult !== 'function') return failure('finalization-required');
  let result = failure('input-invalid');
  let temporary; let outputHandle; let inputDirectory; let inputHandle;
  try {
    requireValue(canonicalJson(input.policy) === canonicalJson(POLICY) && canonicalJson(input.schema) === canonicalJson(SCHEMA));
    requireValue(typeof input.diff === 'string' && Buffer.byteLength(input.diff) <= MAX_DIFF);
    const active = assertBundleManifest(JSON.parse(canonicalJson(input.active)));
    const candidate = assertBundleManifest(JSON.parse(canonicalJson(input.candidate)));
    requireValue(active.schemaVersion === 1 && candidate.schemaVersion === 1);
    const deterministic = sanitizeEvidence(input.deterministic, POLICY);
    requireValue(deterministic.passed === true && Array.isArray(deterministic.checks) && deterministic.checks.length > 0 && deterministic.checks.every(check => check.passed === true));
    requireValue(deterministic.activeBundleDigest === active.bundleDigest && deterministic.candidateBundleDigest === candidate.bundleDigest && deterministic.policySnapshotHash === sha256Json(POLICY));
    const evidence = canonicalJson({ active, candidate, diff: input.diff, deterministic });
    const prompt = buildCodexReviewPrompt({ active, candidate, diff: input.diff, deterministic, policy: POLICY, schema: SCHEMA });
    requireValue(Buffer.byteLength(evidence) <= MAX_INPUT && Buffer.byteLength(prompt) <= MAX_INPUT);
    const executableDigest = await trustedPaths(input.codexPath, input.trustedCodexHome);
    temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sidecar-codex-review-')));
    await chmod(temporary, 0o700);
    inputDirectory = path.join(temporary, 'input');
    await mkdir(inputDirectory, { mode: 0o700 });
    inputHandle = await open(inputDirectory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    await writeFile(path.join(inputDirectory, 'evidence.json'), evidence, { flag: 'wx', mode: 0o400 });
    await chmod(inputDirectory, 0o500);
    const schemaPath = path.join(temporary, 'schema.json');
    await writeFile(schemaPath, canonicalJson(SCHEMA), { flag: 'wx', mode: 0o400 });
    const outputPath = path.join(temporary, 'last-message.json');
    outputHandle = await open(outputPath, 'wx+', 0o600);
    const original = await outputHandle.stat();
    const invocation = { command: input.codexPath, args: [...FIXED_ARGS, '-C', inputDirectory, '--output-schema', schemaPath, '--output-last-message', outputPath, '-'],
      input: prompt, cwd: inputDirectory, shell: false, timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_EVENTS,
      env: { CODEX_HOME: input.trustedCodexHome, HOME: temporary, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } };
    // Hash identities with fixed placeholders, never persist temp/home paths.
    const identities = [{ name: 'codex-executable', sha256: executableDigest },
      { name: 'codex-command', sha256: sha256Json([...FIXED_ARGS, '-C', '<sealed-input>', '--output-schema', '<trusted-schema>', '--output-last-message', '<private-output>', '-']) },
      { name: 'codex-input', sha256: sha256Bytes(prompt) }, { name: 'codex-schema', sha256: sha256Json(SCHEMA) }];
    result = { ...failure('codex-version-invalid'), verifierIdentities: identities };
    const version = await (input.runner ?? boundedRun)({ ...invocation, args: ['--version'], input: '', auditEvents: false, timeoutMs: 5000, maxOutputBytes: 4096 });
    requireValue(version && version.exitCode === 0 && Buffer.isBuffer(version.stdout) && Buffer.isBuffer(version.stderr) && version.stdout.length + version.stderr.length <= 4096 && !version.timedOut && !version.outputLimitExceeded);
    const versionText = UTF8.decode(version.stdout);
    requireValue(/^codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?\n?$/.test(versionText));
    identities.push({ name: 'codex-version', sha256: sha256Bytes(version.stdout) });
    result = { ...failure('codex-execution-failed'), verifierIdentities: identities };
    const output = await (input.runner ?? boundedRun)(invocation);
    const directoryNow = await lstat(inputDirectory);
    const directoryHeld = await inputHandle.stat();
    requireValue(directoryNow.isDirectory() && !directoryNow.isSymbolicLink() && directoryNow.ino === directoryHeld.ino && directoryNow.dev === directoryHeld.dev && (directoryNow.mode & 0o777) === 0o500);
    requireValue(output && Number.isSafeInteger(output.exitCode) && Buffer.isBuffer(output.stdout) && Buffer.isBuffer(output.stderr));
    requireValue(output.stdout.length + output.stderr.length <= MAX_EVENTS);
    result.outputDigest = sha256Json({ stdoutDigest: sha256Bytes(output.stdout), stderrDigest: sha256Bytes(output.stderr) });
    requireValue(output.exitCode === 0 && !output.timedOut && !output.outputLimitExceeded && !output.eventRejected);
    result.reasonCode = 'codex-events-rejected';
    const parser = eventParser();
    const lines = UTF8.decode(output.stdout).split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) parser.accept(line);
    const finalMessage = parser.finish();
    result.reasonCode = 'codex-attestation-rejected';
    const current = await lstat(outputPath);
    const held = await outputHandle.stat();
    requireValue(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.dev === original.dev && current.ino === original.ino && (current.mode & 0o777) === 0o600 && current.size <= MAX_FINAL && held.size <= MAX_FINAL);
    const bytes = Buffer.alloc(MAX_FINAL + 1);
    const { bytesRead } = await outputHandle.read(bytes, 0, bytes.length, 0);
    requireValue(bytesRead <= MAX_FINAL);
    const attestation = parseJson(UTF8.decode(bytes.subarray(0, bytesRead)));
    validate(attestation, SCHEMA);
    requireValue(canonicalJson(parseJson(finalMessage)) === canonicalJson(attestation));
    const sanitized = sanitizeEvidence(attestation, POLICY);
    result = { passed: sanitized.verdict === 'favorable', reasonCode: sanitized.verdict === 'favorable' ? 'codex-favorable' : 'codex-unfavorable',
      attestation: sanitized, outputDigest: sha256Json(sanitized), verifierIdentities: identities,
      activeBundleDigest: active.bundleDigest, candidateBundleDigest: candidate.bundleDigest, policySnapshotHash: sha256Json(POLICY) };
  } catch { /* Only fixed reason codes and hashes cross the custody boundary. */ }
  try { result = sanitizeEvidence(result, POLICY); await input.finalizeResult(structuredClone(result)); }
  catch { result = failure('finalization-failed'); }
  finally {
    try {
      // Truncate the held original inode, never follow a replaced output path.
      // Unlinking cannot promise physical erasure on SSD/COW storage.
      if (outputHandle) { try { await outputHandle.truncate(0); await outputHandle.sync(); } finally { await outputHandle.close(); } }
      if (inputHandle) { try { await inputHandle.chmod(0o700); } finally { await inputHandle.close(); } }
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } catch { result = failure('cleanup-failed'); }
  }
  return result;
}
