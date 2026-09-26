/**
 * Assemble data/corpus.json from the ingest checkpoints in data/.ingest/.
 *
 * The ingest does this itself when it finishes, but a run can be interrupted
 * (Cloudflare throttling is expected on a long run). This rebuilds the corpus
 * from whatever has landed so far, so a partial index is always available.
 *
 *   npx tsx scripts/assemble.ts
 */
import fs from "node:fs";
import path from "node:path";
import { WIKI_BASE, API_URL } from "../src/wiki/client.js";
import { CORPUS_SCHEMA, type Corpus, type Entry } from "../src/types.js";

const DATA = path.resolve("data");
const ENTRIES_FILE = path.join(DATA, ".ingest", "entries.ndjson");
const TITLES_FILE = path.join(DATA, ".ingest", "titles.json");
const OUT = path.join(DATA, "corpus.json");

if (!fs.existsSync(ENTRIES_FILE)) {
  console.error(`no checkpoints at ${ENTRIES_FILE} — run \`npm run ingest\` first`);
  process.exit(1);
}

const byId = new Map<string, Entry>();
let watermark = "";
let malformed = 0;

for (const line of fs.readFileSync(ENTRIES_FILE, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const entry: Entry = JSON.parse(line);
    byId.set(entry.id, entry); // a later write of the same page wins
    if (entry.revision.timestamp > watermark) watermark = entry.revision.timestamp;
  } catch {
    // A run killed mid-write can leave one truncated line; ignore it.
    malformed++;
  }
}

const entries = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
const corpus: Corpus = {
  schema: CORPUS_SCHEMA,
  generatedAt: new Date().toISOString(),
  watermark,
  source: { wiki: WIKI_BASE, api: API_URL },
  entries,
};
fs.writeFileSync(OUT, JSON.stringify(corpus, null, 0));

const total = fs.existsSync(TITLES_FILE)
  ? (JSON.parse(fs.readFileSync(TITLES_FILE, "utf8")) as string[]).length
  : undefined;
const byType = new Map<string, number>();
for (const e of entries) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

console.error(`assembled ${entries.length} entries${total ? ` (of ${total} titles)` : ""} -> ${OUT}`);
console.error(`types: ${[...byType].map(([t, n]) => `${t}=${n}`).join("  ")}`);
if (malformed) console.error(`skipped ${malformed} malformed checkpoint line(s)`);
