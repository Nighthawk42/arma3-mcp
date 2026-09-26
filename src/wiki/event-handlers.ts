/**
 * Event handler pages -> corpus entries.
 *
 * Unlike commands and functions, event handlers have no page of their own and
 * no {{RV}} template: each game documents them on a few long reference pages,
 * one section per handler. (The "Event Handlers" category listing is also one
 * of the requests Cloudflare refuses outright, even by page id, so the pages
 * are named here rather than discovered.)
 *
 * Two layouts are handled:
 *
 * - Heading pages. A handler is a heading whose text is a bare identifier
 *   (`=== AnimChanged ===`, `{{ArgTitle|4|BuildingChanged|{{GVI|arma3|1.68}}}}`);
 *   headings that read as phrases ("Curator Event Handlers", "Generic Events")
 *   are groups. That rule holds across pages even though they nest handlers at
 *   different levels. Locality icons and the "Commands:" list of a group apply
 *   to the handlers under it unless a handler says otherwise.
 * - The scripted-event table: rows of namespace / "EventName" / params, under
 *   a heading per system that raises them.
 */
import type { Entry, GameAvailability, Locality, Param } from "../types.js";
import { resolveGameCode } from "../games.js";
import { toMarkdown } from "./wikitext.js";
import { slugify } from "./rv-parser.js";

/** Reference pages that document event handlers, all fetched in one request. */
export const EVENT_HANDLER_PAGES = [
  "Arma 3: Event Handlers",
  "Arma 3: Mission Event Handlers",
  "User Interface Event Handlers",
  "Arma 3: Scripted Event Handlers",
];

const SCRIPTED_PAGE = "Arma 3: Scripted Event Handlers";

/** Headings that organise a page without naming a kind of handler. */
const STRUCTURAL_HEADINGS = new Set(["events", "reference list", "related commands", "functions", "examples"]);

export interface EventHandlerPage {
  title: string;
  wikitext: string;
  url: string;
  revision: { id: number; timestamp: string };
}

interface Heading {
  level: number;
  name: string;
  games: GameAvailability[];
}

/** Games declared by `{{GVI|game|version}}` templates in a heading line. */
function headingGames(line: string): GameAvailability[] {
  const out: GameAvailability[] = [];
  for (const m of line.matchAll(/\{\{\s*GVI\s*\|\s*([^|}]+?)\s*\|\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}/gi)) {
    const resolved = resolveGameCode(m[1]!);
    if ("id" in resolved && !out.some((g) => g.game === resolved.id)) {
      out.push({ game: resolved.id, since: m[2]!.trim() });
    }
  }
  return out;
}

export function parseHeading(line: string): Heading | null {
  const plain = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
  if (plain) return { level: plain[1]!.length, name: plain[2]!.trim(), games: headingGames(plain[2]!) };
  const arg = /^\{\{\s*ArgTitle\s*\|\s*(\d)\s*\|\s*([^|}]+?)\s*(\|.*)?\}\}\s*$/.exec(line);
  if (arg) return { level: Number(arg[1]), name: arg[2]!.trim(), games: headingGames(arg[3] ?? "") };
  return null;
}

/**
 * Splits a handler heading into its name and optional target qualifier.
 * `HitPart (Projectile)` and `HitPart` are the same event name raised on
 * different things, so the qualifier is kept but is not part of the name.
 * Returns null for group headings ("Curator Event Handlers").
 */
export function handlerHeading(text: string): { name: string; qualifier?: string } | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(([^()]+)\))?$/.exec(text.trim());
  if (!m || STRUCTURAL_HEADINGS.has(m[1]!.toLowerCase())) return null;
  return m[2] ? { name: m[1]!, qualifier: m[2].trim() } : { name: m[1]! };
}

/** Argument/effect locality from `{{Icon|localArgument}}`-style icons. */
function localityOf(body: string): Locality | undefined {
  const icons = new Set([...body.matchAll(/\{\{\s*Icon\s*\|\s*(\w+)/gi)].map((m) => m[1]!.toLowerCase()));
  const locality: Locality = {};
  if (icons.has("localargument")) locality.argument = "local";
  if (icons.has("globalargument")) locality.argument = "global";
  if (icons.has("localeffect")) locality.effect = "local";
  if (icons.has("globaleffect")) locality.effect = "global";
  if (icons.has("serverexec")) locality.effect = locality.effect ? `${locality.effect}, server only` : "server only";
  return Object.keys(locality).length ? locality : undefined;
}

/** Commands named in a "Commands:" bullet list, e.g. addEventHandler. */
function commandsOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^\*\s*\[\[([A-Za-z_][A-Za-z0-9_]*)\]\]\s*$/gm)) out.push(m[1]!);
  return out;
}

