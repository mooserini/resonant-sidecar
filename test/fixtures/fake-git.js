import { createHash } from 'node:crypto';

const DEFAULT_COMMIT = '0123456789abcdef0123456789abcdef01234567';

function asBuffer(value) {
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value ?? '');
}

function gitBlobOid(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

export class FakeGit {
  constructor({ commit = DEFAULT_COMMIT, status = '', statuses = null, files = {} } = {}) {
    this.commit = commit;
    this.status = status;
    this.statuses = statuses === null ? null : [...statuses];
    this.files = new Map(Object.entries(files).map(([filePath, entry]) => {
      const bytes = asBuffer(entry.bytes);
      return [filePath, {
        mode: entry.mode ?? '100644',
        type: entry.type ?? 'blob',
        oid: entry.oid ?? gitBlobOid(bytes),
        bytes,
      }];
    }));
    this.calls = [];
  }

  async run({ repoRoot, args }) {
    this.calls.push({ repoRoot, args: [...args] });

    if (args[0] === 'rev-parse' && args[1] === 'HEAD' && args.length === 2) {
      return { stdout: Buffer.from(`${this.commit}\n`), stderr: Buffer.alloc(0) };
    }

    if (args[0] === 'status') {
      const status = this.statuses?.length ? this.statuses.shift() : this.status;
      return { stdout: Buffer.from(status), stderr: Buffer.alloc(0) };
    }

    if (args[0] === 'ls-tree') {
      const separator = args.indexOf('--');
      const requested = args.slice(separator + 1);
      const records = requested.flatMap(filePath => {
        const entry = this.files.get(filePath);
        if (!entry) return [];
        return [Buffer.concat([
          Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t${filePath}`),
          Buffer.from([0]),
        ])];
      });
      return { stdout: Buffer.concat(records), stderr: Buffer.alloc(0) };
    }

    if (args[0] === 'show' && args.length === 2) {
      const prefix = `${this.commit}:`;
      const specifier = args[1];
      if (!specifier.startsWith(prefix)) throw new Error('Unexpected fake Git show revision');
      const entry = this.files.get(specifier.slice(prefix.length));
      if (!entry) throw new Error('Missing fake Git blob');
      return { stdout: Buffer.from(entry.bytes), stderr: Buffer.alloc(0) };
    }

    throw new Error(`Unexpected fake Git invocation: ${JSON.stringify(args)}`);
  }
}

export function createFakeGit(options) {
  return new FakeGit(options);
}
