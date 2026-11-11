/**
 * PNG recompression for the retail agent's screenshots. The agent is no_std and writes its PNG with stored
 * (uncompressed) deflate blocks, about 6 MB for a 1920x1080 frame; one real deflate pass makes that a fraction.
 */

import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An IDAT stream at least this fraction of its inflated size is treated as stored, so worth recompressing. */
const STORED_RATIO = 0.5;
/** A recompressed file is only kept when it is at most this fraction of the original. */
const KEEP_RATIO = 0.9;

interface Chunk {
  type: string;
  data: Buffer;
}

function chunks(png: Buffer): Chunk[] | undefined {
  if (png.length < SIGNATURE.length || !png.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return undefined;
  const out: Chunk[] = [];
  let at = SIGNATURE.length;
  while (at + 12 <= png.length) {
    const length = png.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > png.length) return undefined;
    const type = png.toString("latin1", at + 4, at + 8);
    out.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at = end;
    if (type === "IEND") return out;
  }
  return undefined;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * The PNG with its IDAT stream deflated again into one IDAT chunk, every other chunk kept as is. Undefined when
 * the input is not a well-formed PNG, its IDAT is already compressed, or recompressing does not shrink it enough.
 */
export function recompressPng(png: Buffer): Buffer | undefined {
  const parsed = chunks(png);
  if (!parsed) return undefined;
  const idat = parsed.filter((c) => c.type === "IDAT");
  if (idat.length === 0) return undefined;
  const stream = Buffer.concat(idat.map((c) => c.data));
  let raw: Buffer;
  try {
    raw = inflateSync(stream);
  } catch {
    return undefined;
  }
  if (stream.length < raw.length * STORED_RATIO) return undefined;
  const parts: Buffer[] = [SIGNATURE];
  let wrote = false;
  for (const c of parsed) {
    if (c.type !== "IDAT") parts.push(chunk(c.type, c.data));
    else if (!wrote) {
      parts.push(chunk("IDAT", deflateSync(raw, { level: 6 })));
      wrote = true;
    }
  }
  const out = Buffer.concat(parts);
  return out.length <= png.length * KEEP_RATIO ? out : undefined;
}

/** Recompresses the PNG at `path` in place (atomically, via a sibling temp file). True when the file was rewritten. */
export async function recompressPngFile(path: string): Promise<boolean> {
  const out = recompressPng(await readFile(path));
  if (!out) return false;
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, out);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  return true;
}
