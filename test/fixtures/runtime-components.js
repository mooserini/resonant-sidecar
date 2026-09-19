import fs from 'node:fs';
import { createRuntimeLock } from '../../bootstrap/runtime-lock-core.js';
import { VersionStore as ProductionVersionStore } from '../../bootstrap/version-store.js';
import { ChromeReviewJournal as ProductionChromeReviewJournal, MAX_RETAINED_CHROME_INVOCATIONS } from '../../bootstrap/chrome-review-journal.js';

const PERL = '/usr/bin/perl';

async function testInterpreterIdentity() {
  const info = fs.lstatSync(PERL);
  if (fs.realpathSync(PERL) !== PERL || !info.isFile() || info.uid !== 0 || (info.mode & 0o022) || !(info.mode & 0o111)) throw new Error('Test lock interpreter unavailable');
  return info;
}

export const withTestRuntimeLock = createRuntimeLock({ verifyInterpreterIdentity: testInterpreterIdentity });

export class VersionStore extends ProductionVersionStore {
  constructor(options = {}) {
    super({ ...options, withRuntimeLock: options.withRuntimeLock ?? withTestRuntimeLock });
  }
}

export class ChromeReviewJournal extends ProductionChromeReviewJournal {
  constructor(options = {}) {
    super({ ...options, withRuntimeLock: options.withRuntimeLock ?? withTestRuntimeLock });
  }
}

export { MAX_RETAINED_CHROME_INVOCATIONS };
