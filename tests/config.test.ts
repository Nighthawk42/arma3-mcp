import { describe, expect, it } from "vitest";
import { decompressLzss } from "../src/config/pbo.js";
import { parseConfigCpp, preprocess } from "../src/config/cpp-parser.js";
import { child, propString, propNumber } from "../src/config/rapify.js";
import { parseStringtable, resolveClasses, type ClassEntry } from "../src/config/classes.js";

/**
 * Encode with the same scheme the decoder expects: flag byte with one bit per
 * following item, LSB first, set = literal.
 */
function encodeLiterals(bytes: number[]): Buffer {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 8) {
    const chunk = bytes.slice(i, i + 8);
    out.push((1 << chunk.length) - 1); // all literals
    out.push(...chunk);
  }
  return Buffer.from(out);
}

describe("decompressLzss", () => {
  it("round-trips a pure-literal stream", () => {
    const data = [...Buffer.from("hello world", "ascii")];
    expect(decompressLzss(encodeLiterals(data), data.length).toString()).toBe("hello world");
  });

  it("treats the reference as a distance back from the output position", () => {
    // "abcabc": literals a,b,c then a back-reference 3 bytes back, length 3.
    const src = Buffer.from([
      0b00000111, // three literals, then a reference
      0x61,
      0x62,
      0x63,
      0x03, // low 8 bits of distance = 3
      0x00, // high nibble of distance = 0, length nibble 0 -> 3 bytes
    ]);
    expect(decompressLzss(src, 6).toString()).toBe("abcabc");
  });

  it("resolves references before the start of output as zero", () => {
    const src = Buffer.from([0b00000010, 0x41, 0x00, 0x00]);
    const out = decompressLzss(src, 4);
    // A reference reaching back past position 0 yields NULs, not spaces —
    // getting this wrong silently corrupts rapified headers.
    expect([...out.subarray(1)]).toEqual([0, 0, 0]);
  });
});

describe("config.cpp preprocessing", () => {
  it("removes comments but keeps line count stable", () => {
    const src = 'a = 1; // note\n/* block\nspanning */ b = 2;';
    const out = preprocess(src);
    expect(out).not.toContain("note");
    expect(out).not.toContain("spanning");
    expect(out).toContain("b = 2;");
  });

  it("does not treat comment markers inside strings as comments", () => {
    const out = preprocess('path = "a//b";');
    expect(out).toContain('"a//b"');
  });

  it("drops preprocessor directives including continuations", () => {
    const out = preprocess('#define X(a) \\\n  a + 1\nvalue = 3;');
    expect(out).not.toContain("define");
    expect(out).toContain("value = 3;");
  });
});

describe("parseConfigCpp", () => {
  const source = `
    class CfgPatches {
      class my_addon {
        units[] = {"my_car"};
        requiredVersion = 1.0;
      };
    };
    class CfgVehicles {
      class Car;
      class my_car : Car {
        scope = 2;
        displayName = "My Car";
        crew = "B_Soldier_F";
        hiddenSelections[] = {"camo1", "camo2"};
      };
    };
  `;

  it("builds the class tree with parents", () => {
    const root = parseConfigCpp(source);
    const vehicles = child(root, "CfgVehicles");
    expect(vehicles).toBeTruthy();
    const car = child(vehicles!, "my_car");
    expect(car?.parent).toBe("Car");
  });

  it("reads scalar properties with correct types", () => {
    const car = child(child(parseConfigCpp(source), "CfgVehicles")!, "my_car")!;
    expect(propNumber(car, "scope")).toBe(2);
    expect(propString(car, "displayName")).toBe("My Car");
  });

  it("reads array properties", () => {
    const car = child(child(parseConfigCpp(source), "CfgVehicles")!, "my_car")!;
    expect(car.properties.get("hiddenSelections")).toEqual(["camo1", "camo2"]);
  });

  it("is case-insensitive on lookup, like the engine", () => {
    const root = parseConfigCpp(source);
    expect(child(root, "cfgvehicles")).toBeTruthy();
  });

  it("ignores forward declarations rather than creating empty classes", () => {
    const vehicles = child(parseConfigCpp(source), "CfgVehicles")!;
    // `class Car;` is a declaration; only my_car is a real definition here.
    expect(child(vehicles, "Car")).toBeUndefined();
  });

  it("survives a macro it cannot expand", () => {
    const root = parseConfigCpp('class A { MACRO_THING(x); scope = 2; };');
    expect(propNumber(child(root, "A")!, "scope")).toBe(2);
  });
});

describe("parseStringtable", () => {
  it("extracts English values and unescapes entities", () => {
    const table = parseStringtable(
      '<Key ID="STR_A"><English>Fire &amp; Movement</English></Key>',
    );
    expect(table.get("str_a")).toBe("Fire & Movement");
  });

  it("handles CDATA", () => {
    const table = parseStringtable('<Key ID="STR_B"><English><![CDATA[T-72B]]></English></Key>');
    expect(table.get("str_b")).toBe("T-72B");
  });
});

describe("resolveClasses", () => {
  const base = (over: Partial<ClassEntry>): ClassEntry => ({
    name: "x",
    root: "CfgVehicles",
    parent: "",
    ancestors: [],
    mod: "@Test",
    addon: "test",
    ...over,
  });

  it("inherits scope and displayName from an ancestor", () => {
    const resolved = resolveClasses(
      [
        base({ name: "Tank_F", scope: 2, displayName: "Tank" }),
        base({ name: "my_tank", parent: "Tank_F" }),
      ],
      new Map(),
    );
    const mine = resolved.find((c) => c.name === "my_tank")!;
    expect(mine.scope).toBe(2);
    expect(mine.displayName).toBe("Tank");
    expect(mine.ancestors).toEqual(["Tank_F"]);
  });

  it("prefers a class's own value over an inherited one", () => {
    const resolved = resolveClasses(
      [
        base({ name: "Tank_F", scope: 2 }),
        base({ name: "hidden_tank", parent: "Tank_F", scope: 0 }),
      ],
      new Map(),
    );
    expect(resolved.find((c) => c.name === "hidden_tank")!.scope).toBe(0);
  });

  it("resolves stringtable keys in display names", () => {
    const resolved = resolveClasses(
      [base({ name: "t", displayName: "$STR_T72" })],
      new Map([["str_t72", "T-72B"]]),
    );
    expect(resolved[0].displayName).toBe("T-72B");
  });

  it("does not loop on a cyclic inheritance chain", () => {
    const resolved = resolveClasses(
      [base({ name: "a", parent: "b" }), base({ name: "b", parent: "a" })],
      new Map(),
    );
    expect(resolved).toHaveLength(2);
    expect(resolved[0].ancestors.length).toBeLessThan(4);
  });
});
