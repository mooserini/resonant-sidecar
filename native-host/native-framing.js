export const MAX_INBOUND_BYTES = 64 * 1024 * 1024;
export const MAX_OUTBOUND_BYTES = 1024 * 1024;

export function encodeNativeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_OUTBOUND_BYTES) {
    throw new RangeError(`Native message exceeds ${MAX_OUTBOUND_BYTES}-byte outbound limit`);
  }

  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  #buffer = Buffer.alloc(0);
  #expectedBytes = null;
  #onMessage;

  constructor(onMessage) {
    if (typeof onMessage !== 'function') {
      throw new TypeError('NativeMessageDecoder requires an onMessage callback');
    }
    this.#onMessage = onMessage;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new TypeError('Native message chunk must be bytes');
    }

    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);

    while (true) {
      if (this.#expectedBytes === null) {
        if (this.#buffer.length < 4) return;
        this.#expectedBytes = this.#buffer.readUInt32LE(0);
        this.#buffer = this.#buffer.subarray(4);
        if (this.#expectedBytes > MAX_INBOUND_BYTES) {
          throw new RangeError(
            `Native message length ${this.#expectedBytes} exceeds ${MAX_INBOUND_BYTES}-byte inbound limit`,
          );
        }
      }

      if (this.#buffer.length < this.#expectedBytes) return;

      const body = this.#buffer.subarray(0, this.#expectedBytes);
      this.#buffer = this.#buffer.subarray(this.#expectedBytes);
      this.#expectedBytes = null;

      let value;
      try {
        value = JSON.parse(body.toString('utf8'));
      } catch (error) {
        throw new SyntaxError(`Native message contains invalid JSON: ${error.message}`);
      }
      this.#onMessage(value);
    }
  }
}
