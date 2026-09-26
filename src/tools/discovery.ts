/**
 * Discovery, browsing and linting tools.
 *
 * Kept separate from the core lookup tools in server.ts: these are the ones you
 * reach for when you do not yet know the name of the thing you want.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database as Db } from "better-sqlite3";
import {
  listGroups,
  browseGroup,
  addedInVersion,
  versionsFor,
  searchExamples,
  listMods,
  listConfigRoots,
  findSubclasses,
} from "../index/query.js";
import { validateSqf } from "../sqf/validate.js";
import { GAME_IDS, type GameId } from "../games.js";
import { ATTRIBUTION, gameLabel, renderClassLine, renderEntryLine } from "../format.js";

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });
const gameEnum = z.enum(GAME_IDS as [GameId, ...GameId[]]);

export function registerDiscoveryTools(server: McpServer, db: Db): void {
  server.registerTool(
    "list_groups",
    {
      title: "List command groups",
      description:
        "List the groups commands and functions are organised into (Multiplayer, Object Manipulation, Math, ...) with counts. Use it to discover what exists in an area before searching by name.",
      inputSchema: { game: gameEnum.optional() },
    },
    async ({ game }) => {
      const groups = listGroups(db, game);
      if (groups.length === 0) return text("No groups indexed yet.");
      return text(
        [
          `# Command groups${game ? ` — ${gameLabel(game)}` : ""}`,
          "",
          ...groups.map((g) => `- **${g.group}** — ${g.count}`),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "browse_group",
    {
      title: "Browse a command group",
      description:
        "List every command and function in one group, optionally filtered to a game. Pair with list_groups to explore an unfamiliar area of the API.",
      inputSchema: {
        group: z.string().describe("Group name, e.g. Multiplayer"),
        game: gameEnum.optional(),
        limit: z.number().int().min(1).max(300).optional(),
      },
    },
    async ({ group, game, limit }) => {
      const entries = browseGroup(db, group, game, limit ?? 100);
      if (entries.length === 0) return text(`Nothing in group "${group}".`);
      return text(
        [
          `# ${group}${game ? ` — ${gameLabel(game)}` : ""} (${entries.length})`,
          "",
          ...entries.map(renderEntryLine),
          "",
          ATTRIBUTION,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "added_in_version",
    {
      title: "What a version introduced",
      description:
        "List commands and functions introduced in a given version of a game, or list the versions themselves when no version is given. Answers 'what did Arma 3 2.14 add?' and 'how new is this command?'.",
      inputSchema: {
        game: gameEnum,
        version: z.string().optional().describe("Exact version string, e.g. 2.14"),
        limit: z.number().int().min(1).max(300).optional(),
      },
    },
    async ({ game, version, limit }) => {
      if (!version) {
        const versions = versionsFor(db, game);
        if (versions.length === 0) return text(`No version data for ${gameLabel(game)}.`);
        return text(
          [
            `# ${gameLabel(game)} — versions that introduced something`,
            "",
            ...versions.map((v) => `- **${v.version}** — ${v.count} entries`),
            "",
            "Pass one as `version` to list its additions.",
          ].join("\n"),
        );
      }
      const entries = addedInVersion(db, game, version).slice(0, limit ?? 100);
      if (entries.length === 0) {
        return text(`Nothing recorded as introduced in ${gameLabel(game)} ${version}.`);
      }
      return text(
        [
          `# Introduced in ${gameLabel(game)} ${version} (${entries.length})`,
          "",
          ...entries.map(renderEntryLine),
          "",
          ATTRIBUTION,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "search_examples",
    {
      title: "Search example code",
      description:
        "Search the wiki's example snippets themselves rather than the surrounding documentation. Use it to see how a command is actually written in practice.",
      inputSchema: {
        query: z.string().describe("Identifier or phrase to find in example code"),
        limit: z.number().int().min(1).max(30).optional(),
      },
    },
    async ({ query, limit }) => {
      const hits = searchExamples(db, query, limit ?? 8);
      if (hits.length === 0) return text(`No example code matching "${query}".`);
      return text(
        [
          `${hits.length} example(s) matching "${query}":`,
          "",
          ...hits.map((h) => `### ${h.entryName}\n${h.code}\n\n${h.url}`),
          "",
          ATTRIBUTION,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "list_mods",
    {
      title: "List indexed mods",
      description:
        "List the mods scanned into the classname index, with how many classes each contributes. Use it to see what content is available before searching for classnames.",
      inputSchema: { limit: z.number().int().min(1).max(300).optional() },
    },
    async ({ limit }) => {
      const mods = listMods(db);
      if (mods.length === 0) return text("No classname index present. Run `npm run scan` first.");
      const shown = mods.slice(0, limit ?? 60);
      return text(
        [
          `# Indexed mods (${mods.length})`,
          "",
          ...shown.map((m) => `- **${m.mod}** — ${m.classes} classes (${m.publicClasses} public)`),
          shown.length < mods.length ? `\n_${mods.length - shown.length} more._` : "",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "list_config_roots",
    {
      title: "List config roots",
      description:
        "List the config roots in the classname index (CfgVehicles, CfgWeapons, CfgMagazines, ...) with counts, for use as the `root` filter on search_classes.",
      inputSchema: {},
    },
    async () => {
      const roots = listConfigRoots(db);
      if (roots.length === 0) return text("No classname index present. Run `npm run scan` first.");
      return text(
        ["# Config roots", "", ...roots.map((r) => `- **${r.root}** — ${r.count}`)].join("\n"),
      );
    },
  );

  server.registerTool(
    "find_subclasses",
    {
      title: "Find everything inheriting a class",
      description:
        "Walk the config inheritance tree downward and list every class descending from a base class — for example every vehicle inheriting Tank_F. Filter by mod, or to editor-usable classes only.",
      inputSchema: {
        base: z.string().describe("Base classname, e.g. Tank_F"),
        mod: z.string().optional(),
        publicOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ base, mod, publicOnly, limit }) => {
      const { classes, truncated } = findSubclasses(db, base, {
        mod,
        publicOnly,
        limit: limit ?? 50,
      });
      if (classes.length === 0) return text(`Nothing inherits from "${base}".`);
      return text(
        [
          `${classes.length}${truncated ? "+" : ""} class(es) descending from \`${base}\`:`,
          "",
          ...classes.map(renderClassLine),
          truncated ? "\n_More exist; narrow with `mod` or raise `limit`._" : "",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "validate_sqf",
    {
      title: "Check an SQF snippet",
      description:
        "Check SQF code against the documentation: flags commands that do not exist, commands unavailable in the target game, commands with a global effect (a common multiplayer mistake), and deprecated commands. Identifiers it does not recognise are listed rather than reported as errors, since local variables and mod functions are legitimately absent from the wiki.",
      inputSchema: {
        code: z.string().describe("The SQF source to check"),
        game: gameEnum.optional().describe("Target game — enables availability checking"),
        flagGlobalEffects: z.boolean().optional(),
      },
    },
    async ({ code, game, flagGlobalEffects }) => {
      const result = validateSqf(db, code, { game, flagGlobalEffects });
      const out: string[] = [`# SQF check${game ? ` — target ${gameLabel(game)}` : ""}`, ""];
      if (result.findings.length === 0) {
        out.push("No issues found.");
      } else {
        const label = { error: "ERROR", warning: "WARN", info: "INFO" } as const;
        for (const f of result.findings) {
          out.push(`- **${label[f.severity]}** line ${f.line} \`${f.identifier}\` — ${f.message}`);
        }
      }
      out.push("", `Recognised: ${result.recognised.length ? result.recognised.join(", ") : "none"}`);
      if (result.unrecognised.length) {
        out.push(
          "",
          `Not in the documentation (local variables, mod functions, or typos): ${result.unrecognised.join(", ")}`,
        );
      }
      return text(out.join("\n"));
    },
  );
}
