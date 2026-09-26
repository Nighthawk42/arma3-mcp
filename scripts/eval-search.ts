/**
 * Search relevance check against tests/search-eval.json.
 *
 * Reports hit@1, hit@3 and MRR over the local index, plus every query whose
 * best answer is not first. Use it before and after touching ranking.
 *
 *   npm run eval            # summary + misses
 *   npm run eval -- --all   # every query
 */
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/index/store.js";
import { searchEntries } from "../src/index/query.js";
import { resolveIndexPath } from "../src/server.js";

interface EvalCase {
  query: string;
  expect: string[];
}

export interface EvalResult {
  query: string;
  expect: string[];
  got: string[];
  /** 1-based rank of the first acceptable answer, 0 when absent from the top 10. */
  rank: number;
}

export async function runEval(dbPath = resolveIndexPath()): Promise<{
  results: EvalResult[];
  hit1: number;
  hit3: number;
  mrr: number;
}> {
  const cases = (
    JSON.parse(fs.readFileSync(path.resolve("tests/search-eval.json"), "utf8")) as { queries: EvalCase[] }
  ).queries;
  const db = openDatabase(dbPath, true);
  const results: EvalResult[] = [];
  for (const c of cases) {
    const hits = await searchEntries(db, c.query, { limit: 10 });
    const got = hits.map((h) => h.entry.name);
    const accepted = new Set(c.expect.map((e) => e.toLowerCase()));
    const index = got.findIndex((g) => accepted.has(g.toLowerCase()));
    results.push({ query: c.query, expect: c.expect, got, rank: index + 1 });
  }
  db.close();
  const n = results.length;
  return {
    results,
    hit1: results.filter((r) => r.rank === 1).length / n,
    hit3: results.filter((r) => r.rank >= 1 && r.rank <= 3).length / n,
    mrr: results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n,
  };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("eval-search.ts")) {
  const all = process.argv.includes("--all");
  const { results, hit1, hit3, mrr } = await runEval();
  for (const r of results) {
    if (!all && r.rank === 1) continue;
    const mark = r.rank === 1 ? "ok " : r.rank ? `#${r.rank} ` : "-- ";
    console.log(`${mark} ${r.query.padEnd(52)} want ${r.expect[0]}; got ${r.got.slice(0, 3).join(", ")}`);
  }
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  console.log(`\n${results.length} queries  hit@1 ${pct(hit1)}  hit@3 ${pct(hit3)}  MRR ${mrr.toFixed(3)}`);
}
