/**
 * Parser for the BI wiki's {{RV}} template — the single template that backs
 * every scripting command, function and event handler page.
 *
 * Shape of the source (abridged, from remoteExec):
 *
 *   {{RV|type=command
 *   |game1= arma3
 *   |version1= 1.50
 *   |gr1= Multiplayer
 *   |descr= Asks the server to execute ...
 *   |s1= params [[remoteExec]] [order, targets, JIP]
 *   |p1= '''params''': [[Anything]] - order's parameter
 *   |r1= [[Anything]]
 *   |x1= <sqf>...</sqf>
 *   |seealso= [[remoteExecCall]]
 *   }}
 *
 * A page may repeat that whole block once per engine generation — addAction
 * carries an OFP-era block and a separate Arma 3 block with a different
 * signature. We parse every block and merge them into one entry, tagging each
 * syntax with the games its block declared.
 */
import type { Entry, Example, Param, Returns, Syntax, EntryType } from "../types.js";
import { resolveGameCode, GAME_IDS, type GameId } from "../games.js";
import { extractAllTemplates, splitTopLevel, toMarkdown, linkTargets } from "./wikitext.js";

export interface ParseResult {
  entry: Entry | null;
  /** Game codes on the page that we neither know nor deliberately exclude. */
  unknownGames: string[];
  /** Non-fatal reason the page produced no entry. */
  skipped?: string;
}

/** Turn a template body into a key -> raw-value map. */
export function parseTemplateParams(body: string): Map<string, string> {
  const params = new Map<string, string>();
  const parts = splitTopLevel(body);
  // parts[0] is the template name ("RV"); every later part is `key= value`.
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!key || /\s/.test(key)) continue; // guard against stray prose
    params.set(key, part.slice(eq + 1).trim());
  }
  return params;
}

/**
 * Parse one documented parameter.
 *
 * The wiki convention is `'''name''': [[Type]] - description`, with optionality
 * expressed as a parenthetical: `(Optional, default 0)`.
 */
export function parseParam(key: string, raw: string): Param {
  let name: string | undefined;
  let rest = raw;

  const named = raw.match(/^\s*'''([^']+)'''\s*:?\s*/) ?? raw.match(/^\s*([A-Za-z_][\w.]*)\s*:\s*/);
  if (named) {
    name = named[1].trim();
    rest = raw.slice(named[0].length);
  }

  // Types are the wiki links before the first prose dash.
  const dash = rest.search(/\s[-–]\s/);
  const typeZone = dash === -1 ? rest : rest.slice(0, dash);
  const types = [...new Set(linkTargets(typeZone))].filter((t) => !t.startsWith("#"));

  const optional = /\(\s*optional/i.test(rest);
  const defMatch = rest.match(/\(\s*optional[^)]*?default\s+([^)]+)\)/i);

  const description = toMarkdown(dash === -1 ? (types.length ? "" : rest) : rest.slice(dash + 3));

  return {
    key,
    name,
    types,
    description,
    optional,
    ...(defMatch ? { default: defMatch[1].trim() } : {}),
  };
}

function parseReturns(raw: string): Returns {
  const dash = raw.search(/\s[-–]\s/);
  const typeZone = dash === -1 ? raw : raw.slice(0, dash);
  return {
    types: [...new Set(linkTargets(typeZone))],
    description: toMarkdown(dash === -1 ? "" : raw.slice(dash + 3)),
  };
}

