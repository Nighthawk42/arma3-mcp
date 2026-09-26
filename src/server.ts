/**
 * MCP server exposing the local Arma documentation index.
 *
 * Tools are organised per format/domain, with `game` as a parameter rather than
 * one tool set per title: a single wiki page documents a command across several
 * games at once, so duplicating tools per game would surface the same record
 * many times and multiply the tool list for no gain.
 *
 * Nothing here touches the network — every answer comes from data/index.sqlite.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database as Db } from "better-sqlite3";
import { openDatabase } from "./index/store.js";
import {
  getEntryByName,
  suggestNames,
  searchEntries,
  searchClasses,
  getClass,
  childrenOf,
  meta,
  countsByGame,
} from "./index/query.js";
import { GAMES, GAME_IDS, type GameId } from "./games.js";
import {
  ATTRIBUTION,
  gameLabel,
  renderClass,
  renderClassLine,
  renderEntry,
  renderEntryLine,
} from "./format.js";
import { INDEXED_ROOTS } from "./config/classes.js";
import { registerDiscoveryTools } from "./tools/discovery.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function resolveIndexPath(): string {
  const override = process.env.ARMA_MCP_INDEX;
  if (override) return override;
  // dist/ and src/ both sit one level under the package root.
  return path.resolve(here, "..", "data", "index.sqlite");
}

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

const gameEnum = z.enum(GAME_IDS as [GameId, ...GameId[]]);

export function createServer(db: Db): McpServer {
  const server = new McpServer({ name: "arma-mcp", version: "0.1.0" });
  const info = meta(db);

  server.registerTool(
    "list_games",
    {
      title: "List games",
      description:
        "List the Bohemia Interactive games covered by this server, with how many documented commands and functions each one has. Use the returned ids as the `game` filter on other tools.",
      inputSchema: {},
    },
    async () => {
      const counts = countsByGame(db);
      const lines = GAME_IDS.map(
        (id) => `- \`${id}\` — ${GAMES[id].name} (${GAMES[id].released}, ${GAMES[id].engine}): ${counts.get(id) ?? 0} entries`,
      );
      return text(
        [
          "# Games covered",
          ...lines,
          "",
          `Take On Helicopters and VBS are excluded by design.`,
          `Index built ${info.builtAt ?? "unknown"}; ${info.entries ?? 0} wiki entries, ${info.classes ?? 0} config classes.`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search scripting documentation",
      description:
        "Search SQF commands, functions and event handlers by name or by what they do. Combines exact-name, full-text and semantic matching. Filter to one game with `game`, or one kind of entry with `type`.",
      inputSchema: {
        query: z.string().describe("Identifier or plain-English description of the behaviour"),
        game: gameEnum.optional().describe("Only entries available in this game"),
        type: z.enum(["command", "function", "eventhandler"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, game, type, limit }) => {
      const hits = await searchEntries(db, query, { game, type, limit: limit ?? 10 });
      if (hits.length === 0) {
        return text(`No results for "${query}"${game ? ` in ${gameLabel(game)}` : ""}.`);
      }
      const header = `${hits.length} result(s) for "${query}"${game ? ` in ${gameLabel(game)}` : ""}:`;
      return text(
        [header, "", ...hits.map((h) => renderEntryLine(h.entry)), "", ATTRIBUTION].join("\n"),
      );
    },
  );

  const lookup = (
    name: string,
    kind: "command" | "function" | "eventhandler",
    game?: GameId,
  ) => {
    const entry = getEntryByName(db, name, kind);
    if (!entry) {
      const near = suggestNames(db, name);
      return text(
        `No ${kind} named "${name}".` +
          (near.length ? `\n\nDid you mean: ${near.map((n) => `\`${n}\``).join(", ")}` : ""),
      );
    }
    if (game && !entry.games.some((g) => g.game === game)) {
      const available = entry.games.map((g) => gameLabel(g.game)).join(", ");
      return text(
        `\`${entry.name}\` exists, but not in ${gameLabel(game)}.\n\nAvailable in: ${available}.\n\nSource: ${entry.url}`,
      );
    }
    return text(`${renderEntry(entry)}\n\n${ATTRIBUTION}`);
  };

  server.registerTool(
    "get_command",
    {
      title: "Get a scripting command",
      description:
        "Full documentation for one SQF scripting command: every syntax, its parameters and return types, argument/effect locality, multiplayer notes and examples. Pass `game` to confirm availability in that title.",
      inputSchema: {
        name: z.string().describe("Command name, e.g. setPosATL or remoteExec"),
        game: gameEnum.optional(),
      },
    },
    async ({ name, game }) => lookup(name, "command", game),
  );

  server.registerTool(
    "get_function",
    {
      title: "Get a scripting function",
      description:
        "Full documentation for one BI-supplied function (BIS_fnc_*, and equivalents), including its call syntax, parameters and examples.",
      inputSchema: {
        name: z.string().describe("Function name, e.g. BIS_fnc_spawnGroup"),
        game: gameEnum.optional(),
      },
    },
    async ({ name, game }) => lookup(name, "function", game),
  );

  server.registerTool(
    "get_event_handler",
    {
      title: "Get an event handler",
      description:
        "Documentation for one event handler, including the arguments it passes to its code and which games support it.",
      inputSchema: {
        name: z.string().describe("Event handler name, e.g. Fired or HandleDamage"),
        game: gameEnum.optional(),
      },
    },
    async ({ name, game }) => lookup(name, "eventhandler", game),
  );

  server.registerTool(
    "compare_games",
    {
      title: "Compare availability across games",
      description:
        "Show which games a command or function exists in and the version of each that introduced it. Answers 'is this safe to use in Arma 2?' and 'when did this land?'.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const entry = getEntryByName(db, name);
      if (!entry) {
        const near = suggestNames(db, name);
        return text(
          `Nothing documented under "${name}".` +
            (near.length ? `\n\nDid you mean: ${near.map((n) => `\`${n}\``).join(", ")}` : ""),
        );
      }
      const have = new Map(entry.games.map((g) => [g.game, g.since]));
      const rows = GAME_IDS.map((id) => {
        const since = have.get(id);
        return `| ${GAMES[id].name} | ${since === undefined ? "—" : "yes"} | ${since || ""} |`;
      });
      return text(
        [
          `# ${entry.name} — availability`,
          "",
          "| Game | Available | Since |",
          "| --- | --- | --- |",
          ...rows,
          "",
          `Source: ${entry.url}`,
          ATTRIBUTION,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "search_classes",
    {
      title: "Search config classnames",
      description:
        "Search config classnames scanned from the local Arma install and its mods (CfgVehicles, CfgWeapons, CfgMagazines and more). Use it to find the exact classname to pass to createVehicle, or to see what a mod adds. Matching is lexical: classnames are identifiers, so exact and partial name matching beats semantic similarity here.",
      inputSchema: {
        query: z.string().describe("Classname fragment or display name, e.g. rhs_2s1 or 'T-72'"),
        mod: z.string().optional().describe("Restrict to one mod folder, e.g. @RHSAFRF"),
        root: z.enum(INDEXED_ROOTS as unknown as [string, ...string[]]).optional(),
        publicOnly: z
          .boolean()
          .optional()
          .describe("Only scope=2 classes, i.e. those usable in the editor and scripts"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, mod, root, publicOnly, limit }) => {
      if (Number(info.classes ?? 0) === 0) {
        return text(
          "No classname index present. Run `npm run scan -- \"<path to Arma install>\"` then `npm run index` to build one from the local install.",
        );
      }
      const hits = searchClasses(db, query, { mod, root, publicOnly, limit: limit ?? 20 });
      if (hits.length === 0) return text(`No classes matching "${query}".`);
      return text(
        [
          `${hits.length} class(es) matching "${query}":`,
          "",
          ...hits.map((h) => renderClassLine(h.cls)),
          "",
          `Scanned from the local install; classnames reflect the mods present on this machine.`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "get_class",
    {
      title: "Get a config class",
      description:
        "Details for one config classname: its inheritance chain, display name, scope, faction and source mod, plus the classes that inherit from it.",
      inputSchema: {
        name: z.string().describe("Exact classname, e.g. rhs_2s1_tv"),
        showChildren: z.boolean().optional(),
      },
    },
    async ({ name, showChildren }) => {
      const found = getClass(db, name);
      if (found.length === 0) return text(`No config class named "${name}".`);
      const parts = found.map(renderClass);
      if (showChildren) {
        const kids = childrenOf(db, name);
        if (kids.length) {
          parts.push(`\n## Inherited by (${kids.length})\n${kids.map(renderClassLine).join("\n")}`);
        }
      }
      return text(parts.join("\n\n---\n\n"));
    },
  );

  registerDiscoveryTools(server, db);

  return server;
}

export function openIndexOrExit(): Db {
  const file = resolveIndexPath();
  if (!fs.existsSync(file)) {
    console.error(
      `arma-mcp: no index at ${file}\n` +
        `Build one with:\n  npm run ingest   # fetch the wiki corpus (slow, resumable)\n  npm run index    # build the searchable index`,
    );
    process.exit(1);
  }
  return openDatabase(file, true);
}
