/**
 * The local index: one SQLite file holding the wiki corpus, the classname
 * corpus, an FTS5 lexical index over both, and a sqlite-vec vector index over
 * the wiki prose.
 *
 * Why hybrid rather than pure vector search: most queries here are for exact
 * identifiers (`setPosATL`, `rhs_2s1_tv`), and `setPos`/`setPosATL`/`setPosASL`
 * embed almost identically — semantic search actively confuses them. Lexical
 * matching settles those, and embeddings handle "how do I make a unit walk to a
 * marker". Results are fused with Reciprocal Rank Fusion.
 *
 * Note on binding: sqlite-vec rejects a plain JS number as a vec0 rowid, so
 * every rowid crossing that boundary is passed as a BigInt.
 */
import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Entry } from "../types.js";
import type { ClassEntry } from "../config/classes.js";
import { EMBEDDING_DIMS } from "./embed.js";

export interface SearchHit {
  kind: "entry" | "class";
  id: number;
  score: number;
  /** Which retrieval arms found it, for transparency in tool output. */
  matched: string[];
}

export function openDatabase(file: string, readonly = false): Db {
  const db = new Database(file, { readonly });
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  return db;
}

export function createSchema(db: Db): void {
  db.exec(`
    drop table if exists entries;
    drop table if exists classes;
    drop table if exists entries_fts;
    drop table if exists classes_fts;
    drop table if exists entries_vec;
    drop table if exists meta;

    create table meta (key text primary key, value text);

    create table entries (
      id        integer primary key,
      name      text not null,
      title     text not null,
      type      text not null,
      games     text not null,   -- json array of {game, since}
      groups    text not null,   -- json array
      data      text not null,   -- full Entry as json
      url       text not null
    );
    create index entries_name on entries(name collate nocase);
    create index entries_type on entries(type);

    create table classes (
      id           integer primary key,
      name         text not null,
      root         text not null,
      parent       text not null,
      displayName  text,
      scope        integer,
      mod          text not null,
      addon        text not null,
      data         text not null   -- full ClassEntry as json
    );
    create index classes_name on classes(name collate nocase);
    create index classes_mod on classes(mod);
    create index classes_root on classes(root);
    -- Subclass walks ("everything inheriting Tank_F") follow parent links
    -- breadth-first, so the parent column needs its own index.
    create index classes_parent on classes(parent collate nocase);

    -- Lexical arm. Porter stemming so "spawning" finds "spawn"; rowid is kept
    -- in step with the entries/classes tables so fusion can join on it.
    create virtual table entries_fts using fts5(name, body, tokenize='porter unicode61');
    create virtual table classes_fts using fts5(name, body, tokenize='porter unicode61');

    -- Example code is indexed separately so "show me code that uses addAction"
    -- searches the samples themselves rather than the surrounding prose.
    create table examples (
      id       integer primary key,
      entry_id integer not null,
      code     text not null
    );
    create index examples_entry on examples(entry_id);
    create virtual table examples_fts using fts5(code, tokenize='unicode61');
  `);
  db.exec(`create virtual table entries_vec using vec0(embedding float[${EMBEDDING_DIMS}])`);
}

/**
 * Split an identifier into its constituent words.
 *
 * Names carry meaning that neither the description nor a prefix match can
 * reach: "BIS_fnc_arrayShuffle" is the obvious answer to "shuffle an array",
 * but its documentation only ever says "randomized order", so nothing matches
 * the word the user actually typed. Indexing the name's words alongside the
 * prose fixes that.
 */
export function splitIdentifier(name: string): string {
  return name
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text an entry is searched by — signature and prose, not raw wikitext. */
export function entryText(entry: Entry): string {
  const params = entry.syntaxes.flatMap((s) => s.params.map((p) => `${p.name ?? ""} ${p.types.join(" ")} ${p.description}`));
  return [
    entry.name,
    splitIdentifier(entry.name),
    entry.title,
    entry.groups.join(" "),
    entry.description,
    entry.syntaxes.map((s) => s.signature).join(" \n"),
    params.join(" \n"),
    entry.multiplayer ?? "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

export function classText(cls: ClassEntry): string {
  return [
    cls.name,
    splitIdentifier(cls.name),
    cls.displayName ?? "",
    cls.root,
    cls.parent,
    cls.mod,
    cls.faction ?? "",
    cls.ancestors.slice(0, 4).join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Escape a user query for FTS5 MATCH — quote every token, drop operators. */
export function ftsQuery(query: string): string {
  const tokens = query.match(/[A-Za-z0-9_]+/g) ?? [];
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Weighted Reciprocal Rank Fusion.
 *
 * Each arm contributes `weight / (k + rank)`. k=60 is the usual constant; it
 * damps the head so a single arm's top hit cannot dominate a result the other
 * arms disagree with.
 *
 * Weights matter because the arms are not equally precise. FTS over a query
 * like "T-72" matches on the bare token "72", which pulls in every unrelated
 * "OZM-72"; a literal match on the name or display string is far stronger
 * evidence. With equal weights the noisy arm wins on volume alone.
 */
export function fuse(
  arms: Array<{ name: string; ids: number[]; weight?: number }>,
  k = 60,
): Map<number, { score: number; matched: string[] }> {
  const scores = new Map<number, { score: number; matched: string[] }>();
  for (const arm of arms) {
    const weight = arm.weight ?? 1;
    arm.ids.forEach((id, rank) => {
      const existing = scores.get(id) ?? { score: 0, matched: [] };
      existing.score += weight / (k + rank + 1);
      existing.matched.push(arm.name);
      scores.set(id, existing);
    });
  }
  return scores;
}