/** Collect `keyN` values in ascending N (gr1, gr2, ... / x1, x2, ...). */
function indexed(params: Map<string, string>, prefix: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const [k, v] of params) {
    const m = k.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m && v.trim()) out.push([Number(m[1]), v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Assign a `pN` key to its syntax.
 *
 * Syntax 1's parameters are `p1..pN`. Every later syntax numbers its parameters
 * with the syntax index prefixed: syntax 2's are `p21, p22, ...`. That is
 * genuinely ambiguous for `p21` (syntax 1's 21st parameter, or syntax 2's
 * first?), so we only take the prefixed reading when that syntax actually
 * exists on the page — no real command has 21 parameters on one syntax.
 */
export function assignParamToSyntax(
  digits: string,
  syntaxIndices: Set<number>,
): { syntax: number; order: number } {
  if (digits.length >= 2) {
    const lead = Number(digits[0]);
    if (lead >= 2 && syntaxIndices.has(lead)) {
      return { syntax: lead, order: Number(digits.slice(1)) };
    }
  }
  return { syntax: 1, order: Number(digits) };
}

/** One parsed {{RV}} block, before blocks are merged into an entry. */
interface Block {
  type: EntryType | null;
  games: Array<{ game: GameId; since: string }>;
  groups: string[];
  description: string;
  syntaxes: Syntax[];
  examples: string[];
  seeAlso: string[];
  locality?: { argument?: string; effect?: string };
  multiplayer?: string;
  problems?: string;
  unknownGames: string[];
}

function parseBlock(body: string, fallbackTitle: string): Block {
  const params = parseTemplateParams(body);

  const rawType = (params.get("type") ?? "").trim().toLowerCase();
  const type: EntryType | null =
    rawType === "command"
      ? "command"
      : rawType === "function"
        ? "function"
        : rawType === "eventhandler" || rawType === "event handler"
          ? "eventhandler"
          : null;

  const games: Block["games"] = [];
  const unknownGames: string[] = [];
  for (const [n, code] of indexed(params, "game")) {
    const resolved = resolveGameCode(code);
    if ("excluded" in resolved) continue;
    if ("unknown" in resolved) {
      unknownGames.push(resolved.unknown);
      continue;
    }
    games.push({ game: resolved.id, since: cleanVersion(params.get(`version${n}`)) });
  }

  const syntaxEntries = indexed(params, "s");
  const syntaxIndices = new Set(syntaxEntries.map(([n]) => n));
  const syntaxes = new Map<number, Syntax>();
  const blockGames = games.map((g) => g.game);
  for (const [n, raw] of syntaxEntries) {
    syntaxes.set(n, { index: n, signature: toMarkdown(raw), params: [], games: blockGames });
  }
  if (syntaxes.size === 0) {
    syntaxes.set(1, { index: 1, signature: fallbackTitle, params: [], games: blockGames });
  }

  const pending: Array<{ syntax: number; order: number; param: Param }> = [];
  for (const [k, v] of params) {
    const m = k.match(/^p(\d+)$/);
    if (!m || !v.trim()) continue;
    const { syntax, order } = assignParamToSyntax(m[1], syntaxIndices);
    pending.push({ syntax, order, param: parseParam(k, v) });
  }
  pending.sort((a, b) => a.syntax - b.syntax || a.order - b.order);
  for (const { syntax, param } of pending) {
    (syntaxes.get(syntax) ?? syntaxes.get(1)!).params.push(param);
  }

  for (const [n, raw] of indexed(params, "r")) {
    const target = syntaxes.get(n);
    if (target) target.returns = parseReturns(raw);
  }

  const arg = (params.get("arg") ?? "").trim();
  const eff = (params.get("eff") ?? "").trim();
  const mp = (params.get("mp") ?? "").trim();
  const pr = (params.get("pr") ?? "").trim();

  return {
    type,
    games,
    groups: indexed(params, "gr")
      .map(([, v]) => toMarkdown(v))
      .filter(Boolean),
    description: toMarkdown(params.get("descr") ?? ""),
    syntaxes: [...syntaxes.values()].sort((a, b) => a.index - b.index),
    examples: indexed(params, "x").map(([, raw]) => toMarkdown(raw)),
    seeAlso: linkTargets(params.get("seealso") ?? ""),
    ...(arg || eff
      ? { locality: { ...(arg ? { argument: arg } : {}), ...(eff ? { effect: eff } : {}) } }
      : {}),
    ...(mp ? { multiplayer: toMarkdown(mp) } : {}),
    ...(pr ? { problems: toMarkdown(pr) } : {}),
    unknownGames,
  };
}

export interface ParseInput {
  title: string;
  wikitext: string;
  url: string;
  revision: { id: number; timestamp: string };
}

export function parseRvPage(input: ParseInput): ParseResult {
  const bodies = extractAllTemplates(input.wikitext, "RV");
  if (bodies.length === 0) {
    return { entry: null, unknownGames: [], skipped: "no {{RV}} template" };
  }

  const blocks = bodies.map((b) => parseBlock(b, input.title));
  const unknownGames = [...new Set(blocks.flatMap((b) => b.unknownGames))];

  const type = blocks.find((b) => b.type)?.type;
  if (!type) return { entry: null, unknownGames, skipped: "unsupported RV type" };

  // Games: union across blocks, keeping the first `since` seen per game and
  // ordering by release so callers get a stable timeline.
  const gameMap = new Map<GameId, string>();
  for (const block of blocks) {
    for (const g of block.games) {
      if (!gameMap.has(g.game) || (!gameMap.get(g.game) && g.since)) gameMap.set(g.game, g.since);
    }
  }
  if (gameMap.size === 0) {
    return { entry: null, unknownGames, skipped: "no included game tags" };
  }
  const games = [...gameMap.entries()]
    .map(([game, since]) => ({ game, since }))
    .sort((a, b) => GAME_IDS.indexOf(a.game) - GAME_IDS.indexOf(b.game));

  // Keep only syntaxes whose block contributed at least one included game, then
  // renumber so callers see a single coherent list.
  const syntaxes: Syntax[] = blocks
    .flatMap((b) => b.syntaxes)
    .filter((s) => s.games.length > 0)
    .map((s, i) => ({ ...s, index: i + 1 }));

  const examples: Example[] = [...new Set(blocks.flatMap((b) => b.examples))]
    .filter(Boolean)
    .map((code, i) => ({ index: i + 1, code }));

  const descriptions = [...new Set(blocks.map((b) => b.description).filter(Boolean))];

  const localityBlock = blocks.find((b) => b.locality);
  const mpBlock = blocks.find((b) => b.multiplayer);
  const prBlock = blocks.find((b) => b.problems);

  const entry: Entry = {
    id: slugify(input.title),
    title: input.title,
    name: identifierFor(input.title),
    type,
    games,
    groups: [...new Set(blocks.flatMap((b) => b.groups))],
    description: descriptions.join("\n\n"),
    syntaxes: syntaxes.length ? syntaxes : [{ index: 1, signature: input.title, params: [], games: [] }],
    examples,
    seeAlso: [...new Set(blocks.flatMap((b) => b.seeAlso))],
    ...(localityBlock?.locality ? { locality: localityBlock.locality } : {}),
    ...(mpBlock?.multiplayer ? { multiplayer: mpBlock.multiplayer } : {}),
    ...(prBlock?.problems ? { problems: prBlock.problems } : {}),
    url: input.url,
    revision: input.revision,
  };

  return { entry, unknownGames };
}

/**
 * Recover the SQF identifier from a wiki title.
 *
 * MediaWiki stores "diag_log" as "diag log", so a title that becomes a valid
 * identifier once spaces are underscores almost certainly is one. Operator
 * pages ("! a", "a + b") cannot be identifiers and are returned unchanged.
 */
export function identifierFor(title: string): string {
  const candidate = title.trim().replace(/ /g, "_");
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate) ? candidate : title.trim();
}

/**
 * Normalise a `versionN=` value to a bare version number.
 *
 * Editors sometimes park an HTML comment or a note beside the version
 * ("2.02 <!-- 2.04 for the alt syntax -->"), which otherwise ends up rendered
 * as the version and splits one release into several in version listings.
 */
export function cleanVersion(raw: string | undefined): string {
  if (!raw) return "";
  const stripped = raw
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<[^>]*>/g, " ")
    .trim();
  const m = stripped.match(/\d+(?:\.\d+)*/);
  return m ? m[0] : stripped.split(/\s+/)[0] ?? "";
}

export function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.\-+]/g, (c) => `u${c.codePointAt(0)!.toString(16)}`);
  return slug || "entry";
}
