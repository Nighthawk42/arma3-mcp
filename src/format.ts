/**
 * Markdown renderers for tool output.
 *
 * All tool responses are plain markdown text: it is the format every MCP client
 * renders, and it keeps command documentation readable when a model quotes it
 * back to a user.
 */
import type { Entry, Syntax } from "./types.js";
import { GAMES, type GameId } from "./games.js";
import type { ClassEntry } from "./config/classes.js";
import { SCOPE_NAMES } from "./config/classes.js";

export const ATTRIBUTION =
  "Documentation from the Bohemia Interactive Community Wiki (community.bistudio.com).";

export function gameLabel(id: GameId): string {
  return GAMES[id]?.name ?? id;
}

function renderSyntax(syntax: Syntax, showGames: boolean): string {
  const lines: string[] = [];
  const scope =
    showGames && syntax.games.length ? ` _(${syntax.games.map(gameLabel).join(", ")})_` : "";
  lines.push(`**Syntax ${syntax.index}**${scope}`);
  lines.push("```sqf");
  lines.push(syntax.signature);
  lines.push("```");
  if (syntax.params.length) {
    for (const p of syntax.params) {
      const name = p.name ? `\`${p.name}\`` : `\`${p.key}\``;
      const types = p.types.length ? ` — ${p.types.join(" | ")}` : "";
      const opt = p.optional ? ` _(optional${p.default ? `, default ${p.default}` : ""})_` : "";
      const desc = p.description ? `: ${p.description.replace(/\n+/g, " ")}` : "";
      lines.push(`- ${name}${types}${opt}${desc}`);
    }
  }
  if (syntax.returns) {
    const types = syntax.returns.types.join(" | ") || "Nothing";
    lines.push(`- **Returns** — ${types}${syntax.returns.description ? `: ${syntax.returns.description}` : ""}`);
  }
  return lines.join("\n");
}

export function renderEntry(entry: Entry, options: { examples?: number } = {}): string {
  const exampleLimit = options.examples ?? 3;
  const out: string[] = [];

  out.push(`# ${entry.name}`);
  const availability = entry.games
    .map((g) => `${gameLabel(g.game)}${g.since ? ` ${g.since}+` : ""}`)
    .join(" · ");
  out.push(`_${entry.type}_ — ${availability}`);
  if (entry.groups.length) out.push(`Group: ${entry.groups.join(", ")}`);
  out.push("");

  if (entry.description) out.push(entry.description, "");

  // Only label syntaxes by game when the page actually differs between them.
  const multiGeneration = new Set(entry.syntaxes.map((s) => s.games.join(","))).size > 1;
  for (const syntax of entry.syntaxes) {
    out.push(renderSyntax(syntax, multiGeneration), "");
  }

  if (entry.locality) {
    const parts: string[] = [];
    if (entry.locality.argument) parts.push(`argument **${entry.locality.argument}**`);
    if (entry.locality.effect) parts.push(`effect **${entry.locality.effect}**`);
    out.push(`**Locality**: ${parts.join(", ")}`, "");
  }
  if (entry.multiplayer) out.push(`**Multiplayer**: ${entry.multiplayer}`, "");
  if (entry.problems) out.push(`**Known issues**: ${entry.problems}`, "");

  const examples = entry.examples.slice(0, exampleLimit);
  if (examples.length) {
    out.push(`## Examples`);
    for (const ex of examples) out.push(ex.code, "");
    if (entry.examples.length > examples.length) {
      out.push(`_${entry.examples.length - examples.length} further example(s) on the wiki._`, "");
    }
  }

  if (entry.seeAlso.length) out.push(`**See also**: ${entry.seeAlso.slice(0, 12).join(", ")}`, "");
  out.push(`Source: ${entry.url}`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function renderEntryLine(entry: Entry): string {
  const games = entry.games.map((g) => g.game).join(",");
  const summary = entry.description.replace(/\s+/g, " ").slice(0, 140);
  return `- **${entry.name}** (${entry.type}; ${games}) — ${summary}${summary.length >= 140 ? "…" : ""}`;
}

export function renderClass(cls: ClassEntry): string {
  const out: string[] = [];
  out.push(`# ${cls.name}`);
  out.push(`_${cls.root}_ — from **${cls.mod}** (${cls.addon})`);
  if (cls.displayName) out.push(`Display name: ${cls.displayName}`);
  if (cls.scope !== undefined) out.push(`Scope: ${cls.scope} (${SCOPE_NAMES[cls.scope] ?? "?"})`);
  if (cls.faction) out.push(`Faction: ${cls.faction}`);
  if (cls.editorCategory) out.push(`Editor: ${cls.editorCategory}${cls.editorSubcategory ? ` / ${cls.editorSubcategory}` : ""}`);
  if (cls.model) out.push(`Model: ${cls.model}`);
  if (cls.parent) out.push("", `Inherits: ${[cls.parent, ...cls.ancestors.slice(1)].join(" -> ")}`);
  return out.join("\n");
}

export function renderClassLine(cls: ClassEntry): string {
  const display = cls.displayName ? ` "${cls.displayName}"` : "";
  const scope = cls.scope !== undefined ? ` scope=${cls.scope}` : "";
  return `- \`${cls.name}\`${display} — ${cls.root}, ${cls.mod}${scope}`;
}
