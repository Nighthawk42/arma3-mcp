/**
 * End-to-end smoke test: drives every tool through an in-memory MCP client,
 * exactly as a real client would.
 *
 *   npx tsx scripts/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, openIndexOrExit } from "../src/server.js";

const db = openIndexOrExit();
const server = createServer(db);
const client = new Client({ name: "smoke", version: "0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((t) => t.name).join(", ")}\n`);

async function call(name: string, args: Record<string, unknown>, preview = 400) {
  const result: any = await client.callTool({ name, arguments: args });
  const body = result.content?.[0]?.text ?? "";
  console.log(`--- ${name}(${JSON.stringify(args)}) ---`);
  console.log(body.length > preview ? `${body.slice(0, preview)}\n  …[${body.length} chars]` : body);
  console.log();
  return body;
}

await call("list_games", {});
await call("search", { query: "spawn a group of units", limit: 5 });
await call("search", { query: "shuffle an array", game: "arma3", limit: 3 });
await call("get_command", { name: "remoteExec", game: "arma2" }, 300);
await call("compare_games", { name: "setPos" }, 600);
await call("compare_games", { name: "BIS_fnc_spawnGroup" });
await call("get_command", { name: "thisCommandDoesNotExist" });
await call("search_classes", { query: "rhs_2s1", limit: 6 });
await call("search_classes", { query: "T-72", mod: "@RHSAFRF", publicOnly: true, limit: 5 });
await call("get_class", { name: "rhs_2s1_tv", showChildren: true }, 700);

await call("list_config_roots", {});
await call("list_mods", { limit: 6 });
await call("find_subclasses", { base: "Tank_F", publicOnly: true, limit: 6 });
await call("list_groups", { game: "arma3" }, 300);
await call("search_examples", { query: "createVehicle", limit: 2 }, 500);
await call("added_in_version", { game: "arma3" }, 300);
await call(
  "validate_sqf",
  {
    code: [
      "private _pos = getPos player;",
      "_unit setPosATL _pos;",
      "_unit setDamage 0.5;",
      "hint frobnicateTheThing;",
    ].join(String.fromCharCode(10)),
    game: "arma3",
  },
  900,
);

await client.close();
db.close();
console.log("smoke complete");
