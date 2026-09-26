import { beforeAll, describe, expect, it } from "vitest";
import { createSchema, openDatabase, type Db } from "../src/index/store.js";
import { compareVersions, stripNonCode, validateSqf } from "../src/sqf/validate.js";

let db: Db;

function entry(name: string, games: Array<[string, string]>, extra: Record<string, unknown> = {}) {
  return {
    name,
    title: name,
    type: "command",
    games: games.map(([game, since]) => ({ game, since })),
    groups: [],
    description: "",
    syntaxes: [],
    examples: [],
    url: `https://community.bistudio.com/wiki/${name}`,
    ...extra,
  };
}

beforeAll(() => {
  db = openDatabase(":memory:");
  createSchema(db);
  const rows = [
    entry("setDamage", [["ofp", "1.00"], ["arma3", "0.50"]], { locality: { effect: "global" } }),
    entry("hint", [["ofp", "1.00"], ["arma3", "0.50"]]),
    entry("player", [["ofp", "1.00"], ["arma3", "0.50"]]),
    entry("remoteExec", [["arma3", "1.50"]]),
    entry("ctrlSetURL", [["arma3", "2.14"]]),
    entry("oldThing", [["arma3", "0.50"]], { description: "Deprecated. Use newThing instead." }),
  ];
  const insert = db.prepare(
    "insert into entries(id, name, title, type, games, groups, data, url) values (?,?,?,?,?,?,?,?)",
  );
  rows.forEach((e, i) =>
    insert.run(i + 1, e.name, e.title, e.type, JSON.stringify(e.games), "[]", JSON.stringify(e), e.url),
  );
});

describe("compareVersions", () => {
  it("orders wiki versions numerically", () => {
    expect(compareVersions("2.08", "2.10")).toBeLessThan(0);
    expect(compareVersions("2.14", "2.10")).toBeGreaterThan(0);
    expect(compareVersions("1.50", "1.50")).toBe(0);
  });
});

describe("stripNonCode", () => {
  it("blanks strings and comments but keeps line numbers", () => {
    const out = stripNonCode('hint "setDamage"; // setDamage\n/* a\nb */ player');
    expect(out).not.toContain("setDamage");
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("player");
  });

  it("handles doubled quotes inside strings", () => {
    expect(stripNonCode('hint "say ""hi"" setDamage"; player')).not.toContain("setDamage");
  });
});

describe("validateSqf", () => {
  it("stays quiet about commands that shipped with the game", () => {
    const { findings, recognised } = validateSqf(db, "hint str player;", { game: "arma3" });
    expect(findings).toEqual([]);
    expect(recognised).toEqual(["hint", "player"]);
  });

  it("mentions later additions as info without a target version", () => {
    const { findings } = validateSqf(db, "_c ctrlSetURL 'x';", { game: "arma3" });
    expect(findings).toMatchObject([{ severity: "info", identifier: "ctrlSetURL" }]);
  });

  it("errors on commands newer than the target version", () => {
    const code = "_c ctrlSetURL 'x';\n[] remoteExec ['hint'];";
    const { findings } = validateSqf(db, code, { game: "arma3", gameVersion: "2.10" });
    expect(findings).toEqual([
      expect.objectContaining({ severity: "error", identifier: "ctrlSetURL", line: 1 }),
    ]);
    expect(validateSqf(db, code, { game: "arma3", gameVersion: "2.18" }).findings).toEqual([]);
  });

  it("errors on commands missing from the target game", () => {
    const { findings } = validateSqf(db, "[] remoteExec ['hint'];", { game: "ofp" });
    expect(findings).toMatchObject([{ severity: "error", identifier: "remoteExec" }]);
  });

  it("warns once about global effects and deprecation", () => {
    const { findings } = validateSqf(db, "player setDamage 1;\nplayer setDamage 0;\noldThing;", {
      game: "arma3",
    });
    expect(findings.map((f) => [f.identifier, f.severity])).toEqual([
      ["setDamage", "warning"],
      ["oldThing", "warning"],
    ]);
    expect(
      validateSqf(db, "player setDamage 1;", { game: "arma3", flagGlobalEffects: false }).findings,
    ).toEqual([]);
  });

  it("lists unknown identifiers without judging them, and skips locals", () => {
    const { findings, unrecognised } = validateSqf(db, "_x = frobnicate player; if (true) then {};");
    expect(findings).toEqual([]);
    expect(unrecognised).toEqual(["frobnicate"]);
  });
});
