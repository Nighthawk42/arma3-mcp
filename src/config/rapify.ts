/**
 * De-rapifier for binarized Arma configs (`config.bin`).
 *
 * "Rapified" is Bohemia's binary form of config.cpp. Layout:
 *
 *   char   signature[4] = "\0raP"
 *   uint32 version              (0)
 *   uint32 alwaysEight          (8)
 *   uint32 enumOffset
 *   <class body>                -- the root class, at byte 16
 *
 * A class body is:
 *   asciiz         inherited class name
 *   compressed_int entry count
 *   <entry> * count
 *   uint32         trailing offset (ignored — nested bodies are reached by the
 *                  explicit offsets in their entries, so this is never needed)
 *
 * An entry is a type byte followed by type-specific data:
 *   0  nested class     asciiz name, uint32 offset of its body
 *   1  value            uint8 subtype, asciiz name, value
 *   2  array            asciiz name, <array>
 *   3  extern class     asciiz name              (forward declaration)
 *   4  delete class     asciiz name
 *   5  array append     uint32 flags, asciiz name, <array>
 *
 * Value subtypes: 0 string (asciiz), 1 float (f32), 2 int (i32).
 * Arrays are a compressed_int count then elements, each a type byte and value,
 * where type 3 is a nested array.
 *
 * Some addons ship plain-text config.cpp instead; callers should check
 * `isRapified` and fall back to the text parser.
 */

export type ConfigValue = string | number | ConfigValue[];

export interface ConfigClass {
  name: string;
  /** Class this one inherits from, empty when it inherits nothing. */
  parent: string;
  properties: Map<string, ConfigValue>;
  classes: Map<string, ConfigClass>;
}

const SIGNATURE = Buffer.from([0x00, 0x72, 0x61, 0x50]); // "\0raP"

export function isRapified(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(SIGNATURE);
}

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  u8(): number {
    return this.buf[this.pos++];
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i32(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  f32(): number {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }
  /** 64-bit ints are returned as Number; Arma's values stay well inside 2^53. */
  i64(): number {
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return Number(v);
  }
  asciiz(): string {
    const end = this.buf.indexOf(0, this.pos);
    if (end === -1) throw new Error("unterminated string in rapified config");
    const s = this.buf.toString("utf8", this.pos, end);
    this.pos = end + 1;
    return s;
  }
  /** 7 bits per byte, high bit signals continuation. */
  compressedInt(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 28) throw new Error("compressed int too long");
    }
  }
}

/**
 * Read a scalar value of the given subtype.
 *
 * 0 string, 1 float, 2 int32, 6 int64. Subtype 6 is uncommon but load-bearing:
 * the base game stores `transportRepair`/`transportFuel`/`transportAmmo` as
 * 1e12, which does not fit in int32. Treating it as anything narrower desyncs
 * the stream and corrupts the rest of the file.
 */
function readValue(r: Reader, subtype: number): ConfigValue {
  switch (subtype) {
    case 0:
      return r.asciiz();
    case 1:
      return r.f32();
    case 2:
      return r.i32();
    case 6:
      return r.i64();
    default:
      throw new Error(`unknown value subtype ${subtype} at ${r.pos}`);
  }
}

function readArray(r: Reader): ConfigValue[] {
  const count = r.compressedInt();
  const out: ConfigValue[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.u8();
    switch (type) {
      case 0:
        out.push(r.asciiz());
        break;
      case 1:
        out.push(r.f32());
        break;
      case 2:
        out.push(r.i32());
        break;
      case 3:
        out.push(readArray(r));
        break;
      case 6:
        out.push(r.i64());
        break;
      default:
        throw new Error(`unknown array element type ${type}`);
    }
  }
  return out;
}

function readClassBody(r: Reader, name: string, depth: number): ConfigClass {
  if (depth > 64) throw new Error("class nesting too deep");
  const parent = r.asciiz();
  const count = r.compressedInt();
  const cls: ConfigClass = { name, parent, properties: new Map(), classes: new Map() };

  // Nested class bodies live elsewhere in the file; collect the jumps and
  // follow them after this body's entry list is fully read.
  const nested: Array<{ name: string; offset: number }> = [];

  for (let i = 0; i < count; i++) {
    const type = r.u8();
    switch (type) {
      case 0: {
        const childName = r.asciiz();
        nested.push({ name: childName, offset: r.u32() });
        break;
      }
      case 1: {
        const subtype = r.u8();
        const key = r.asciiz();
        cls.properties.set(key, readValue(r, subtype));
        break;
      }
      case 2: {
        const key = r.asciiz();
        cls.properties.set(key, readArray(r));
        break;
      }
      case 3:
      case 4: {
        r.asciiz(); // extern / delete declaration — no body to read
        break;
      }
      case 5: {
        r.u32(); // flags
        const key = r.asciiz();
        cls.properties.set(key, readArray(r));
        break;
      }
      default:
        throw new Error(`unknown class entry type ${type} at ${r.pos}`);
    }
  }

  for (const child of nested) {
    const saved = r.pos;
    r.pos = child.offset;
    try {
      cls.classes.set(child.name.toLowerCase(), readClassBody(r, child.name, depth + 1));
    } finally {
      r.pos = saved;
    }
  }

  return cls;
}

export function derapify(buf: Buffer): ConfigClass {
  if (!isRapified(buf)) throw new Error("not a rapified config");
  const r = new Reader(buf);
  r.pos = 4;
  r.u32(); // version (0)
  r.u32(); // always 8
  r.u32(); // offset of the enum table
  // The root class body begins immediately after this 16-byte header.
  return readClassBody(r, "", 0);
}

/** Case-insensitive child lookup — config class names are not case sensitive. */
export function child(cls: ConfigClass, name: string): ConfigClass | undefined {
  return cls.classes.get(name.toLowerCase());
}

export function propString(cls: ConfigClass, key: string): string | undefined {
  for (const [k, v] of cls.properties) {
    if (k.toLowerCase() === key.toLowerCase()) return typeof v === "string" ? v : String(v);
  }
  return undefined;
}

export function propNumber(cls: ConfigClass, key: string): number | undefined {
  for (const [k, v] of cls.properties) {
    if (k.toLowerCase() === key.toLowerCase()) {
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      }
    }
  }
  return undefined;
}
