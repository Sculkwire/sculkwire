/** Writes `.brarchive` containers for tests (the layout is documented in `src/gamefiles/brarchive.ts`). */
import { BRARCHIVE_MAGIC, BRARCHIVE_VERSION } from "../gamefiles/brarchive.ts";

const HEADER_SIZE = 16;
const ENTRY_SIZE = 256;
const NAME_MAX = 247;

/** Inverse of `parseBrarchive`. */
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
