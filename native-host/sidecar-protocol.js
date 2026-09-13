export const MAX_TURN_TEXT_BYTES = 32 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(message, keys) {
  const allowed = new Set(keys);
  const extra = Object.keys(message).filter(key => !allowed.has(key));
  if (extra.length > 0) {
    throw new TypeError(`Unsupported field: ${extra[0]}`);
  }
}

export function parseBrowserMessage(value) {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new TypeError('Browser message must be an object with a type');
  }

  if (value.type === 'session.open') {
    assertOnlyKeys(value, ['type', 'threadId']);
    if (value.threadId !== null && typeof value.threadId !== 'string') {
      throw new TypeError('session.open threadId must be a string or null');
    }
    if (typeof value.threadId === 'string') {
      if (value.threadId.length === 0 || value.threadId.length > 256) {
        throw new RangeError('session.open threadId must contain 1 to 256 characters');
      }
    }
    return { type: value.type, threadId: value.threadId };
  }

  if (value.type === 'turn.start') {
    assertOnlyKeys(value, ['type', 'text']);
    if (typeof value.text !== 'string' || value.text.trim().length === 0) {
      throw new TypeError('turn.start text must be non-empty');
    }
    if (Buffer.byteLength(value.text, 'utf8') > MAX_TURN_TEXT_BYTES) {
      throw new RangeError('turn.start text is too large');
    }
    return { type: value.type, text: value.text };
  }

  if (value.type === 'turn.interrupt') {
    assertOnlyKeys(value, ['type']);
    return { type: value.type };
  }

  throw new TypeError(`Unsupported browser message type: ${value.type}`);
}
