import { describe, expect, it } from "vitest";
import { splitIdentifier, ftsQuery, fuse } from "../src/index/store.js";

describe("splitIdentifier", () => {
  it("splits camelCase and underscores into words", () => {
    expect(splitIdentifier("BIS_fnc_arrayShuffle")).toBe("BIS fnc array Shuffle");
    expect(splitIdentifier("setPosATL")).toBe("set Pos ATL");
  });

  it("keeps an all-lowercase name intact", () => {
    expect(splitIdentifier("player")).toBe("player");
  });

  it("separates a trailing word from an acronym run", () => {
    expect(splitIdentifier("HTTPRequest")).toBe("HTTP Request");
  });
});

describe("ftsQuery", () => {
  it("quotes each token so FTS operators cannot leak in", () => {
    expect(ftsQuery('setPos OR "x"')).toBe('"setPos" OR "OR" OR "x"');
  });

  it("returns empty for a query with no usable tokens", () => {
    expect(ftsQuery("!!!")).toBe("");
  });
});

describe("fuse", () => {
  it("ranks a result found by several arms above one found by a single arm", () => {
    const scores = fuse([
      { name: "a", ids: [1, 2] },
      { name: "b", ids: [2, 3] },
    ]);
    expect(scores.get(2)!.score).toBeGreaterThan(scores.get(1)!.score);
    expect(scores.get(2)!.matched).toEqual(["a", "b"]);
  });

  it("lets a weighted arm outrank a noisier one", () => {
    // The precise arm ranks id 9 first; the noisy arm ranks it last.
    const scores = fuse([
      { name: "precise", ids: [9], weight: 3 },
      { name: "noisy", ids: [1, 2, 3, 9], weight: 1 },
    ]);
    expect(scores.get(9)!.score).toBeGreaterThan(scores.get(1)!.score);
  });
});
