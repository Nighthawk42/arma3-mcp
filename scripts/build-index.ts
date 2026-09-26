/**
 * Build data/index.sqlite from the corpora.
 *
 * Runs offline against data/corpus.json (wiki, tracked in git) and, when
 * present, data/classes.json (classnames, machine-specific and untracked).
 *
 *   npx tsx scripts/build-index.ts
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { openDatabase, createSchema, entryText, classText } from "../src/index/store.js";
import { embed, toBlob } from "../src/index/embed.js";
import type { Corpus } from "../src/types.js";
import type { ClassEntry } from "../src/config/classes.js";

const DATA = path.resolve("data");
const OUT = path.join(DATA, "index.sqlite");

for (const stale of [OUT, `${OUT}-wal`, `${OUT}-shm`]) {
  if (fs.existsSync(stale)) fs.unlinkSync(stale);
}

const db = openDatabase(OUT);
createSchema(db);

const setMeta = db.prepare("insert or replace into meta(key, value) values (?, ?)");

// --- wiki corpus ------------------------------------------------------------
const corpusFile = path.join(DATA, "corpus.json");
let entryCount = 0;
if (fs.existsSync(corpusFile)) {
  const corpus: Corpus = JSON.parse(fs.readFileSync(corpusFile, "utf8"));
  const insEntry = db.prepare(
    "insert into entries(id, name, title, type, games, groups, data, url) values (?,?,?,?,?,?,?,?)",
  );
  const insFts = db.prepare("insert into entries_fts(rowid, name, body) values (?,?,?)");
  const insExample = db.prepare("insert into examples(id, entry_id, code) values (?,?,?)");
  const insExampleFts = db.prepare("insert into examples_fts(rowid, code) values (?,?)");
  let exampleId = 0;

  const texts: string[] = [];
  db.transaction(() => {
    corpus.entries.forEach((entry, i) => {
      const id = i + 1;
      insEntry.run(
        id,
        entry.name,
        entry.title,
        entry.type,
        JSON.stringify(entry.games),
        JSON.stringify(entry.groups),
        JSON.stringify(entry),
        entry.url,
      );
      const text = entryText(entry);
      insFts.run(id, entry.name, text);
      for (const ex of entry.examples) {
        exampleId++;
        insExample.run(exampleId, id, ex.code);
        insExampleFts.run(exampleId, `${entry.name} ${ex.code}`);
      }
      texts.push(`${entry.name}. ${entry.description}`.slice(0, 512));
    });
  })();
  entryCount = corpus.entries.length;
  setMeta.run("corpus.generatedAt", corpus.generatedAt);
  setMeta.run("corpus.watermark", corpus.watermark);

  // Vector arm — wiki prose only. Classnames are identifiers and are far better
  // served by the lexical arm, so embedding 100k of them would cost an hour of
  // CPU to make search worse.
  console.error(`embedding ${texts.length} wiki entries...`);
  const insVec = db.prepare("insert into entries_vec(rowid, embedding) values (?, ?)");
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const vectors = await embed(texts.slice(i, i + BATCH));
    db.transaction(() => {
      vectors.forEach((v, j) => insVec.run(BigInt(i + j + 1), toBlob(v)));
    })();
    process.stderr.write(`  ${Math.min(i + BATCH, texts.length)}/${texts.length}\r`);
  }
  console.error("");
} else {
  console.error("data/corpus.json missing — run `npm run ingest` first");
}

// --- classname corpus -------------------------------------------------------
//
// A local full scan wins when present: it covers every mod on this machine and
// is a superset of the curated set. Otherwise fall back to the curated file
// that ships with the package, so the tools still work without the mods
// installed. They are not merged — that would double-count mods in both.
const localFile = path.join(DATA, "classes.json");
const curatedFile = path.join(DATA, "classes-curated.json.gz");
const classesFile = fs.existsSync(localFile) ? localFile : curatedFile;
let classCount = 0;
if (fs.existsSync(classesFile)) {
  const rawJson = classesFile.endsWith(".gz")
    ? zlib.gunzipSync(fs.readFileSync(classesFile)).toString("utf8")
    : fs.readFileSync(classesFile, "utf8");
  const payload: { generatedAt: string; classes: ClassEntry[] } = JSON.parse(rawJson);
  console.error(`classnames from ${path.basename(classesFile)}`);
  const insClass = db.prepare(
    "insert into classes(id, name, root, parent, displayName, scope, mod, addon, data) values (?,?,?,?,?,?,?,?,?)",
  );
  const insFts = db.prepare("insert into classes_fts(rowid, name, body) values (?,?,?)");
  db.transaction(() => {
    payload.classes.forEach((cls, i) => {
      const id = i + 1;
      insClass.run(
        id,
        cls.name,
        cls.root,
        cls.parent,
        cls.displayName ?? null,
        cls.scope ?? null,
        cls.mod,
        cls.addon,
        JSON.stringify(cls),
      );
      insFts.run(id, cls.name, classText(cls));
    });
  })();
  classCount = payload.classes.length;
  setMeta.run("classes.generatedAt", payload.generatedAt);
  setMeta.run("classes.source", path.basename(classesFile));
} else {
  console.error("data/classes.json missing — run `npm run scan` to index local mods");
}

setMeta.run("builtAt", new Date().toISOString());
setMeta.run("entries", String(entryCount));
setMeta.run("classes", String(classCount));
db.exec("vacuum");
db.close();

console.error(`index built: ${entryCount} wiki entries, ${classCount} classes -> ${OUT}`);
console.error(`size: ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
