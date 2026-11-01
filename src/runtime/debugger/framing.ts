/**
 * Minecraft Script Debugger wire framing (Mojang/minecraft-debugger, MIT): every message is
 * `<8 hex digits length>\n<one-line JSON>\n`, where the length counts the JSON bytes plus the trailing newline.
 */

const HEADER_BYTES = 9;

export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = `${(json.byteLength + 1).toString(16).padStart(8, "0")}\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), json, Buffer.from("\n")]);
}

export class FrameError extends Error {}

/** Incremental decoder: feed it raw TCP chunks (split or merged arbitrarily), get whole messages back. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const out: unknown[] = [];
    while (this.#buffer.byteLength >= HEADER_BYTES) {
      const header = this.#buffer.subarray(0, HEADER_BYTES).toString("ascii");
      if (!/^[0-9a-fA-F]{8}\n$/.test(header)) throw new FrameError(`bad frame header ${JSON.stringify(header)}`);
      const length = Number.parseInt(header.slice(0, 8), 16);
      if (this.#buffer.byteLength < HEADER_BYTES + length) break;
      const body = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      out.push(JSON.parse(body));
    }
    return out;
  }

  /** Bytes received but not yet forming a whole frame. */
  get pending(): number {
    return this.#buffer.byteLength;
  }
}