/** The text of a balanced `[...]` starting at `open`, or null. */
function balancedBrackets(s: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return s.slice(open, i + 1);
  }
  return null;
}

/** `params [...]` from the first code sample that declares one. */
export function paramsSignature(code: string): string | null {
  const m = /\bparams\s*\[/.exec(code);
  if (!m) return null;
  const list = balancedBrackets(code, m.index + m[0].length - 1);
  return list ? `params ${list.replace(/\s+/g, " ")}` : null;
}

/** `* unit: [[Object]] - description` bullets documenting the passed arguments. */
export function parseArgumentBullets(body: string): Param[] {
  const params: Param[] = [];
  // Later additions carry the version that introduced them:
  // `* {{GVI|arma3|1.50}} hitPartIndex: [[Number]] - ...`
  const bullet =
    /^\*\s*(?:\{\{\s*GVI\s*\|\s*[^|}]+\|\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/gm;
  for (const m of body.matchAll(bullet)) {
    const rest = m[3]!;
    const dash = rest.search(/\s[-–]\s/);
    const typePart = dash === -1 ? rest : rest.slice(0, dash);
    const types = [...typePart.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((t) => t[1]!.trim());
    const description = dash === -1 ? "" : toMarkdown(rest.slice(dash + 3)).trim();
    params.push({
      key: m[2]!,
      name: m[2]!,
      types,
      description: m[1] ? `${description}${description ? " " : ""}(since ${m[1]})` : description,
      optional: false,
    });
  }
  return params;
}

function prose(body: string): string {
  const text = body
    .replace(/<sqf>[\s\S]*?<\/sqf>/gi, "")
    .replace(/\{\{\s*Icon\s*\|[^}]*\}\}/gi, "")
    .replace(/^\*\s*(?:\{\{\s*GVI[^}]*\}\}\s*)?[A-Za-z_][A-Za-z0-9_]*\s*:.*$/gm, "")
    .replace(/^Commands:\s*$/gim, "")
    .replace(/^\*\s*\[\[[A-Za-z_][A-Za-z0-9_]*\]\]\s*$/gm, "");
  return toMarkdown(text);
}

function pageUrl(page: EventHandlerPage, anchor: string): string {
  return `${page.url}#${encodeURIComponent(anchor.replace(/ /g, "_"))}`;
}

function makeEntry(
  page: EventHandlerPage,
  name: string,
  groups: string[],
  fields: Partial<Entry> & Pick<Entry, "games" | "description">,
  taken: Set<string>,
): Entry {
  let id = slugify(`${page.title} ${groups.join(" ")} ${name}`);
  for (let n = 2; taken.has(id); n++) id = `${slugify(`${page.title} ${groups.join(" ")} ${name}`)}-${n}`;
  taken.add(id);
  return {
    id,
    title: page.title,
    name,
    type: "eventhandler",
    groups,
    syntaxes: [],
    examples: [],
    seeAlso: [],
    url: pageUrl(page, name),
    revision: page.revision,
    ...fields,
  };
}

/** A game with no version known: event handler pages only version newer entries. */
const ARMA3: GameAvailability[] = [{ game: "arma3", since: "" }];

function parseHeadingPage(page: EventHandlerPage): Entry[] {
  const lines = page.wikitext.replace(/\r\n?/g, "\n").split("\n");
  const pageGroup = page.title.replace(/^Arma 3:\s*/, "");
  const entries: Entry[] = [];
  const taken = new Set<string>();

  // Group context: the headings above the current line, with the defaults
  // their own preamble text sets for the handlers below them.
  type Group = Heading & { locality?: Locality; commands: string[] };
  const stack: Group[] = [];
  let preambleCommands: string[] = [];

  let i = 0;
  const bodyUntilNextHeading = (from: number): { body: string; next: number } => {
    let j = from;
    while (j < lines.length && !parseHeading(lines[j]!)) j++;
    return { body: lines.slice(from, j).join("\n"), next: j };
  };

  const first = bodyUntilNextHeading(0);
  preambleCommands = commandsOf(first.body);
  i = first.next;

  while (i < lines.length) {
    const heading = parseHeading(lines[i]!)!;
    const { body, next } = bodyUntilNextHeading(i + 1);
    i = next;

    while (stack.length && stack[stack.length - 1]!.level >= heading.level) stack.pop();

    const handler = handlerHeading(heading.name);
    if (!handler) {
      stack.push({
        ...heading,
        name: toMarkdown(heading.name),
        locality: localityOf(body),
        commands: commandsOf(body),
      });
      continue;
    }

    const groups = [
      ...new Set(
        [
          page.title === "Arma 3: Event Handlers" ? "" : pageGroup,
          ...stack.map((g) => g.name),
          handler.qualifier ?? "",
        ].filter(
          (g) => g && !STRUCTURAL_HEADINGS.has(g.toLowerCase()),
        ),
      ),
    ];
    const inherited = [...stack].reverse();
    const samples = [...body.matchAll(/<sqf>([\s\S]*?)<\/sqf>/gi)].map((m) => m[1]!.trim()).filter(Boolean);
    const signature = samples.map(paramsSignature).find(Boolean);
    const params = parseArgumentBullets(body);
    const commands = inherited.find((g) => g.commands.length)?.commands ?? preambleCommands;
    const games = heading.games.length ? heading.games : (inherited.find((g) => g.games.length)?.games ?? ARMA3);

    entries.push(
      makeEntry(
        page,
        handler.name,
        groups,
        {
          games,
          description: `${handler.qualifier ? `Raised on: ${handler.qualifier}.\n\n` : ""}${prose(body)}`,
          locality: localityOf(body) ?? inherited.find((g) => g.locality)?.locality,
          syntaxes:
            signature || params.length
              ? [{ index: 1, signature: signature ?? "", params, games: games.map((g) => g.game) }]
              : [],
          examples: samples.map((code, n) => ({ index: n + 1, code: `\`\`\`sqf\n${code}\n\`\`\`` })),
          seeAlso: commands,
        },
        taken,
      ),
    );
  }
  return entries;
}

/** Cells of a wikitable row: lines starting with `|`, excluding row/table markers. */
function tableCells(row: string): string[] {
  const cells: string[] = [];
  for (const line of row.split("\n")) {
    if (!line.startsWith("|") || line.startsWith("|-") || line.startsWith("|}")) {
      if (cells.length && line.trim() && !line.startsWith("!") && !line.startsWith("|")) {
        cells[cells.length - 1] += `\n${line}`;
      }
      continue;
    }
    cells.push(...line.slice(1).split("||").map((c) => c.trim()));
  }
  return cells;
}

function parseScriptedPage(page: EventHandlerPage): Entry[] {
  const wikitext = page.wikitext.replace(/\r\n?/g, "\n");
  const start = wikitext.search(/^==\s*Events\s*==\s*$/m);
  if (start === -1) return [];
  const text = wikitext.slice(start);
  const entries: Entry[] = [];
  const taken = new Set<string>();
  let system = "";
  for (const chunk of text.split(/^\|-.*$/m)) {
    const heading = /^===\s*(.+?)\s*===\s*$/m.exec(chunk);
    if (heading) system = toMarkdown(heading[1]!);
    const cells = tableCells(chunk);
    if (cells.length < 3) continue;
    const name = /^"([^"]+)"$/.exec(cells[1]!)?.[1];
    if (!name) continue;
    const namespace = cells[0]!.replace(/<\/?sqf>/g, "").trim();
    const signature = paramsSignature(cells[2]!.replace(/<\/?sqf>/g, "")) ?? "";
    entries.push(
      makeEntry(
        page,
        name,
        ["Scripted Event Handlers", ...(system ? [system] : [])],
        {
          games: ARMA3,
          description:
            `Scripted event raised by ${system || "a BI function or module"}. ` +
            `Subscribe with \`[${namespace}, "${name}", { ${signature}; }] call BIS_fnc_addScriptedEventHandler\`.`,
          syntaxes: signature ? [{ index: 1, signature, params: [], games: ["arma3"] }] : [],
          seeAlso: ["BIS_fnc_addScriptedEventHandler", "BIS_fnc_removeScriptedEventHandler"],
        },
        taken,
      ),
    );
  }
  return entries;
}

/** Every event handler documented on one reference page. */
export function parseEventHandlerPage(page: EventHandlerPage): Entry[] {
  return page.title === SCRIPTED_PAGE ? parseScriptedPage(page) : parseHeadingPage(page);
}

/** Replace a page's event handler entries in a corpus entry list. */
export function replacePageEntries(entries: Entry[], title: string, fresh: Entry[]): Entry[] {
  return [...entries.filter((e) => !(e.type === "eventhandler" && e.title === title)), ...fresh];
}
