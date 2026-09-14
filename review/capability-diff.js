import { canonicalJson } from './canonical-json.js';

const TRUSTED_CONTROL = /^(?:bootstrap|review|policy|presentation)\//;
const DETECTORS = [
  ['listener-added', /\b(?:listen|createServer|WebSocket|EventSource|fetch|XMLHttpRequest)\b|node:(?:net|http|https|http2|dgram|tls)/],
  ['command-authority-added', /\b(?:command|args|parseArgs|shell|exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\b|child_process|app-server/],
  ['approval-authority-added', /\b(?:decision|approvalPolicy|requestApproval)\b/],
  ['sandbox-weakened', /danger-full-access|workspace-write|bypass-approvals|\b(?:sandbox|developerInstructions|ZERO_TOOL_INSTRUCTIONS)\b/],
  ['browser-authority-added', /\b(?:chrome|browser)\s*(?:\.|\[)\s*(?:tabs|cookies|history|debugger|scripting|webRequest)|\b(?:clipboard|credentials|remote-debugging|CDP)\b/],
  ['authority-review-required', /\b(?:eval|Function|globalThis|global|require|process|import|constructor|prototype|Reflect|Proxy|WebAssembly)\b|__proto__|\\[ux][0-9a-fA-F]/],
];

function body(value) { return value.manifest ?? value; }

function sensitiveLines(source, detector) {
  return (source ?? '').split('\n').map(line => line.trim()).filter(line => detector.test(line)).sort();
}

// These conservative detectors are bounded review evidence, not proof of
// arbitrary JavaScript equivalence. Codex review and human acceptance follow.
export function compareCapabilities({ active, candidate, policy }) {
  const before = body(active);
  const after = body(candidate);
  const reasons = new Set();
  for (const [key, reason] of [
    ['chromePermissions', 'chrome-permission-added'],
    ['hostPermissions', 'host-permission-added'],
    ['listeners', 'listener-added'],
    ['lifecycleScripts', 'lifecycle-script-added'],
  ]) {
    const allowed = policy.approvedCapabilities?.[key] ?? [];
    for (const value of after.capabilities[key]) {
      // The pre-existing development test script is never executed by review.
      const inertTest = key === 'lifecycleScripts' && value === 'test' && before.capabilities[key].includes(value);
      if (!inertTest && (!allowed.includes(value) || !before.capabilities[key].includes(value))) reasons.add(reason);
    }
  }
  const previousFiles = new Map(before.files.map(file => [file.path, file]));
  for (const file of after.files) {
    const previous = previousFiles.get(file.path);
    if ((file.mode & 0o111) & ~(previous?.mode & 0o111)) reasons.add('executable-added');
    if (TRUSTED_CONTROL.test(file.path)) reasons.add('trusted-control-modified');
  }
  for (const [file, source] of Object.entries(candidate.sources ?? {})) {
    if (source === active.sources?.[file]) continue;
    if (file.endsWith('.js')) {
      for (const [reason, detector] of DETECTORS) {
        if (canonicalJson(sensitiveLines(source, detector)) !== canonicalJson(sensitiveLines(active.sources?.[file], detector))) reasons.add(reason);
      }
    }
    if (file.endsWith('.html') || file.endsWith('.css')) {
      const authority = /<\s*script\b|\bon\w+\s*=|\b(?:src|href)\s*=|\burl\s*\(|@import/i;
      if (canonicalJson(sensitiveLines(source, authority)) !== canonicalJson(sensitiveLines(active.sources?.[file], authority))) reasons.add('authority-review-required');
    }
  }
  const oldPackage = active.sources?.['package.json'];
  const newPackage = candidate.sources?.['package.json'];
  if (newPackage !== undefined) {
    try {
      const oldScripts = oldPackage === undefined ? {} : JSON.parse(oldPackage).scripts ?? {};
      const newScripts = JSON.parse(newPackage).scripts ?? {};
      if (canonicalJson(oldScripts) !== canonicalJson(newScripts)) reasons.add('lifecycle-script-added');
      const pkg = JSON.parse(newPackage);
      if (pkg.bin || pkg.gypfile || pkg.workspaces) reasons.add('executable-added');
      if (pkg.devDependencies && Object.keys(pkg.devDependencies).length) reasons.add('dependency-drift');
    } catch { reasons.add('schema-invalid'); }
  }
  if (canonicalJson(before.dependencies) !== canonicalJson(after.dependencies)) reasons.add('dependency-drift');
  const oldExtension = active.sources?.['extension/manifest.json'];
  const newExtension = candidate.sources?.['extension/manifest.json'];
  if (newExtension !== undefined) {
    try {
      const authorityFields = source => {
        const value = JSON.parse(source ?? '{}');
        // Only display identity can change without a separate authority review.
        for (const key of ['name', 'version', 'description']) delete value[key];
        return value;
      };
      if (canonicalJson(authorityFields(oldExtension)) !== canonicalJson(authorityFields(newExtension))) reasons.add('authority-review-required');
    } catch { reasons.add('schema-invalid'); }
  }
  // V1 is dependency-free. Any runtime dependency needs a separately pinned
  // integrity graph; a lockfile's existence alone cannot prove that graph.
  if (after.dependencies.runtime.length) reasons.add('dependency-integrity-missing');
  const checks = [...reasons].sort().map(reasonCode => ({ name: 'capabilities', passed: false, reasonCode }));
  if (checks.length === 0) checks.push({ name: 'capabilities', passed: true });
  return { passed: reasons.size === 0, checks };
}
