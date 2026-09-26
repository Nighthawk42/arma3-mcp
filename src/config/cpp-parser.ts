/**
 * Parser for unbinarised `config.cpp`.
 *
 * ~7% of addons ship their config as text rather than rapified binary, so
 * without this their classnames are simply missing from the index. The grammar
 * we need is small:
 *
 *   class Name : Parent { ... };     // definition
 *   class Name;                      // forward declaration
 *   property = value;                // scalar
 *   property[] = { a, b, {c, d} };   // array
 *   #include "..."  #define X        // preprocessor — skipped
 *   // line and slash-star comments
 *
 * Deliberately tolerant: the goal is to recover class structure and the few
 * attributes we index, not to validate the file. Anything unparseable is
 * skipped rather than aborting, because one odd macro should not cost us a
 * whole addon's classnames.
 *
 * Macros are *not* expanded. A class whose name comes from a macro is skipped;
 * that is a known limit, and preferable to emitting a classname that does not
 * exist in game.
 */
import type { ConfigClass, ConfigValue } from "./rapify.js";

/** Strip comments and preprocessor lines, preserving string literals. */
export function preprocess(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    // String literal — copy verbatim, honouring doubled "" escapes.
    if (c === '"') {
      out += c;
      i++;
      while (i < source.length) {
        out += source[i];
        if (source[i] === '"' && source[i + 1] !== '"') {
          i++;
          break;
        }
        if (source[i] === '"' && source[i + 1] === '"') {
          out += source[i + 1];
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    // Preprocessor directive: drop the logical line, honouring continuations.
    if (c === "#" && (i === 0 || /[\n\r]/.test(source[i - 1]))) {
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "\n") break;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

class TextReader {
  pos = 0;
  constructor(readonly src: string) {}

  skipSpace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  ident(): string | null {
    this.skipSpace();
    IDENT.lastIndex = this.pos;
    const m = IDENT.exec(this.src);
    if (!m) return null;
    this.pos = IDENT.lastIndex;
    return m[0];
  }

  /** Consume `expected` if present. */
  eat(expected: string): boolean {
    this.skipSpace();
    if (this.src.startsWith(expected, this.pos)) {
      this.pos += expected.length;
      return true;
    }
    return false;
  }

  peek(): string {
    this.skipSpace();
    return this.src[this.pos] ?? "";
  }
}

function parseString(r: TextReader): string {
  // Assumes the opening quote is next.
  r.skipSpace();
  r.pos++;
  let out = "";
  while (r.pos < r.src.length) {
    if (r.src[r.pos] === '"') {
      if (r.src[r.pos + 1] === '"') {
        out += '"';
        r.pos += 2;
        continue;
      }
      r.pos++;
      break;
    }
    out += r.src[r.pos++];
  }
  return out;
}

function parseValue(r: TextReader): ConfigValue {
  r.skipSpace();
  const c = r.peek();
  if (c === '"') return parseString(r);
  if (c === "{") return parseArray(r);

  // Bare token up to the terminator. Covers numbers, macro calls and
  // concatenated strings; kept as text when it is not cleanly numeric.
  const start = r.pos;
  let depth = 0;
  while (r.pos < r.src.length) {
    const ch = r.src[r.pos];
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && (ch === ";" || ch === "," || ch === "}")) break;
    r.pos++;
  }
  const raw = r.src.slice(start, r.pos).trim();
  const num = Number(raw);
  return raw !== "" && Number.isFinite(num) ? num : raw;
}

function parseArray(r: TextReader): ConfigValue[] {
  r.eat("{");
  const out: ConfigValue[] = [];
  for (;;) {
    r.skipSpace();
    if (r.eat("}")) break;
    if (r.pos >= r.src.length) break;
    if (r.eat(",")) continue;
    out.push(parseValue(r));
  }
  return out;
}

function parseBody(r: TextReader, cls: ConfigClass, depth: number): void {
  if (depth > 64) return;
  for (;;) {
    r.skipSpace();
    if (r.pos >= r.src.length) return;
    if (r.eat("}")) {
      r.eat(";");
      return;
    }
    if (r.eat(";")) continue;

    const word = r.ident();
    if (word === null) {
      r.pos++; // unrecognised character — step over it and keep going
      continue;
    }

    if (word === "class") {
      const name = r.ident();
      if (name === null) continue;
      let parent = "";
      if (r.eat(":")) parent = r.ident() ?? "";
      if (r.eat("{")) {
        const child: ConfigClass = { name, parent, properties: new Map(), classes: new Map() };
        parseBody(r, child, depth + 1);
        cls.classes.set(name.toLowerCase(), child);
      } else {
        r.eat(";"); // forward declaration — nothing to record
      }
      continue;
    }

    if (word === "delete" || word === "import") {
      r.ident();
      r.eat(";");
      continue;
    }

    // property = value;  or  property[] = {...};
    const isArray = r.eat("[]");
    if (!r.eat("=")) {
      // Something we do not model (e.g. a bare macro invocation); skip to `;`.
      while (r.pos < r.src.length && r.src[r.pos] !== ";" && r.src[r.pos] !== "}") r.pos++;
      r.eat(";");
      continue;
    }
    const value = isArray ? parseArray(r) : parseValue(r);
    cls.properties.set(word, value);
    r.eat(";");
  }
}

/** Parse a text config into the same shape `derapify` returns. */
export function parseConfigCpp(source: string): ConfigClass {
  const r = new TextReader(preprocess(source));
  const root: ConfigClass = { name: "", parent: "", properties: new Map(), classes: new Map() };
  // The root has no braces of its own; read entries until input is exhausted.
  for (;;) {
    const before = r.pos;
    r.skipSpace();
    if (r.pos >= r.src.length) break;
    parseBody(r, root, 0);
    if (r.pos === before) r.pos++; // guarantee forward progress
  }
  return root;
}
