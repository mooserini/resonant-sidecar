import { createHash } from 'node:crypto';

function assertPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Unsupported JSON value: expected a plain object');
  }
}

function serialize(value, ancestors) {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Unsupported JSON value: expected a finite number');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`Unsupported JSON value: ${typeof value}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError('Unsupported JSON value: circular reference');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('Unsupported JSON value: sparse array');
        }
      }
      return `[${value.map(item => serialize(item, ancestors)).join(',')}]`;
    }

    assertPlainObject(value);
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${serialize(value[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return serialize(value, new Set());
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Json(value) {
  return sha256Bytes(canonicalJson(value));
}
