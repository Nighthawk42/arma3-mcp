/**
 * Incremental corpus update.
 *
 * The expensive part of ingest is fetching 4,700 pages. Almost none of them
 * change in a given week, so this asks the wiki what actually changed since the
 * corpus watermark and refetches only that. A typical run is 2-5 requests.
 *
 *   npx tsx scripts/update.ts
 *
 * Exits 0 with no changes written when nothing relevant changed, so CI can
 * skip the commit.
 */
import fs from "node:fs";
import path from "node:path";
import { WikiClient, chunk } from "../src/wiki/client.js";
import { parseRvPage } from "../src/wiki/rv-parser.js";
import type { Corpus, Entry } from "../src/types.js";

const OUT = path.resolve("data/corpus.json");

if (!fs.existsSync(OUT)) {
  console.error("no data/corpus.json — run `npm run ingest` for the initial build");
  process.exit(1);
}

const corpus: Corpus = JSON.parse(fs.readFileSync(OUT, "utf8"));
if (!corpus.watermark) {
  console.error("corpus has no watermark; run a full ingest");
  process.exit(1);
}

const client = new WikiClient({ log: (m) => console.error(m) });
const byId = new Map(corpus.entries.map((e) => [e.id, e]));
const knownTitles = new Set(corpus.entries.map((e) => e.title));

console.error(`corpus: ${corpus.entries.length} entries, watermark ${corpus.watermark}`);

const { titles: changed, latest } = await client.changedSince(corpus.watermark);
console.error(`${changed.length} page(s) edited since the watermark`);

// Only refetch pages we already track. A brand-new command page is picked up by
// the next full ingest; recentchanges alone cannot tell us it belongs to a
// category we care about without an extra request per page.
const relevant = changed.filter((t) => knownTitles.has(t));
console.error(`${relevant.length} of them are pages we track`);

let updated = 0;
let removed = 0;

for (const batch of chunk(relevant)) {
  const pages = await client.fetchWikitext(batch);
  for (const page of pages) {
    if (page.missing || !page.wikitext || !page.revision) continue;
    const result = parseRvPage({
      title: page.title,
      wikitext: page.wikitext,
      url: client.pageUrl(page.title),
      revision: page.revision,
    });
    if (result.entry) {
      byId.set(result.entry.id, result.entry);
      updated++;
    } else {
      // The page stopped qualifying (e.g. its last included game tag went away).
      const stale = [...byId.values()].find((e) => e.title === page.title);
      if (stale) {
        byId.delete(stale.id);
        removed++;
      }
    }
  }
}

if (updated === 0 && removed === 0 && latest === corpus.watermark) {
  console.error("no changes — corpus left untouched");
  process.exit(0);
}

const entries: Entry[] = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(
  OUT,
  JSON.stringify(
    { ...corpus, generatedAt: new Date().toISOString(), watermark: latest, entries },
    null,
    0,
  ),
);

console.error(`updated ${updated}, removed ${removed}; ${entries.length} entries total`);
console.error(`requests: ${client.requestCount}; new watermark ${latest}`);
