import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Entry } from "../src/types.js";
import {
  EVENT_HANDLER_PAGES,
  handlerHeading,
  paramsSignature,
  parseEventHandlerPage,
  parseHeading,
  replacePageEntries,
} from "../src/wiki/event-handlers.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "event-handlers");

function parse(title: string): Entry[] {
  const file = path.join(FIXTURES, `${title.replace(/[^A-Za-z0-9]+/g, "_")}.wikitext`);
  return parseEventHandlerPage({
    title,
    wikitext: fs.readFileSync(file, "utf8"),
    url: `https://community.bistudio.com/wiki/${title.replace(/ /g, "_")}`,
    revision: { id: 1, timestamp: "2026-09-01T00:00:00Z" },
  });
}

let byPage: Map<string, Entry[]>;
const find = (page: string, name: string, group?: string) =>
  byPage.get(page)!.find((e) => e.name === name && (!group || e.groups.includes(group)));

beforeAll(() => {
  byPage = new Map(EVENT_HANDLER_PAGES.map((t) => [t, parse(t)]));
});

describe("headings", () => {
  it("reads plain and ArgTitle headings with their versions", () => {
    expect(parseHeading("=== AnimChanged ===")).toEqual({ level: 3, name: "AnimChanged", games: [] });
    expect(parseHeading("{{ArgTitle|4|BuildingChanged|{{GVI|arma3|1.68}}}}")).toEqual({
      level: 4,
      name: "BuildingChanged",
      games: [{ game: "arma3", since: "1.68" }],
    });
    expect(parseHeading("Some prose")).toBeNull();
  });

  it("tells handlers from groups and keeps target qualifiers apart", () => {
    expect(handlerHeading("HandleDamage")).toEqual({ name: "HandleDamage" });
    expect(handlerHeading("HitPart (Projectile)")).toEqual({ name: "HitPart", qualifier: "Projectile" });
    expect(handlerHeading("Curator Event Handlers")).toBeNull();
    expect(handlerHeading("Events")).toBeNull();
  });

  it("extracts balanced params lists, nested defaults included", () => {
    expect(paramsSignature('params ["_ctrl", ["_config", configNull]];')).toBe(
      'params ["_ctrl", ["_config", configNull]]',
    );
    expect(paramsSignature("hint 'no params';")).toBeNull();
  });
});

describe("reference pages", () => {
  it("finds every handler on each page", () => {
    const counts = Object.fromEntries([...byPage].map(([t, e]) => [t, e.length]));
    expect(counts["Arma 3: Event Handlers"]).toBeGreaterThanOrEqual(140);
    expect(counts["Arma 3: Mission Event Handlers"]).toBeGreaterThanOrEqual(50);
    expect(counts["User Interface Event Handlers"]).toBeGreaterThanOrEqual(50);
    expect(counts["Arma 3: Scripted Event Handlers"]).toBeGreaterThanOrEqual(60);
    for (const entries of byPage.values()) {
      expect(new Set(entries.map((e) => e.id)).size, "ids are unique").toBe(entries.length);
      for (const e of entries) expect(e.type).toBe("eventhandler");
    }
  });

  it("parses a basic handler: signature, typed arguments, locality, commands", () => {
    const e = find("Arma 3: Event Handlers", "HandleDamage")!;
    expect(e.groups).toEqual(["Basic Event Handlers"]);
    expect(e.syntaxes[0]!.signature).toMatch(/^params \["_unit", "_selection", "_damage"/);
    const params = e.syntaxes[0]!.params;
    expect(params.map((p) => p.name)).toEqual(
      expect.arrayContaining(["unit", "selection", "damage", "hitPartIndex", "instigator", "directHit"]),
    );
    expect(params.find((p) => p.name === "hitPartIndex")).toMatchObject({ types: ["Number"] });
    expect(params.find((p) => p.name === "hitPartIndex")!.description).toContain("since 1.50");
    expect(e.seeAlso).toContain("addEventHandler");
    expect(e.url).toBe("https://community.bistudio.com/wiki/Arma_3:_Event_Handlers#HandleDamage");
    expect(e.description).not.toMatch(/\{\{|<sqf>/);
  });

  it("keeps same-named handlers for different targets separate", () => {
    const hitParts = byPage.get("Arma 3: Event Handlers")!.filter((e) => e.name === "HitPart");
    expect(hitParts.length).toBeGreaterThanOrEqual(2);
    expect(hitParts.map((e) => e.groups.at(-1))).toEqual(expect.arrayContaining(["Projectile"]));
  });

  it("inherits locality and version from the group", () => {
    const e = find("Arma 3: Event Handlers", "CuratorObjectPlaced")!;
    expect(e.groups).toEqual(["Curator Event Handlers"]);
    expect(e.locality?.argument).toBe("local");
    expect(e.games).toEqual([{ game: "arma3", since: "1.16" }]);
    expect(e.syntaxes[0]!.params.map((p) => [p.name, p.types])).toEqual([
      ["curator", ["Object"]],
      ["entity", ["Object"]],
    ]);
  });

  it("parses mission and UI handlers", () => {
    expect(find("Arma 3: Mission Event Handlers", "BuildingChanged")).toMatchObject({
      groups: ["Mission Event Handlers"],
      games: [{ game: "arma3", since: "1.68" }],
    });
    const onLoad = find("User Interface Event Handlers", "onLoad")!;
    expect(onLoad.groups).toEqual(["User Interface Event Handlers", "Generic Events"]);
    expect(onLoad.syntaxes[0]!.signature).toBe('params ["_displayOrControl", ["_config", configNull]]');
  });

  it("parses the scripted-event table", () => {
    const e = find("Arma 3: Scripted Event Handlers", "RscDisplayEGSpectator_OnFocusChanged")!;
    expect(e.groups).toEqual(["Scripted Event Handlers", "EG Spectator Display"]);
    expect(e.syntaxes[0]!.signature).toBe('params ["_newFocus"]');
    expect(e.description).toContain("BIS_fnc_addScriptedEventHandler");
    for (const s of byPage.get("Arma 3: Scripted Event Handlers")!) {
      expect(s.groups.join(" "), s.name).not.toMatch(/\[\[|\]\]/);
    }
  });
});

describe("replacePageEntries", () => {
  it("swaps one page's handlers and leaves everything else", () => {
    const other = { ...find("Arma 3: Mission Event Handlers", "BuildingChanged")! };
    const command = { ...other, id: "cmd", type: "command" as const, title: "Arma 3: Event Handlers" };
    const fresh = byPage.get("Arma 3: Event Handlers")!.slice(0, 2);
    const stale = byPage.get("Arma 3: Event Handlers")!;
    const out = replacePageEntries([...stale, other, command], "Arma 3: Event Handlers", fresh);
    expect(out).toHaveLength(4);
    expect(out).toContain(other);
    expect(out).toContain(command);
  });
});
