import type { GameId } from "./games.js";

export type EntryType = "command" | "function" | "eventhandler" | "article";

/** A game this entry exists in, plus the version of that game that introduced it. */
export interface GameAvailability {
  game: GameId;
  /** Version string as written on the wiki, e.g. "1.50", "0.50". */
  since: string;
}

export interface Param {
  /** Raw wiki key, e.g. "p1" or "p21" — kept for traceability back to the page. */
  key: string;
  /** Parameter name as documented, e.g. "targets". */
  name?: string;
  /** Documented type names, e.g. ["Object", "String"]. */
  types: string[];
  description: string;
  optional: boolean;
  /** Documented default, when the wiki states one. */
  default?: string;
}

export interface Returns {
  types: string[];
  description: string;
}

export interface Syntax {
  /** 1-based syntax number, matching the wiki's sN key. */
  index: number;
  /** The signature line, e.g. "params remoteExec [order, targets, JIP]". */
  signature: string;
  params: Param[];
  returns?: Returns;
  /**
   * Games this particular syntax applies to.
   *
   * Pages routinely carry more than one {{RV}} block — one per engine
   * generation — because the signature genuinely differs between them
   * (addAction has an OFP-era block and a separate Arma 3 block). Tagging each
   * syntax with its block's games keeps that distinction instead of flattening
   * incompatible signatures together.
   */
  games: GameId[];
}

export interface Example {
  index: number;
  code: string;
}

/** Argument / effect locality — critical for multiplayer scripting. */
export interface Locality {
  argument?: string;
  effect?: string;
}

export interface Entry {
  /** Stable slug derived from the page title. */
  id: string;
  /** Wiki page title, with spaces as MediaWiki stores them ("diag log"). */
  title: string;
  /**
   * The identifier as written in SQF ("diag_log", "BIS_fnc_spawnGroup").
   *
   * MediaWiki normalises underscores to spaces in titles, which would otherwise
   * hand callers names that do not exist in the language. Operator pages
   * ("! a", "a + b") have no identifier form and keep their title here.
   */
  name: string;
  type: EntryType;
  /** Sorted by release order; empty means the page declared no game tags. */
  games: GameAvailability[];
  /** Wiki command groups, e.g. ["Multiplayer"]. */
  groups: string[];
  description: string;
  syntaxes: Syntax[];
  examples: Example[];
  seeAlso: string[];
  locality?: Locality;
  /** Multiplayer behaviour notes (`mp=`). */
  multiplayer?: string;
  /** Known issues (`pr=`). */
  problems?: string;
  url: string;
  revision: { id: number; timestamp: string };
}

export interface Corpus {
  /** Schema version — bump when Entry changes shape so stale indexes rebuild. */
  schema: number;
  /** ISO timestamp of the ingest run that produced this corpus. */
  generatedAt: string;
  /** Newest revision timestamp seen, used as the incremental-update watermark. */
  watermark: string;
  source: { wiki: string; api: string };
  entries: Entry[];
}

export const CORPUS_SCHEMA = 1;
