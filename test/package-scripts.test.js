import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('release verification requires both the ordinary and macOS runtime-lock lanes', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.check, 'node --check native-host/*.js && node --check extension/*.js && node --check scripts/*.js && node --test test/*.test.js');
  assert.doesNotMatch(pkg.scripts.check, /runtime-lock\.platform/);
  assert.equal(pkg.scripts['check:runtime-lock'], 'node --test test/runtime-lock-identity.test.js test/runtime-lock.platform.js');
  assert.equal(pkg.scripts['check:release'], 'npm run check && npm run check:runtime-lock');
});
