/**
 * Full wiki ingest: category listings -> wikitext -> parsed corpus.
 *
 * Resumable by design, for two different reasons.
 *
 * 1. A long run can be interrupted for any reason, so every batch is
 *    checkpointed to data/.ingest/ as it lands and re-running skips what is
 *    already done — an interruption costs one batch, not the whole run.
 * 2. A small number of individual pages are refused by Cloudflare with a 403,
 *    every time, regardless of how slowly we ask. Since the API takes 50
 *    titles per request, one such page fails its whole batch; without
 *    isolation the ingest stalls on it forever. `fetchResilient` bisects a
 *    failed batch and quarantines the specific page at fault.
 *
 *   npx tsx scripts/ingest.ts          # resume (or start)
 *   npx tsx scripts/ingest.ts --fresh  # discard checkpoints and restart
 */
import fs from "node:fs";
import path from "node:path";
import { WikiClient, chunk, WIKI_BASE, API_URL } from "../src/wiki/client.js";
import { parseRvPage } from "../src/wiki/rv-parser.js";
import { CORPUS_SCHEMA, type Corpus, type Entry } from "../src/types.js";

/**
 * Source categories.
 *
 * Per-game command categories are the authoritative membership lists; the
 * {{RV}} game tags on each page then give exact per-game availability. Take On
 * Helicopters is intentionally absent — see src/games.ts.
 */
const CATEGORIES = [
  "Operation Flashpoint: Scripting Commands",
  "Operation Flashpoint: Elite: Scripting Commands",
  "ArmA: Armed Assault: Scripting Commands",
  "Arma 2: Scripting Commands",
  "Arma 2: Operation Arrowhead: Scripting Commands",
  "Arma 3: Scripting Commands",
  "Arma 3: Functions",
  "Arma 2: Functions",
];

const DATA = path.resolve("data");
const STATE = path.join(DATA, ".ingest");
const TITLES_FILE = path.join(STATE, "titles.json");
const ENTRIES_FILE = path.join(STATE, "entries.ndjson");
const SEEN_FILE = path.join(STATE, "seen.ndjson");
const QUARANTINE_FILE = path.join(STATE, "quarantine.ndjson");
const OUT = path.join(DATA, "corpus.json");

const fresh = process.argv.includes("--fresh");
if (fresh && fs.existsSync(STATE)) fs.rmSync(STATE, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });

// Paced out of politeness rather than necessity. The 403s that stalled early
// runs came from a handful of individually blocked pages, not from request
// volume, so this only needs to be a courteous rate — not a crawl.
const client = new WikiClient({
  minIntervalMs: Number(process.env.ARMA_MCP_INTERVAL_MS ?? 5000),
  log: (m) => console.error(m),
});

/**
 * Fetch a batch, isolating any page the wiki refuses to serve.
 *
 * Cloudflare 403s a small number of specific pages — "BIN fnc droneDestructionFX"
 * fails on its own every time while its neighbours succeed. Because the API
 * takes 50 titles at once, one such page fails the whole batch, and a naive
 * ingest simply stops there forever. So on failure we bisect: halves that
 * succeed are kept, and a single title that still fails is quarantined and
 * skipped. One unreachable page costs that page, not the run.
 */
async function fetchResilient(
  titles: string[],
  quarantined: string[],
  isRetryable = true,
): Promise<Awaited<ReturnType<typeof client.fetchWikitext>>> {
  try {
    // Retry only the first attempt at a batch, where a 403 might still be a
    // transient throttle. Once we are bisecting we already know some page in
    // here is hard-blocked, and retrying each probe would make isolating it
    // cost minutes per batch instead of seconds.
    return await client.fetchWikitext(titles, { maxRetries: isRetryable ? 2 : 0 });
  } catch (e) {
    if (titles.length === 1) {
      console.error(`\n  quarantined (wiki refuses to serve): ${titles[0]}`);
      quarantined.push(titles[0]);
      return [];
    }
    const mid = Math.floor(titles.length / 2);
    const left = await fetchResilient(titles.slice(0, mid), quarantined, false);
    const right = await fetchResilient(titles.slice(mid), quarantined, false);
    return [...left, ...right];
  }
}

// --- 1. Page set (cached, so a resume never re-lists categories) ------------
let titles: string[];
if (fs.existsSync(TITLES_FILE)) {
  titles = JSON.parse(fs.readFileSync(TITLES_FILE, "utf8"));
  console.error(`resuming with ${titles.length} cached titles`);
} else {
  const set = new Set<string>();
  for (const category of CATEGORIES) {
    try {
      const members = await client.categoryMembers(category);
      members.forEach((t) => set.add(t));
      console.error(`  ${category}: ${members.length} pages (${set.size} unique)`);
    } catch (e) {
      console.error(`  ${category}: FAILED — ${(e as Error).message}`);
    }
  }
  titles = [...set].sort();
  fs.writeFileSync(TITLES_FILE, JSON.stringify(titles));
}

