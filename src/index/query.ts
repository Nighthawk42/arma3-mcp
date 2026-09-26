/**
 * Read-side queries against the local index. No network, ever.
 */
import type { Db } from "./store.js";
import type { Entry } from "../types.js";
import type { GameId } from "../games.js";
import type { ClassEntry } from "../config/classes.js";
import { ftsQuery, fuse } from "./store.js";
import { embed, toBlob } from "./embed.js";

export interface EntryFilters {
  game?: GameId;
  type?: Entry["type"];
  limit?: number;
}

const parseEntry = (row: { data: string }): Entry => JSON.parse(row.data) as Entry;
const parseClass = (row: { data: string }): ClassEntry => JSON.parse(row.data) as ClassEntry;

/** Exact identifier lookup — case-insensitive, the way SQF resolves names. */
export function getEntryByName(db: Db, name: string, type?: Entry["type"]): Entry | undefined {
  const row = db
    .prepare(
      `select data from entries where name = ? collate nocase ${type ? "and type = ?" : ""} limit 1`,
    )
    .get(...(type ? [name, type] : [name])) as { data: string } | undefined;
  return row ? parseEntry(row) : undefined;
}

/** Near-miss suggestions for a name that did not resolve. */
export function suggestNames(db: Db, name: string, limit = 8): string[] {
  const rows = db
    .prepare("select name from entries where name like ? collate nocase order by length(name) limit ?")
    .all(`%${name}%`, limit) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Hybrid search over wiki entries.
 *
 * Three arms, fused with RRF: exact/prefix name match, FTS5 lexical, and vector
 * similarity. Filters are applied after fusion so the arms stay comparable.
 */
export async function searchEntries(
  db: Db,
  query: string,
  filters: EntryFilters = {},
): Promise<Array<{ entry: Entry; score: number; matched: string[] }>> {
  const limit = filters.limit ?? 10;
  const pool = Math.max(limit * 8, 60);

  const nameIds = (
    db
      .prepare(
        "select id from entries where name like ? collate nocase order by length(name) limit ?",
      )
      .all(`${query}%`, pool) as Array<{ id: number }>
  ).map((r) => r.id);

  const match = ftsQuery(query);
  const ftsIds = match
    ? (
        db
          .prepare("select rowid as id from entries_fts where entries_fts match ? order by rank limit ?")
          .all(match, pool) as Array<{ id: number }>
      ).map((r) => r.id)
    : [];

  let vecIds: number[] = [];
  try {
    const [vector] = await embed([query]);
    vecIds = (
      db
        .prepare(
          "select rowid as id from entries_vec where embedding match ? order by distance limit ?",
        )
        .all(toBlob(vector), pool) as Array<{ id: number }>
    ).map((r) => r.id);
  } catch {
    // Embedding is optional at query time; lexical arms still answer.
  }

  // Exact identifier lookups dominate real usage, so the name arm leads; the
  // semantic arm exists to answer descriptive questions the others cannot.
  const scores = fuse([
    { name: "name", ids: nameIds, weight: 3 },
    { name: "lexical", ids: ftsIds, weight: 1.5 },
    { name: "semantic", ids: vecIds, weight: 1 },
  ]);

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const out: Array<{ entry: Entry; score: number; matched: string[] }> = [];
  const get = db.prepare("select data from entries where id = ?");
  for (const [id, { score, matched }] of ranked) {
    const row = get.get(id) as { data: string } | undefined;
    if (!row) continue;
    const entry = parseEntry(row);
    if (filters.type && entry.type !== filters.type) continue;
    if (filters.game && !entry.games.some((g) => g.game === filters.game)) continue;
    out.push({ entry, score, matched });
    if (out.length >= limit) break;
  }
  return out;
}

export interface ClassFilters {
  mod?: string;
  root?: string;
  /** Only classes usable in the editor / scripts. */
  publicOnly?: boolean;
  limit?: number;
}

/**
 * Classname search — lexical only, deliberately.
 *
 * Classnames are identifiers: `rhs_2s1_tv` and `rhs_2s1_vmf` are semantically
 * identical to an embedding model but mean different vehicles, so embeddings
 * are the wrong tool here. Three lexical arms instead: substring on the
 * classname, substring on the display name, and FTS over the combined text.
 */
export function searchClasses(
  db: Db,
  query: string,
  filters: ClassFilters = {},
): Array<{ cls: ClassEntry; matched: string[] }> {
  const limit = filters.limit ?? 20;
  const pool = Math.max(limit * 8, 100);

  const nameIds = (
    db
      .prepare("select id from classes where name like ? collate nocase order by length(name) limit ?")
      .all(`%${query}%`, pool) as Array<{ id: number }>
  ).map((r) => r.id);

  // Literal substring match on the display name.
  //
  // FTS tokenisation breaks real-world model designations apart: "T-72" becomes
  // the tokens "t" and "72", which then matches "OZM-72" (an unrelated mine)
  // while missing "T-72B" (whose second token is "72b"). Matching the display
  // string directly is what actually finds a vehicle people name by its model.
  const displayIds = (
    db
      .prepare(
        "select id from classes where displayName like ? collate nocase order by length(displayName) limit ?",
      )
      .all(`%${query}%`, pool) as Array<{ id: number }>
  ).map((r) => r.id);

  const match = ftsQuery(query);
  const ftsIds = match
    ? (
        db
          .prepare("select rowid as id from classes_fts where classes_fts match ? order by rank limit ?")
          .all(match, pool) as Array<{ id: number }>
      ).map((r) => r.id)
    : [];

  // A literal hit on the classname or its display string is much stronger
  // evidence than an FTS token overlap, so the arms are weighted accordingly.
  const scores = fuse([
    { name: "name", ids: nameIds, weight: 3 },
    { name: "display", ids: displayIds, weight: 2 },
    { name: "lexical", ids: ftsIds, weight: 1 },
  ]);

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const out: Array<{ cls: ClassEntry; matched: string[] }> = [];
  const get = db.prepare("select data from classes where id = ?");
  for (const [id, { matched }] of ranked) {
    const row = get.get(id) as { data: string } | undefined;
    if (!row) continue;
    const cls = parseClass(row);
    if (filters.mod && !cls.mod.toLowerCase().includes(filters.mod.toLowerCase())) continue;
    if (filters.root && cls.root.toLowerCase() !== filters.root.toLowerCase()) continue;
    if (filters.publicOnly && (cls.scope ?? 0) < 2) continue;
    out.push({ cls, matched });
    if (out.length >= limit) break;
  }
  return out;
}

export function getClass(db: Db, name: string): ClassEntry[] {
  const rows = db
    .prepare("select data from classes where name = ? collate nocase")
    .all(name) as Array<{ data: string }>;
  return rows.map(parseClass);
}

/** Classes that directly inherit from `name`. */
export function childrenOf(db: Db, name: string, limit = 50): ClassEntry[] {
  const rows = db
    .prepare("select data from classes where parent = ? collate nocase limit ?")
    .all(name, limit) as Array<{ data: string }>;
  return rows.map(parseClass);
}

export function meta(db: Db): Record<string, string> {
  const rows = db.prepare("select key, value from meta").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function countsByGame(db: Db): Map<GameId, number> {
  const rows = db.prepare("select games from entries").all() as Array<{ games: string }>;
  const counts = new Map<GameId, number>();
  for (const row of rows) {
    for (const g of JSON.parse(row.games) as Array<{ game: GameId }>) {
      counts.set(g.game, (counts.get(g.game) ?? 0) + 1);
    }
  }
  return counts;
}

// --- discovery / browsing ---------------------------------------------------

/** Command groups with entry counts, optionally scoped to one game. */
export function listGroups(db: Db, game?: GameId): Array<{ group: string; count: number }> {
  const rows = db.prepare("select groups, games from entries").all() as Array<{
    groups: string;
    games: string;
  }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (game) {
      const games = JSON.parse(row.games) as Array<{ game: GameId }>;
      if (!games.some((g) => g.game === game)) continue;
    }
    for (const g of JSON.parse(row.groups) as string[]) {
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}

/** Entries belonging to a command group. */
export function browseGroup(db: Db, group: string, game?: GameId, limit = 100): Entry[] {
  const rows = db.prepare("select data, groups from entries").all() as Array<{
    data: string;
    groups: string;
  }>;
  const out: Entry[] = [];
  for (const row of rows) {
    const groups = JSON.parse(row.groups) as string[];
    if (!groups.some((g) => g.toLowerCase() === group.toLowerCase())) continue;
    const entry = parseEntry(row);
    if (game && !entry.games.some((g) => g.game === game)) continue;
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Entries introduced in a specific game version.
 *
 * `since` is recorded per game, so this answers "what did Arma 3 2.14 add?"
 * straight from the corpus.
 */
export function addedInVersion(db: Db, game: GameId, version?: string): Entry[] {
  const rows = db.prepare("select data from entries").all() as Array<{ data: string }>;
  const out: Entry[] = [];
  for (const row of rows) {
    const entry = parseEntry(row);
    const g = entry.games.find((x) => x.game === game);
    if (!g || !g.since) continue;
    if (version && g.since !== version) continue;
    out.push(entry);
  }
  return out.sort((a, b) => {
    const av = a.games.find((x) => x.game === game)!.since;
    const bv = b.games.find((x) => x.game === game)!.since;
    return bv.localeCompare(av, undefined, { numeric: true }) || a.name.localeCompare(b.name);
  });
}

/** Distinct versions of a game that introduced something, newest first. */
export function versionsFor(db: Db, game: GameId): Array<{ version: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of addedInVersion(db, game)) {
    const since = entry.games.find((x) => x.game === game)!.since;
    counts.set(since, (counts.get(since) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

/** Search example code specifically, rather than surrounding prose. */
export function searchExamples(
  db: Db,
  query: string,
  limit = 10,
): Array<{ entryName: string; url: string; code: string }> {
  const match = ftsQuery(query);
  if (!match) return [];
  const rows = db
    .prepare(
      `select e.name as name, e.url as url, x.code as code
         from examples_fts f
         join examples x on x.id = f.rowid
         join entries e on e.id = x.entry_id
        where examples_fts match ?
        order by rank limit ?`,
    )
    .all(match, limit) as Array<{ name: string; url: string; code: string }>;
  return rows.map((r) => ({ entryName: r.name, url: r.url, code: r.code }));
}

/** Indexed mods with how many classes each contributes. */
export function listMods(db: Db): Array<{ mod: string; classes: number; publicClasses: number }> {
  const rows = db
    .prepare(
      "select mod, count(*) as n, sum(case when scope >= 2 then 1 else 0 end) as pub from classes group by mod order by n desc",
    )
    .all() as Array<{ mod: string; n: number; pub: number }>;
  return rows.map((r) => ({ mod: r.mod, classes: r.n, publicClasses: r.pub ?? 0 }));
}

/** Config roots present in the index, with counts. */
export function listConfigRoots(db: Db): Array<{ root: string; count: number }> {
  return db
    .prepare("select root, count(*) as count from classes group by root order by count desc")
    .all() as Array<{ root: string; count: number }>;
}

/**
 * Every class descending from `base`, walked breadth-first through parent links.
 *
 * Capped because some base classes (`All`, `Land`) have tens of thousands of
 * descendants and nobody wants that as a tool response.
 */
export function findSubclasses(
  db: Db,
  base: string,
  options: { mod?: string; publicOnly?: boolean; limit?: number } = {},
): { classes: ClassEntry[]; truncated: boolean } {
  const limit = options.limit ?? 50;
  const stmt = db.prepare("select data from classes where parent = ? collate nocase");
  const seen = new Set<string>([base.toLowerCase()]);
  const queue = [base];
  const out: ClassEntry[] = [];
  let truncated = false;

  while (queue.length) {
    const current = queue.shift()!;
    const rows = stmt.all(current) as Array<{ data: string }>;
    for (const row of rows) {
      const cls = parseClass(row);
      const key = cls.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(cls.name);
      if (options.mod && !cls.mod.toLowerCase().includes(options.mod.toLowerCase())) continue;
      if (options.publicOnly && (cls.scope ?? 0) < 2) continue;
      if (out.length >= limit) {
        truncated = true;
        continue;
      }
      out.push(cls);
    }
    if (seen.size > 20000) {
      truncated = true;
      break;
    }
  }
  return { classes: out.sort((a, b) => a.name.localeCompare(b.name)), truncated };
}
