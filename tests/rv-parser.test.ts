import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRvPage,
  assignParamToSyntax,
  identifierFor,
  slugify,
  cleanVersion,
} from "../src/wiki/rv-parser.js";
import { splitTopLevel, extractAllTemplates, toMarkdown } from "../src/wiki/wikitext.js";
import { resolveGameCode } from "../src/games.js";

const DIR = path.resolve("tests/fixtures");
const fixture = (name: string) => fs.readFileSync(path.join(DIR, `${name}.wikitext`), "utf8");
const parse = (name: string, title = name) =>
  parseRvPage({
    title,
    wikitext: fixture(name),
    url: `https://community.bistudio.com/wiki/${title}`,
    revision: { id: 1, timestamp: "2024-01-01T00:00:00Z" },
  });

describe("splitTopLevel", () => {
  it("does not split on pipes inside nested templates or links", () => {
    const parts = splitTopLevel("RV|a= 1|b= {{Feature|informative|x|y}}|c= [[Link|label]]|d= 4");
    expect(parts).toHaveLength(5);
    expect(parts[2]).toBe("b= {{Feature|informative|x|y}}");
    expect(parts[3]).toBe("c= [[Link|label]]");
  });

  it("keeps nowiki spans intact", () => {
    const parts = splitTopLevel("RV|a= <nowiki>x|y</nowiki>|b= 2");
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe("a= <nowiki>x|y</nowiki>");
  });
});

describe("extractAllTemplates", () => {
  it("finds every RV block, not just the first", () => {
    // addAction carries an OFP-era block and a separate Arma 3 block.
    expect(extractAllTemplates(fixture("addAction"), "RV").length).toBeGreaterThan(1);
  });
});

describe("assignParamToSyntax", () => {
  it("maps p1..p9 to syntax 1", () => {
    expect(assignParamToSyntax("3", new Set([1, 2]))).toEqual({ syntax: 1, order: 3 });
  });

  it("maps p21 to syntax 2 when syntax 2 exists", () => {
    expect(assignParamToSyntax("21", new Set([1, 2]))).toEqual({ syntax: 2, order: 1 });
  });

  it("falls back to syntax 1 when the prefixed syntax does not exist", () => {
    expect(assignParamToSyntax("21", new Set([1]))).toEqual({ syntax: 1, order: 21 });
  });
});

describe("identifierFor", () => {
  it("restores underscores MediaWiki turns into spaces", () => {
    expect(identifierFor("diag log")).toBe("diag_log");
    expect(identifierFor("BIS fnc spawnGroup")).toBe("BIS_fnc_spawnGroup");
  });

  it("leaves operator pages alone", () => {
    expect(identifierFor("! a")).toBe("! a");
    expect(identifierFor("a + b")).toBe("a + b");
  });
});

describe("slugify", () => {
  it("produces distinct slugs for operator pages", () => {
    expect(slugify("! a")).not.toBe(slugify("a + b"));
  });
});

describe("cleanVersion", () => {
  it("keeps a plain version", () => {
    expect(cleanVersion("1.50")).toBe("1.50");
  });

  it("strips an editor's HTML comment", () => {
    // Left as-is this splits one release into several in version listings.
    expect(cleanVersion("2.02 <!-- 2.04 for the alt syntax -->")).toBe("2.02");
  });

  it("handles an unterminated comment", () => {
    expect(cleanVersion("1.00 <!-- note")).toBe("1.00");
  });

  it("returns empty for a missing value", () => {
    expect(cleanVersion(undefined)).toBe("");
  });
});

describe("game resolution", () => {
  it("excludes Take On Helicopters", () => {
    expect(resolveGameCode("tkoh")).toEqual({ excluded: true });
  });

  it("resolves canonical ids and aliases", () => {
    expect(resolveGameCode("arma3")).toEqual({ id: "arma3" });
    expect(resolveGameCode("arma3dev")).toEqual({ id: "arma3" });
  });

  it("reports codes it does not know rather than dropping them", () => {
    expect(resolveGameCode("armaFuture")).toEqual({ unknown: "armafuture" });
  });
});

