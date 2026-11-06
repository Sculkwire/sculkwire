/**
 * Bedrock `__brarchive/*.brarchive` container:
 * `u64 magic | u32 count | u32 version (=1) | count x 256-byte entry {u8 nameLen, name[247], u32 offset, u32 size}
 * | data blob`. Entry offsets are relative to the blob start. Names are UTF-8 paths relative to the archive's
 * directory, `/`-separated.
 */

export const BRARCHIVE_MAGIC = 0x267052a0b125277dn;
export const BRARCHIVE_VERSION = 1;
const HEADER_SIZE = 16;
const ENTRY_SIZE = 256;
const NAME_MAX = 247;

export interface BrarchiveEntry {
  name: string;
  data: Buffer;
}

export class BrarchiveError extends Error {
  readonly reason: "not-brarchive" | "unsupported-version" | "truncated" | "bad-entry";
  constructor(reason: BrarchiveError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

/** True when the buffer starts with the brarchive magic. Encrypted packs (whole-file ciphertext) return false. */
export function isBrarchive(buf: Buffer): boolean {
  return buf.length >= 8 && buf.readBigUInt64LE(0) === BRARCHIVE_MAGIC;
}

/** Entry data are views into `buf` (no copies). */
export function parseBrarchive(buf: Buffer): BrarchiveEntry[] {
  if (!isBrarchive(buf)) throw new BrarchiveError("not-brarchive", "missing brarchive magic (encrypted or not a brarchive)");
  if (buf.length < HEADER_SIZE) throw new BrarchiveError("truncated", "header truncated");
  const count = buf.readUInt32LE(8);
  const version = buf.readUInt32LE(12);
  if (version !== BRARCHIVE_VERSION) {
    throw new BrarchiveError("unsupported-version", `unsupported brarchive version ${version}`);
  }
  const blob = HEADER_SIZE + count * ENTRY_SIZE;
  if (blob > buf.length) throw new BrarchiveError("truncated", `entry table needs ${blob} bytes, file has ${buf.length}`);
  const entries: BrarchiveEntry[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEADER_SIZE + i * ENTRY_SIZE;
    const nameLen = buf[o]!;
    if (nameLen === 0 || nameLen > NAME_MAX) throw new BrarchiveError("bad-entry", `entry ${i}: name length ${nameLen}`);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(o + 1, o + 1 + nameLen));
    const offset = buf.readUInt32LE(o + 248);
    const size = buf.readUInt32LE(o + 252);
    const start = blob + offset;
    if (start + size > buf.length) {
      throw new BrarchiveError("truncated", `entry ${i} (${name}): data ${start}+${size} beyond ${buf.length}`);
    }
    if (name.split("/").some((part) => part === ".." || part === "") || name.startsWith("/")) {
      throw new BrarchiveError("bad-entry", `entry ${i}: unsafe name ${JSON.stringify(name)}`);
    }
    entries.push({ name, data: buf.subarray(start, start + size) });
  }
  return entries;
}

/** Inverse of `parseBrarchive`; used by tests and for round-trips. */
export function buildBrarchive(entries: readonly { name: string; data: Uint8Array }[]): Buffer {
  const table = Buffer.alloc(HEADER_SIZE + entries.length * ENTRY_SIZE);
  table.writeBigUInt64LE(BRARCHIVE_MAGIC, 0);
  table.writeUInt32LE(entries.length, 8);
  table.writeUInt32LE(BRARCHIVE_VERSION, 12);
  let offset = 0;
  entries.forEach((entry, i) => {
    const name = Buffer.from(entry.name, "utf8");
    if (name.length === 0 || name.length > NAME_MAX) throw new RangeError(`name too long: ${entry.name}`);
    const o = HEADER_SIZE + i * ENTRY_SIZE;
    table[o] = name.length;
    name.copy(table, o + 1);
    table.writeUInt32LE(offset, o + 248);
    table.writeUInt32LE(entry.data.length, o + 252);
    offset += entry.data.length;
  });
  return Buffer.concat([table, ...entries.map((e) => e.data)]);
}
