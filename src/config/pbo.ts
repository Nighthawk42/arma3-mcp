/**
 * Reader for Bohemia's PBO archive format.
 *
 * Layout:
 *   [version entry]      filename "", packing 'Vers', then asciiz key/value
 *                        property pairs terminated by an empty key
 *   [file entries]       one per file, terminated by an entry with no filename
 *   [file data]          concatenated, in entry order
 *   [0x00][sha1]         20-byte trailing checksum
 *
 * Each entry is: asciiz filename, u32 packingMethod, u32 originalSize,
 * u32 reserved, u32 timestamp, u32 dataSize.
 *
 * We only ever read; nothing here writes PBOs.
 */
import fs from "node:fs";

const MAGIC_VERSION = 0x56657273; // 'Vers'
const MAGIC_COMPRESSED = 0x43707273; // 'Cprs'
const MAGIC_ENCRYPTED = 0x456e6372; // 'Encr'

export interface PboEntry {
  /** Path inside the archive, using backslashes as stored. */
  name: string;
  packingMethod: number;
  originalSize: number;
  dataSize: number;
  /** Absolute offset of this entry's bytes within the file. */
  offset: number;
}

export interface Pbo {
  /** Properties from the version header — `prefix` is the addon's path root. */
  properties: Record<string, string>;
  entries: PboEntry[];
}

class Cursor {
  constructor(
    private readonly buf: Buffer,
    public pos = 0,
  ) {}

  u32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  /** Null-terminated string. */
  asciiz(): string {
    const end = this.buf.indexOf(0, this.pos);
    if (end === -1) throw new Error("unterminated string in PBO header");
    const s = this.buf.toString("utf8", this.pos, end);
    this.pos = end + 1;
    return s;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }
}

export function readPboHeader(buf: Buffer): Pbo {
  const c = new Cursor(buf);
  const properties: Record<string, string> = {};
  const entries: PboEntry[] = [];

  let first = true;
  for (;;) {
    if (c.eof) throw new Error("truncated PBO header");
    const name = c.asciiz();
    const packingMethod = c.u32();
    const originalSize = c.u32();
    c.u32(); // reserved
    c.u32(); // timestamp
    const dataSize = c.u32();

    if (first && name === "" && packingMethod === MAGIC_VERSION) {
      // Version header: asciiz key/value pairs until an empty key.
      for (;;) {
        const key = c.asciiz();
        if (key === "") break;
        properties[key] = c.asciiz();
      }
      first = false;
      continue;
    }
    first = false;

    // A nameless entry with no data terminates the header block.
    if (name === "" && dataSize === 0) break;

    entries.push({ name, packingMethod, originalSize, dataSize, offset: 0 });
  }

  // Data follows the header, concatenated in entry order.
  let offset = c.pos;
  for (const e of entries) {
    e.offset = offset;
    offset += e.dataSize;
  }

  return { properties, entries };
}

/**
 * BI's LZSS variant, used when packingMethod is 'Cprs'.
 *
 * Flag byte, LSB first: a set bit means one literal byte follows; a clear bit
 * means a 2-byte back-reference — a 12-bit value and a 4-bit length biased
 * by 3.
 *
 * The 12-bit value is a **distance back from the current output position**,
 * and history is read straight out of the output buffer. This is the part that
 * differs from textbook LZSS, which keeps a separate 4096-byte ring buffer
 * pre-filled with spaces and treats the field as an absolute index into it.
 * Decoding BI's data that way appears to work — the first bytes of a file are
 * literals either way — and then silently corrupts everything downstream:
 * `EditorCategory` comes out as `EditorCategorirCa`.
 *
 * Verified by brute-forcing the variants against a real compressed config and
 * checking which one produced a config that actually parses.
 *
 * References before the start of the output resolve to zero, matching an
 * encoder whose history begins empty.
 */
export function decompressLzss(src: Buffer, expectedSize: number): Buffer {
  const out = Buffer.alloc(expectedSize);
  let outPos = 0;
  let srcPos = 0;

  while (outPos < expectedSize && srcPos < src.length) {
    const flags = src[srcPos++];
    for (let bit = 0; bit < 8 && outPos < expectedSize; bit++) {
      if (flags & (1 << bit)) {
        if (srcPos >= src.length) break;
        out[outPos++] = src[srcPos++];
      } else {
        if (srcPos + 1 >= src.length) break;
        const b1 = src[srcPos++];
        const b2 = src[srcPos++];
        const distance = (b1 | ((b2 & 0xf0) << 4)) & 0xfff;
        const length = (b2 & 0x0f) + 3;
        for (let i = 0; i < length && outPos < expectedSize; i++) {
          const from = outPos - distance;
          out[outPos++] = from >= 0 ? out[from] : 0x00;
        }
      }
    }
  }
  return out;
}

/** Decode one entry's already-read bytes. */
export function readEntryBuffer(raw: Buffer, entry: PboEntry): Buffer {
  if (entry.packingMethod === MAGIC_ENCRYPTED) {
    throw new Error(`encrypted PBO entry: ${entry.name}`);
  }
  if (entry.packingMethod === MAGIC_COMPRESSED && entry.originalSize !== entry.dataSize) {
    return decompressLzss(raw, entry.originalSize);
  }
  return raw;
}

/** Decode one entry from a buffer holding the whole archive. */
export function readEntryData(buf: Buffer, entry: PboEntry): Buffer {
  return readEntryBuffer(buf.subarray(entry.offset, entry.offset + entry.dataSize), entry);
}

export interface ExtractedFile {
  name: string;
  data: Buffer;
}

/**
 * Read a PBO from disk and return the entries whose names match `predicate`.
 *
 * Deliberately seek-based rather than loading the file: addon PBOs reach
 * several hundred MB (rhs_2s1.pbo is ~247MB) while the config members we want
 * are a few KB. Scanning a full mod set by slurping would move hundreds of
 * gigabytes to read a few megabytes of configs.
 */
export function extractFromPbo(
  file: string,
  predicate: (name: string) => boolean,
): { properties: Record<string, string>; files: ExtractedFile[] } {
  const fd = fs.openSync(file, "r");
  try {
    // The entry table sits at the front; grow the window until it parses.
    let windowSize = 64 * 1024;
    const fileSize = fs.fstatSync(fd).size;
    let pbo: Pbo | undefined;
    for (;;) {
      const size = Math.min(windowSize, fileSize);
      const head = Buffer.alloc(size);
      fs.readSync(fd, head, 0, size, 0);
      try {
        pbo = readPboHeader(head);
        break;
      } catch (e) {
        if (size >= fileSize) throw e;
        windowSize *= 4;
      }
    }

    const files: ExtractedFile[] = [];
    for (const entry of pbo.entries) {
      if (!predicate(entry.name) || entry.dataSize === 0) continue;
      if (entry.offset + entry.dataSize > fileSize) continue;
      try {
        const raw = Buffer.alloc(entry.dataSize);
        fs.readSync(fd, raw, 0, entry.dataSize, entry.offset);
        files.push({ name: entry.name, data: readEntryBuffer(raw, entry) });
      } catch {
        // Skip unreadable members rather than losing the rest of the archive.
      }
    }
    return { properties: pbo.properties, files };
  } finally {
    fs.closeSync(fd);
  }
}