describe("parseRvPage", () => {
  it("parses an Arma 3-only command with full structure", () => {
    const { entry } = parse("remoteExec");
    expect(entry).toBeTruthy();
    expect(entry!.name).toBe("remoteExec");
    expect(entry!.type).toBe("command");
    expect(entry!.games).toEqual([{ game: "arma3", since: "1.50" }]);
    expect(entry!.groups).toContain("Multiplayer");
    expect(entry!.syntaxes.length).toBeGreaterThanOrEqual(2);
    expect(entry!.examples.length).toBeGreaterThan(0);
    expect(entry!.seeAlso).toContain("remoteExecCall");
  });

  it("merges multiple RV blocks so no game is lost", () => {
    // The Arma 3 block is the second one on the page.
    const { entry } = parse("addAction");
    const games = entry!.games.map((g) => g.game);
    expect(games).toContain("ofp");
    expect(games).toContain("arma3");
  });

  it("drops Take On Helicopters but keeps the rest of the page", () => {
    const { entry } = parse("addAction");
    expect(entry!.games.map((g) => g.game)).not.toContain("tkoh");
  });

  it("recovers a page whose first block is TKOH-only", () => {
    const { entry } = parse("BIS_fnc_MP", "BIS fnc MP");
    expect(entry).toBeTruthy();
    expect(entry!.name).toBe("BIS_fnc_MP");
    expect(entry!.type).toBe("function");
    expect(entry!.games.map((g) => g.game)).toEqual(["arma3"]);
  });

  it("captures per-game introduction versions", () => {
    const { entry } = parse("setPos");
    const ofp = entry!.games.find((g) => g.game === "ofp");
    const arma3 = entry!.games.find((g) => g.game === "arma3");
    expect(ofp?.since).toBe("1.00");
    expect(arma3?.since).toBe("0.50");
  });

  it("captures argument and effect locality", () => {
    const { entry } = parse("setDamage");
    expect(entry!.locality?.argument).toBe("global");
    expect(entry!.locality?.effect).toBe("global");
  });

  it("splits parameters across multiple syntaxes", () => {
    const { entry } = parse("select");
    expect(entry!.syntaxes.length).toBeGreaterThanOrEqual(5);
    expect(entry!.syntaxes.every((s) => s.index > 0)).toBe(true);
  });

  it("marks optional parameters and their defaults", () => {
    const { entry } = parse("remoteExec");
    const params = entry!.syntaxes.flatMap((s) => s.params);
    expect(params.some((p) => p.optional)).toBe(true);
  });

  it("extracts parameter types from wiki links", () => {
    const { entry } = parse("setPos");
    const params = entry!.syntaxes.flatMap((s) => s.params);
    expect(params.some((p) => p.types.length > 0)).toBe(true);
  });

  it("returns a reason instead of throwing on a page with no RV template", () => {
    const result = parseRvPage({
      title: "Nothing",
      wikitext: "Just prose, no template.",
      url: "",
      revision: { id: 0, timestamp: "" },
    });
    expect(result.entry).toBeNull();
    expect(result.skipped).toMatch(/no \{\{RV\}\}/);
  });
});

describe("toMarkdown", () => {
  it("converts links, bold and italics", () => {
    expect(toMarkdown("[[setPos|set it]] and '''bold''' and ''em''")).toBe(
      "set it and **bold** and *em*",
    );
  });

  it("renders sqf blocks as fenced code", () => {
    expect(toMarkdown("<sqf>player setPos [0,0,0];</sqf>")).toContain("```sqf");
  });

  it("turns Feature templates into callouts", () => {
    expect(toMarkdown("{{Feature|important|Careful}}")).toContain("**Warning:** Careful");
  });

  it("leaves code block contents untouched by later markup rules", () => {
    const md = toMarkdown("<sqf>a = ''; b = [[1,2]];</sqf>");
    expect(md).toContain("a = ''");
  });
});
