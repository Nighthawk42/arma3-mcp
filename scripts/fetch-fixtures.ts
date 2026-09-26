/**
 * Pull a small, deliberately diverse fixture set so the parser can be developed
 * and tested offline. Costs a single API request (50-title limit).
 *
 * Run once: `npx tsx scripts/fetch-fixtures.ts`
 */
import fs from "node:fs";
import path from "node:path";
import { WikiClient } from "../src/wiki/client.js";

const TITLES = [
  // Arma 3 only, multi-syntax, heavy examples
  "remoteExec",
  "getUnitTrait",
  // Present across many games — exercises gameN/versionN fan-out
  "setPos",
  "createVehicle",
  "addAction",
  "count",
  "select",
  "forEach",
  "format",
  "hint",
  "player",
  "allUnits",
  "diag_log",
  "spawn",
  "execVM",
  "setDamage",
  "nearestObjects",
  "inArea",
  "ctrlSetText",
  "lnbAddRow",
  "private",
  "isNil",
  "configFile",
  "getText",
  // Operator-titled pages
  "! a",
  "a + b",
  // Functions
  "BIS_fnc_spawnGroup",
  "BIS_fnc_MP",
  "BIS_fnc_arrayShuffle",
  // Take On Helicopters-only, to prove the exclusion path
  "getFieldManualStartPage",
];

const OUT = path.resolve("tests/fixtures");

const client = new WikiClient({ log: (m) => console.error(m) });
const pages = await client.fetchWikitext(TITLES);

fs.mkdirSync(OUT, { recursive: true });
const manifest: Record<string, unknown> = {};
let saved = 0;

for (const page of pages) {
  if (page.missing || !page.wikitext) {
    console.error(`missing: ${page.title}`);
    continue;
  }
  const file = `${page.title.replace(/[^A-Za-z0-9_+-]/g, "_")}.wikitext`;
  fs.writeFileSync(path.join(OUT, file), page.wikitext, "utf8");
  manifest[page.title] = { file, revision: page.revision };
  saved++;
}

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.error(`saved ${saved}/${TITLES.length} fixtures in ${client.requestCount} request(s)`);