// --- 2. Resume point --------------------------------------------------------
/** Titles already fetched, whether or not they yielded an entry. */
const seen = new Set<string>();
if (fs.existsSync(SEEN_FILE)) {
  for (const line of fs.readFileSync(SEEN_FILE, "utf8").split("\n")) {
    if (line.trim()) seen.add(JSON.parse(line));
  }
}
const remaining = titles.filter((t) => !seen.has(t));
const batches = chunk(remaining);
console.error(
  `${titles.length} titles: ${seen.size} done, ${remaining.length} remaining (${batches.length} batches)\n`,
);

// --- 3. Fetch, parse, checkpoint -------------------------------------------
const entriesOut = fs.createWriteStream(ENTRIES_FILE, { flags: "a" });
const seenOut = fs.createWriteStream(SEEN_FILE, { flags: "a" });
const quarantineOut = fs.createWriteStream(QUARANTINE_FILE, { flags: "a" });
const quarantined: string[] = [];
const recordedQuarantine = new Set<string>();
if (fs.existsSync(QUARANTINE_FILE)) {
  for (const line of fs.readFileSync(QUARANTINE_FILE, "utf8").split("\n")) {
    if (line.trim()) recordedQuarantine.add(JSON.parse(line));
  }
}
const unknownGames = new Set<string>();
let added = 0;
let batchNo = 0;

for (const batch of batches) {
  batchNo++;
  const pages = await fetchResilient(batch, quarantined);

  // Record refused titles as seen, so a resume does not retry them forever.
  for (const bad of quarantined) {
    if (recordedQuarantine.has(bad)) continue;
    recordedQuarantine.add(bad);
    seenOut.write(`${JSON.stringify(bad)}\n`);
    quarantineOut.write(`${JSON.stringify(bad)}\n`);
  }

  for (const page of pages) {
    seenOut.write(`${JSON.stringify(page.title)}\n`);
    if (page.missing || !page.wikitext || !page.revision) continue;
    const result = parseRvPage({
      title: page.title,
      wikitext: page.wikitext,
      url: client.pageUrl(page.title),
      revision: page.revision,
    });
    result.unknownGames.forEach((g) => unknownGames.add(g));
    if (result.entry) {
      entriesOut.write(`${JSON.stringify(result.entry)}\n`);
      added++;
    }
  }
  process.stderr.write(`  batch ${batchNo}/${batches.length} — ${added} new entries\r`);
}
entriesOut.close();
seenOut.close();
quarantineOut.close();
await new Promise((r) => setTimeout(r, 100));

// --- 4. Assemble ------------------------------------------------------------
const byName = new Map<string, Entry>();
let watermark = "";
if (fs.existsSync(ENTRIES_FILE)) {
  for (const line of fs.readFileSync(ENTRIES_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry: Entry = JSON.parse(line);
    byName.set(entry.id, entry); // later write of the same page wins
    if (entry.revision.timestamp > watermark) watermark = entry.revision.timestamp;
  }
}

const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
const corpus: Corpus = {
  schema: CORPUS_SCHEMA,
  generatedAt: new Date().toISOString(),
  watermark,
  source: { wiki: WIKI_BASE, api: API_URL },
  entries,
};
fs.writeFileSync(OUT, JSON.stringify(corpus, null, 0));

const done = seen.size + batches.slice(0, batchNo).flat().length;
const byGame = new Map<string, number>();
for (const e of entries) for (const g of e.games) byGame.set(g.game, (byGame.get(g.game) ?? 0) + 1);

console.error(`\n\n=== ingest ${done >= titles.length ? "complete" : "checkpointed"} ===`);
console.error(`requests:  ${client.requestCount}`);
console.error(`entries:   ${entries.length}  (+${added} this run)`);
console.error(`coverage:  ${Math.min(done, titles.length)}/${titles.length} titles`);
console.error(`watermark: ${watermark}`);
console.error(`per game:  ${[...byGame].map(([g, n]) => `${g}=${n}`).join("  ")}`);
if (unknownGames.size) console.error(`UNKNOWN game codes: ${[...unknownGames].join(", ")}`);
if (recordedQuarantine.size) {
  console.error(`quarantined: ${recordedQuarantine.size} page(s) the wiki refused to serve`);
  for (const q of recordedQuarantine) console.error(`  - ${q}`);
}
console.error(`written:   ${OUT}`);
