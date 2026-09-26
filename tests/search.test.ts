import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { looksLikeIdentifier, stem } from "../src/index/query.js";
import { resolveIndexPath } from "../src/server.js";
import { runEval } from "../scripts/eval-search.js";

describe("query helpers", () => {
  it("stems plurals and gerunds without mangling short words", () => {
    expect(stem("units")).toBe("unit");
    expect(stem("spawning")).toBe("spawn");
    expect(stem("entities")).toBe("entity");
    expect(stem("boxes")).toBe("box");
    expect(stem("class")).toBe("class");
    expect(stem("is")).toBe("is");
  });

  it("tells identifiers from sentences", () => {
    expect(looksLikeIdentifier("setPosATL")).toBe(true);
    expect(looksLikeIdentifier("BIS_fnc_MP")).toBe(true);
    expect(looksLikeIdentifier(" remoteExec ")).toBe(true);
    expect(looksLikeIdentifier("spawn a group")).toBe(false);
    expect(looksLikeIdentifier("a + b")).toBe(false);
  });
});

// Relevance floor over tests/search-eval.json. Needs a built index (the
// corpus is tracked, but the index and embedding model are local), so it is
// skipped where none exists. Measured when set: hit@1 54%, hit@3 78%, MRR 0.671.
describe.skipIf(!fs.existsSync(resolveIndexPath()))("search relevance", () => {
  it("keeps ranking at or above the recorded baseline", async () => {
    const { results, hit1, hit3, mrr } = await runEval();
    const identifierMisses = results.filter((r) => !r.query.includes(" ") && r.rank !== 1);
    expect(identifierMisses, "an exact identifier must always rank first").toEqual([]);
    expect(hit1).toBeGreaterThanOrEqual(0.5);
    expect(hit3).toBeGreaterThanOrEqual(0.74);
    expect(mrr).toBeGreaterThanOrEqual(0.65);
  }, 120_000);
});
