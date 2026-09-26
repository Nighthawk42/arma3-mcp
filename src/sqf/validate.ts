/**
 * Lint an SQF snippet against the indexed corpus.
 *
 * This is not a parser and does not try to be: it tokenises identifiers,
 * ignoring strings and comments, and asks the corpus what it knows about each
 * one. That is enough to catch the mistakes that actually cost people time:
 *
 * - a command that does not exist (usually a typo or a half-remembered name)
 * - a command that exists but not in the game being targeted
 * - a command with global effect used without the author realising it
 * - a command deprecated in favour of another
 *
 * Anything it cannot classify is reported as unknown rather than as an error,
 * because SQF is full of local variables and mod-supplied functions that are
 * perfectly valid and will never be in the wiki.
 */
import type { Db } from "../index/store.js";
import type { Entry } from "../types.js";
import type { GameId } from "../games.js";
import { GAMES } from "../games.js";

export interface Finding {
  severity: "error" | "warning" | "info";
  identifier: string;
  line: number;
  message: string;
}

export interface ValidateResult {
  findings: Finding[];
  /** Identifiers matched to corpus entries, for context. */
  recognised: string[];
  /** Identifiers we have nothing on — locals, mod functions, typos. */
  unrecognised: string[];
}

/**
 * Strip strings and comments so their contents are never linted.
 *
 * Replaced with spaces rather than removed, so line numbers stay correct.
 */
export function stripNonCode(source: string): string {
  let out = "";
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === quote && source[j + 1] === quote) {
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        j++;
      }
      out += blank(source.slice(i, Math.min(j + 1, source.length)));
      i = j + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** SQF keywords and literals that are not commands and need no lookup. */
const NON_COMMANDS = new Set([
  "if", "then", "else", "for", "from", "to", "step", "do", "while", "switch",
  "case", "default", "with", "try", "catch", "throw", "exitwith", "private",
  "true", "false", "nil", "and", "or", "not", "params", "isnil",
]);

export interface ValidateOptions {
  /** Target game; availability is checked against it when given. */
  game?: GameId;
  /**
   * Target version of that game, e.g. "2.10". Commands introduced later are
   * errors. Without it, only commands added after the game's first release are
   * mentioned, as info — "requires Arma 3 0.50" on every command is noise.
   */
  gameVersion?: string;
  /** Warn about commands whose effect is global (multiplayer footgun). */
  flagGlobalEffects?: boolean;
}

/** Compares wiki version strings numerically: "2.08" < "2.10" < "2.14". */
export function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

const baselines = new WeakMap<Db, Map<GameId, string>>();

/** Each game's earliest documented version — its release, as far as the wiki is concerned. */
function releaseVersions(db: Db): Map<GameId, string> {
  let cached = baselines.get(db);
  if (!cached) {
    cached = new Map();
    for (const row of db.prepare("select games from entries").all() as Array<{ games: string }>) {
      for (const g of JSON.parse(row.games) as Array<{ game: GameId; since: string }>) {
        const current = cached.get(g.game);
        if (g.since && (!current || compareVersions(g.since, current) < 0)) cached.set(g.game, g.since);
      }
    }
    baselines.set(db, cached);
  }
  return cached;
}

export function validateSqf(
  db: Db,
  source: string,
  options: ValidateOptions = {},
): ValidateResult {
  const code = stripNonCode(source);
  const lines = code.split("\n");

  const lookup = db.prepare(
    "select data from entries where name = ? collate nocase limit 1",
  );

  const findings: Finding[] = [];
  const recognised = new Set<string>();
  const unrecognised = new Set<string>();
  const reported = new Set<string>();

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const token = m[0];
      const lower = token.toLowerCase();
      if (NON_COMMANDS.has(lower)) continue;
      // Local variables are conventionally underscore-prefixed.
      if (token.startsWith("_")) continue;

      const row = lookup.get(token) as { data: string } | undefined;
      if (!row) {
        unrecognised.add(token);
        continue;
      }
      const entry: Entry = JSON.parse(row.data);
      recognised.add(entry.name);

      // Report each distinct issue once, not once per occurrence.
      const key = `${entry.name}:availability`;
      if (options.game && !entry.games.some((g) => g.game === options.game) && !reported.has(key)) {
        reported.add(key);
        const available = entry.games.map((g) => GAMES[g.game].name).join(", ");
        findings.push({
          severity: "error",
          identifier: entry.name,
          line: lineNo,
          message: `not available in ${GAMES[options.game].name} — exists in: ${available || "no indexed game"}`,
        });
      }

      const since = entry.games.find((g) => g.game === options.game)?.since;
      if (options.game && since && !reported.has(`${entry.name}:since`)) {
        const gameName = GAMES[options.game].name;
        if (options.gameVersion) {
          if (compareVersions(since, options.gameVersion) > 0) {
            reported.add(`${entry.name}:since`);
            findings.push({
              severity: "error",
              identifier: entry.name,
              line: lineNo,
              message: `introduced in ${gameName} ${since}; target is ${options.gameVersion}`,
            });
          }
        } else {
          const release = releaseVersions(db).get(options.game);
          if (release && compareVersions(since, release) > 0) {
            reported.add(`${entry.name}:since`);
            findings.push({
              severity: "info",
              identifier: entry.name,
              line: lineNo,
              message: `added in ${gameName} ${since} (pass gameVersion to check against your target)`,
            });
          }
        }
      }

      if (
        options.flagGlobalEffects !== false &&
        entry.locality?.effect?.toLowerCase() === "global" &&
        !reported.has(`${entry.name}:locality`)
      ) {
        reported.add(`${entry.name}:locality`);
        findings.push({
          severity: "warning",
          identifier: entry.name,
          line: lineNo,
          message: "has a global effect — in multiplayer it applies on every machine, so calling it on all clients duplicates the effect",
        });
      }

      if (/deprecated/i.test(entry.description) && !reported.has(`${entry.name}:deprecated`)) {
        reported.add(`${entry.name}:deprecated`);
        findings.push({
          severity: "warning",
          identifier: entry.name,
          line: lineNo,
          message: "documented as deprecated — check the wiki page for the replacement",
        });
      }
    }
  });

  findings.sort((a, b) => a.line - b.line || a.identifier.localeCompare(b.identifier));
  return {
    findings,
    recognised: [...recognised].sort(),
    unrecognised: [...unrecognised].sort(),
  };
}
