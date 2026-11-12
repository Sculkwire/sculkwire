/** Little-endian NBT as used by Bedrock `level.dat`: 8-byte header (storage version, body length) + root compound. */

export const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
} as const;
export type TagType = (typeof TAG)[keyof typeof TAG];

export type NbtValue = number | bigint | string | Uint8Array | number[] | bigint[] | NbtList | NbtCompound;
export interface NbtTag {
  type: TagType;
  value: NbtValue;
}
export interface NbtList {
  elementType: TagType;
  items: NbtTag[];
}
/** Insertion-ordered, as the game writes it. */
export type NbtCompound = Map<string, NbtTag>;

export interface LevelDat {
  storageVersion: number;
  rootName: string;
  root: NbtCompound;
}

class Reader {
  #view: DataView;
  #bytes: Uint8Array;
  #pos = 0;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  #advance(n: number): number {
    const at = this.#pos;
    if (at + n > this.#bytes.byteLength) throw new Error(`NBT truncated at byte ${at}`);
    this.#pos += n;
    return at;
  }
  byte(): number {
    return this.#view.getInt8(this.#advance(1));
  }
  int(): number {
    return this.#view.getInt32(this.#advance(4), true);
  }
  long(): bigint {
    return this.#view.getBigInt64(this.#advance(8), true);
  }
  string(): string {
    const n = this.#view.getUint16(this.#advance(2), true);
    const at = this.#advance(n);
    return new TextDecoder().decode(this.#bytes.subarray(at, at + n));
  }
  payload(type: number): NbtValue {
    switch (type) {
      case TAG.Byte:
        return this.byte();
      case TAG.Short:
        return this.#view.getInt16(this.#advance(2), true);
      case TAG.Int:
        return this.int();
      case TAG.Long:
        return this.long();
      case TAG.Float:
        return this.#view.getFloat32(this.#advance(4), true);
      case TAG.Double:
        return this.#view.getFloat64(this.#advance(8), true);
      case TAG.String:
        return this.string();
      case TAG.ByteArray: {
        const n = this.int();
        const at = this.#advance(n);
        return this.#bytes.slice(at, at + n);
      }
      case TAG.IntArray:
        return Array.from({ length: this.int() }, () => this.int());
      case TAG.LongArray:
        return Array.from({ length: this.int() }, () => this.long());
      case TAG.List: {
        const elementType = this.byte() as TagType;
        const n = this.int();
        return { elementType, items: Array.from({ length: n }, () => ({ type: elementType, value: this.payload(elementType) })) };
      }
      case TAG.Compound: {
        const out: NbtCompound = new Map();
        for (;;) {
          const t = this.byte();
          if (t === TAG.End) return out;
          const name = this.string();
          out.set(name, { type: t as TagType, value: this.payload(t) });
        }
      }
      default:
        throw new Error(`unknown NBT tag type ${type}`);
    }
  }
}

class Writer {
  #chunks: Uint8Array[] = [];
  #size = 0;
  #push(bytes: Uint8Array): void {
    this.#chunks.push(bytes);
    this.#size += bytes.byteLength;
  }
  #num(n: number, set: (v: DataView) => void): void {
    const b = new Uint8Array(n);
    set(new DataView(b.buffer));
    this.#push(b);
  }
  byte(v: number): void {
    this.#num(1, (d) => d.setInt8(0, v));
  }
  int(v: number): void {
    this.#num(4, (d) => d.setInt32(0, v, true));
  }
  long(v: bigint): void {
    this.#num(8, (d) => d.setBigInt64(0, v, true));
  }
  string(s: string): void {
    const b = new TextEncoder().encode(s);
    this.#num(2, (d) => d.setUint16(0, b.byteLength, true));
    this.#push(b);
  }
  payload(type: TagType, v: NbtValue): void {
    switch (type) {
      case TAG.Byte:
        return this.byte(v as number);
      case TAG.Short:
        return this.#num(2, (d) => d.setInt16(0, v as number, true));
      case TAG.Int:
        return this.int(v as number);
      case TAG.Long:
        return this.long(v as bigint);
      case TAG.Float:
        return this.#num(4, (d) => d.setFloat32(0, v as number, true));
      case TAG.Double:
        return this.#num(8, (d) => d.setFloat64(0, v as number, true));
      case TAG.String:
        return this.string(v as string);
      case TAG.ByteArray: {
        const b = v as Uint8Array;
        this.int(b.byteLength);
        return this.#push(b);
      }
      case TAG.IntArray:
        this.int((v as number[]).length);
        for (const x of v as number[]) this.int(x);
        return;
      case TAG.LongArray:
        this.int((v as bigint[]).length);
        for (const x of v as bigint[]) this.long(x);
        return;
      case TAG.List: {
        const list = v as NbtList;
        this.byte(list.elementType);
        this.int(list.items.length);
        for (const item of list.items) this.payload(list.elementType, item.value);
        return;
      }
      case TAG.Compound:
        for (const [name, tag] of v as NbtCompound) {
          this.byte(tag.type);
          this.string(name);
          this.payload(tag.type, tag.value);
        }
        return this.byte(TAG.End);
      default:
        throw new Error(`unknown NBT tag type ${String(type)}`);
    }
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.#size);
    let at = 0;
    for (const c of this.#chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

/** A numeric tag's value as a number (a long too), or undefined for a missing or non-numeric tag. */
export function tagNumber(tag: NbtTag | undefined): number | undefined {
  if (!tag) return undefined;
  if (typeof tag.value === "number") return tag.value;
  if (typeof tag.value === "bigint") return Number(tag.value);
  return undefined;
}

export function readLevelDat(data: Uint8Array): LevelDat {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const storageVersion = view.getInt32(0, true);
  const r = new Reader(data.subarray(8));
  const type = r.byte();
  if (type !== TAG.Compound) throw new Error(`level.dat root is tag ${type}, expected compound`);
  const rootName = r.string();
  return { storageVersion, rootName, root: r.payload(type) as NbtCompound };
}

export function writeLevelDat(level: LevelDat): Uint8Array {
  const w = new Writer();
  w.byte(TAG.Compound);
  w.string(level.rootName);
  w.payload(TAG.Compound, level.root);
  const body = w.bytes();
  const out = new Uint8Array(8 + body.byteLength);
  const view = new DataView(out.buffer);
  view.setInt32(0, level.storageVersion, true);
  view.setInt32(4, body.byteLength, true);
  out.set(body, 8);
  return out;
}

/**
 * Turn on experiments in a level.dat root (`gametest` = Beta APIs). The game also needs `experiments_ever_used`
 * and `saved_with_toggled_experiments` set, or it resets the toggles on load.
 */
export function enableExperiments(root: NbtCompound, names: readonly string[]): void {
  const existing = root.get("experiments");
  const exp: NbtCompound = existing?.type === TAG.Compound ? (existing.value as NbtCompound) : new Map();
  for (const name of names) exp.set(name, { type: TAG.Byte, value: 1 });
  exp.set("experiments_ever_used", { type: TAG.Byte, value: 1 });
  exp.set("saved_with_toggled_experiments", { type: TAG.Byte, value: 1 });
  root.set("experiments", { type: TAG.Compound, value: exp });
}
