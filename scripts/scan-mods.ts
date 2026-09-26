/**
 * Scan an Arma install (base game + mods) into a classname corpus.
 *
 * Entirely offline: it reads PBOs from disk and never touches the network.
 * Because the resulting corpus reflects one machine's mod set, it is written
 * to data/classes.json and left untracked by default — see README.
 *
 *   npx tsx scripts/scan-mods.ts "D:/SteamLibrary/steamapps/common/Arma 3"
 */
import fs from "node:fs";
import path from "node:path";
import { extractFromPbo } from "../src/config/pbo.js";
import { derapify, isRapified } from "../src/config/rapify.js";
import { parseConfigCpp } from "../src/config/cpp-parser.js";
import { isCuratedMod } from "../src/config/curated.js";
import zlib from "node:zlib";
import {
  collectClasses,
  parseStringtable,
  resolveClasses,
  type ClassEntry,
} from "../src/config/classes.js";

const gameDir = process.argv[2] ?? "D:/SteamLibrary/steamapps/common/Arma 3";

/**
 * `--curated` scans only the widely used mods and writes a gzipped file meant
 * to be committed, so users get a useful classname index without owning every
 * mod. Without it, the scan covers the whole install and stays local.
 */
const curated = process.argv.includes("--curated");
const outFile = path.resolve(curated ? "data/classes-curated.json.gz" : "data/classes.json");
const only = process.argv.slice(3).find((a) => !a.startsWith("--"));

/** Directories that hold addon PBOs: the base game plus every @Mod folder. */
function addonRoots(root: string): Array<{ mod: string; dir: string }> {
  const roots: Array<{ mod: string; dir: string }> = [];

  for (const base of ["Addons", "Curator/Addons", "Expansion/Addons", "Heli/Addons", "Jets/Addons", "Mark/Addons", "Kart/Addons", "Orange/Addons", "Argo/Addons", "Tank/Addons", "Tacops/Addons", "Contact/Addons", "Enoch/Addons", "Expansion/Addons"]) {
    const dir = path.join(root, base);
    if (fs.existsSync(dir)) roots.push({ mod: "@ArmA3", dir });
  }

  const workshop = path.join(root, "!Workshop");
  if (fs.existsSync(workshop)) {
    for (const name of fs.readdirSync(workshop)) {
      if (!name.startsWith("@")) continue;
      const dir = path.join(workshop, name, "addons");
      // Symlinked workshop folders resolve transparently.
      if (fs.existsSync(dir)) roots.push({ mod: name, dir });
    }
  }
  return roots;
}

const roots = addonRoots(gameDir)
  .filter((r) => !only || r.mod.toLowerCase().includes(only.toLowerCase()))
  .filter((r) => !curated || isCuratedMod(r.mod));
console.error(`scanning ${roots.length} addon folders under ${gameDir}`);

const raw: ClassEntry[] = [];
const strings = new Map<string, string>();
let pboCount = 0;
let textConfigs = 0;
let failures = 0;

for (const { mod, dir } of roots) {
  let pbos: string[];
  try {
    pbos = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pbo"));
  } catch {
    continue;
  }
  for (const pbo of pbos) {
    pboCount++;
    const file = path.join(dir, pbo);
    let members;
    try {
      members = extractFromPbo(file, (n) => {
        const lower = n.toLowerCase();
        return lower.endsWith("config.bin") || lower.endsWith("config.cpp") || lower.endsWith("stringtable.xml");
      });
    } catch (e) {
      failures++;
      continue;
    }

    for (const f of members.files) {
      const lower = f.name.toLowerCase();
      try {
        if (lower.endsWith("stringtable.xml")) {
          for (const [k, v] of parseStringtable(f.data.toString("utf8"))) strings.set(k, v);
          continue;
        }
        // ~7% of addons ship text configs; both forms yield the same shape.
        const root = isRapified(f.data)
          ? derapify(f.data)
          : parseConfigCpp(f.data.toString("utf8"));
        if (!isRapified(f.data)) textConfigs++;
        raw.push(...collectClasses(root, { mod, addon: path.basename(pbo, ".pbo") }));
      } catch {
        failures++;
      }
    }
  }
  process.stderr.write(`  ${mod}: ${raw.length} classes so far\r`);
}

console.error(`\nresolving inheritance across ${raw.length} class definitions...`);
const resolved = resolveClasses(raw, strings);

// Public classes are what people script and place; keep the rest but mark them.
const publicCount = resolved.filter((c) => (c.scope ?? 0) >= 2).length;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const payload = JSON.stringify({
  schema: 1,
  generatedAt: new Date().toISOString(),
  curated,
  // The scanning machine's path is not interesting to anyone else, and the
  // committed file should not leak it.
  source: { mods: roots.length, ...(curated ? {} : { gameDir }) },
  classes: resolved,
});
// The curated file is committed, so it is gzipped: ~5x smaller in git.
fs.writeFileSync(outFile, curated ? zlib.gzipSync(payload, { level: 9 }) : payload);

console.error(
  [
    `pbos scanned:       ${pboCount}`,
    `class definitions:  ${raw.length}`,
    `stringtable keys:   ${strings.size}`,
    `scope>=2 (public):  ${publicCount}`,
    `text config.cpp:    ${textConfigs} (parsed)`,
    `failures:           ${failures}`,
    `mods scanned:       ${roots.length}${curated ? " (curated set)" : ""}`,
    `written:            ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`,
  ].join("\n"),
);
