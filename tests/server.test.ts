/**
 * The MCP surface, end to end, against a tiny in-memory index — no corpus,
 * built index or embedding model needed, so it runs anywhere (CI included).
 * Search therefore exercises its lexical fallback.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { createSchema, entryText, openDatabase } from "../src/index/store.js";
import type { Entry } from "../src/types.js";

let client: Client;

function entry(name: string, type: Entry["type"], games: Array<[string, string]>, extra: Partial<Entry> = {}): Entry {
  return {
    id: `${type}-${name}-${extra.groups?.join("-") ?? ""}`,
    title: name,
    name,
    type,
    games: games.map(([game, since]) => ({ game: game as Entry["games"][number]["game"], since })),
    groups: [],
    description: `${name} documentation.`,
    syntaxes: [],
    examples: [],
    seeAlso: [],
    url: `https://community.bistudio.com/wiki/${name}`,
    revision: { id: 1, timestamp: "2026-09-01T00:00:00Z" },
    ...extra,
  };
}

const ENTRIES: Entry[] = [
  entry("setDamage", "command", [["ofp", "1.00"], ["arma3", "0.50"]], {
    description: "Damages or repairs a unit.",
    locality: { argument: "global", effect: "global" },
  }),
  entry("remoteExec", "command", [["arma3", "1.50"]], { description: "Executes code on other machines." }),
  entry("BIS_fnc_spawnGroup", "function", [["arma3", "0.50"]], { description: "Spawns a group of units." }),
  entry("HitPart", "eventhandler", [["arma3", ""]], { groups: ["Basic Event Handlers", "Entity"] }),
  entry("HitPart", "eventhandler", [["arma3", "2.10"]], { groups: ["Projectile Event Handlers", "Projectile"] }),
];

beforeAll(async () => {
  const db = openDatabase(":memory:");
  createSchema(db);
  const insert = db.prepare(
    "insert into entries(id, name, title, type, games, groups, data, url) values (?,?,?,?,?,?,?,?)",
  );
  const fts = db.prepare("insert into entries_fts(rowid, name, body) values (?,?,?)");
  ENTRIES.forEach((e, i) => {
    insert.run(i + 1, e.name, e.title, e.type, JSON.stringify(e.games), JSON.stringify(e.groups), JSON.stringify(e), e.url);
    fts.run(i + 1, e.name, entryText(e));
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([createServer(db).connect(serverTransport), client.connect(clientTransport)]);
});

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
  return result.content.map((c) => c.text).join("\n");
}

describe("tool surface", () => {
  it("registers every tool as read-only and closed-world", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    }
  });
});

describe("documentation tools", () => {
  it("get_command renders a command and checks game availability", async () => {
    expect(await call("get_command", { name: "setdamage" })).toContain("# setDamage");
    expect(await call("get_command", { name: "remoteExec", game: "arma2" })).toContain(
      "exists, but not in Arma 2",
    );
    expect(await call("get_command", { name: "setDamag" })).toContain("Did you mean: `setDamage`");
  });

  it("get_event_handler shows every same-named handler", async () => {
    const text = await call("get_event_handler", { name: "HitPart" });
    expect(text.split("\n---\n")).toHaveLength(2);
    expect(text).toContain("Projectile Event Handlers");
  });

  it("search answers lexically when no embedding model is available", async () => {
    const text = await call("search", { query: "spawn a group of units", limit: 3 });
    expect(text).toMatch(/^3 result|BIS_fnc_spawnGroup/m);
    expect(text.indexOf("BIS_fnc_spawnGroup")).toBeGreaterThan(-1);
  });

  it("validate_sqf checks a target version", async () => {
    const text = await call("validate_sqf", {
      code: "[] remoteExec ['hint'];\nplayer setDamage 1;",
      game: "arma3",
      gameVersion: "1.40",
    });
    expect(text).toContain("**ERROR** line 1 `remoteExec` — introduced in Arma 3 1.50; target is 1.40");
    expect(text).toContain("**WARN** line 2 `setDamage`");
  });
});
