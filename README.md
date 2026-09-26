# arma-mcp

An MCP server for Bohemia Interactive engine scripting: SQF commands, functions,
event handlers, and config classnames — across Operation Flashpoint, Arma,
Arma 2 and Arma 3.

Everything is served from a **local index**. The server never makes a network
request; the only traffic is a scheduled, deliberately slow ingest.

## What it knows

| Source | Content | Where it comes from |
| --- | --- | --- |
| BI Community Wiki | commands, functions, event handlers, per-game availability | MediaWiki API, ingested offline |
| Your Arma install | config classnames from the base game and every mod you have | PBOs read directly off disk |

Classnames are **generated on your machine, not shipped**: the mods they come
from carry licences that do not permit redistributing derived data (RHS is
CC BY-NC-ND). `npm run scan` builds them from your own installation, which is
what those licences do allow. See [data/NOTICE.md](data/NOTICE.md).

### Games

`ofp`, `ofpe`, `arma1`, `arma2`, `arma2oa`, `arma3`.

Take On Helicopters and VBS are excluded. They share the engine lineage but are
not Arma titles; a page tagged for TKOH *and* an Arma title keeps its Arma tags
and only loses the TKOH one.

Per-game availability is exact, not guessed. Every wiki page declares which
games it applies to and the version of each that introduced it, so
`compare_games` can answer "is `remoteExec` safe in Arma 2?" (no — Arma 3 1.50
onward) directly from the source.

## Tools

**Scripting documentation**

| Tool | Purpose |
| --- | --- |
| `list_games` | Games covered, with entry counts |
| `search` | Find commands/functions by name or by what they do |
| `get_command` | Full docs for one command: syntaxes, params, locality, examples |
| `get_function` | Full docs for one function (`BIS_fnc_*`) |
| `get_event_handler` | Docs for one event handler: arguments, locality, the command that adds it |
| `compare_games` | Availability and introduction version across all games |

**Discovery**

| Tool | Purpose |
| --- | --- |
| `list_groups` | Command groups with counts |
| `browse_group` | Everything in one group |
| `added_in_version` | What a given game version introduced |
| `search_examples` | Search the example code itself, not the prose |

**Config classnames**

| Tool | Purpose |
| --- | --- |
| `search_classes` | Find classnames by name or display name |
| `get_class` | One class: inheritance chain, scope, faction, source mod |
| `find_subclasses` | Everything descending from a base class |
| `list_mods` | Indexed mods with class counts |
| `list_config_roots` | CfgVehicles, CfgWeapons, ... with counts |

**Linting**

| Tool | Purpose |
| --- | --- |
| `validate_sqf` | Check a snippet: unknown commands, wrong game or version, global-effect and deprecation warnings |

`validate_sqf` is the one that earns its keep in practice — it turns the corpus
into a linter that catches "this command does not exist in Arma 2", "this was
added in 2.14 but you target 2.10" (pass `gameVersion`) and "this has a global
effect, so calling it on every client applies it N times".

Every tool is read-only and offline, and says so in its MCP annotations.

Game is a **parameter**, not a separate tool set — one wiki page documents a
command across several games at once, so per-game tools would surface the same
record many times and bloat the tool list.

## Setup

Requires **Node 22.13+** (it uses the built-in `node:sqlite`, so there is no
native addon to rebuild when Node is upgraded).

```bash
npm ci
npm run index     # build data/index.sqlite from the tracked corpus (~1 min)
npm run build
npm run smoke     # verify every tool answers
```

The wiki corpus is committed, so no ingest is needed to get started. `index`
also downloads the embedding model once (~23 MB) into `data/models/`; the
server only ever loads it from there. Without it, search still works on its
lexical arms and logs one line saying semantic search is off.

Classnames come from your own install:

```bash
npm run scan -- "C:/Program Files (x86)/Steam/steamapps/common/Arma 3"   # or set ARMA3_PATH
npm run index
```

`scan` accepts `--curated` to cover only the widely used mods (base game, CBA,
CUP, RHS, ACE and friends) instead of everything installed. Both stay local.
The scripting tools work without `scan`; the class tools report that no index is
present until you run it.

### Registering with an MCP client

Any client that takes an `mcpServers` entry:

```json
{
  "mcpServers": {
    "arma-mcp": { "command": "node", "args": ["/path/to/arma3-mcp/dist/index.js"] }
  }
}
```

Claude Code: `claude mcp add arma-mcp --scope user -- node /path/to/arma3-mcp/dist/index.js`.

Use an absolute path to `node` if your client is launched from a GUI: those do
not always inherit your shell `PATH`. Windows paths in a TOML config (Codex)
must be single-quoted literal strings, or the backslashes become escapes.

| Variable | Effect |
| --- | --- |
| `ARMA_MCP_INDEX` | Use an index from another location |
| `ARMA_MCP_MODEL_DIR` | Embedding model cache (default `data/models`) |
| `ARMA_MCP_INTERVAL_MS` | Ingest pacing between wiki requests (default 5000) |

## Retrieval

Hybrid, because pure vector search is the wrong tool for half of these queries.

- **Wiki entries** — exact/prefix name matching, name-word coverage ("delete a
  vehicle" → `deleteVehicle`), FTS5, and vector similarity over the prose,
  fused with weighted Reciprocal Rank Fusion. An exact identifier always ranks
  first, arm weights shift with the query's shape (identifier or sentence), and
  a small prior favours entries documented across more games. Embeddings are
  `all-MiniLM-L6-v2` running locally via Transformers.js (no API key).
- **Classnames** — lexical only. `rhs_2s1_tv` and `rhs_2s1_vmf` are
  near-identical to an embedding model but mean different vehicles, so exact
  name and display-name matching is what discriminates. Embedding 100k
  identifiers would cost an hour of CPU to make results worse.

Arms are weighted rather than equal. A literal name hit is far stronger evidence
than an FTS token overlap: searching `T-72` tokenises to `t` + `72`, which
matches the unrelated `OZM-72` mine while missing `T-72B`. Weighting lets the
precise arm win.

Ranking is measured, not eyeballed: `npm run eval` scores 50 realistic queries
from `tests/search-eval.json` (hit@1, hit@3, MRR), and the test suite enforces
the recorded floor whenever a local index exists. Change `SEARCH_TUNING` in
`src/index/query.ts` only with that check in hand.

## Ingest, and being a good neighbour

`community.bistudio.com` is behind Cloudflare. Ordinary page requests get a JS
challenge, but `/wikidata/api.php` answers JSON directly — so this project uses
the sanctioned MediaWiki API and never scrapes rendered HTML.

Cloudflare returns 403 for a small number of **specific pages**. This was
isolated by bisection, not guessed at: `BIN fnc droneDestructionFX` fails on its
own, every time, while its neighbours succeed, and batch size, User-Agent, URL
encoding and Node-vs-curl all make no difference. Because the API takes 50
titles per request, one such page fails its entire batch — which is what stalled
early runs and looked, misleadingly, like rate limiting.

The ingest therefore:

- paces requests at one per 5 seconds out of politeness (`ARMA_MCP_INTERVAL_MS`),
- sends `maxlag=5` so it yields when the wiki's replicas are lagging,
- batches 50 titles per request, the anonymous limit — the whole corpus is
  ~100 requests, not ~4,700,
- **bisects a failed batch** to isolate the page at fault, quarantines it, and
  carries on, so one unreachable page costs that page rather than the run,
- **checkpoints every batch**, so an interrupted run resumes instead of
  restarting.

A full ingest is ~100 requests and completes in well under an hour. If a run
stops early, run `npm run ingest` again — it picks up where it left off.
`npm run assemble` rebuilds `data/corpus.json` from whatever checkpoints exist.
The scheduled GitHub Action does the same weekly from a fresh runner, and the
incremental path (`npm run update`) asks the wiki what changed since the last
watermark and refetches only that — usually 2-5 requests.

If you want to cut the load by another order of magnitude, ask the wiki's
administrators for the `bot` flag on an account: MediaWiki grants `apihighlimits`
to that group, raising the cap from 50 to 500 titles per request and turning the
full corpus into roughly 10 requests.

## Data layout

```
data/corpus.json               wiki entries — tracked, diffable
data/classes.json              local scan — untracked (licensing; see NOTICE.md)
data/classes-curated.json.gz   curated local scan — untracked, same reason
data/index.sqlite              built artifact — untracked, `npm run index`
data/models/                   embedding model cache — untracked, fetched by `npm run index`
data/.ingest/                  resume checkpoints — untracked
```

The index is rebuilt locally rather than committed, which keeps git history
clean. `build-index` prefers `classes.json` when present and otherwise falls
back to the curated file; they are never merged, since that would double-count
mods appearing in both.

## Config parsing

Addon configs arrive in two forms and both are handled:

- **`config.bin`** — Bohemia's rapified binary. 16-byte header, class bodies
  reached by explicit offsets.
- **`config.cpp`** — plain text, roughly 7% of addons. Comments and
  preprocessor directives are stripped; macros are not expanded, so a class
  whose *name* comes from a macro is skipped rather than guessed at.

PBO members are read by seeking to the byte range needed, never by loading the
archive: individual PBOs reach ~250 MB while the config inside is a few KB.

Compressed members use BI's LZSS variant, where the 12-bit back-reference is a
**distance back from the current output position** rather than an absolute index
into a space-filled ring buffer. Textbook LZSS appears to work — the first bytes
of any file are literals either way — and then silently corrupts everything
after, which is what made this worth pinning down.

## Licensing

Licensed by component, because the data cannot be relicensed by us.

| Component | Licence |
| --- | --- |
| `src/`, `scripts/`, `tests/` | MIT |
| `data/corpus.json` | Bohemia Interactive wiki terms — **non-commercial**, attributed |
| classnames | not distributed; generated from your own install |

The wiki's [general disclaimer](https://community.bistudio.com/wiki/Meta:General_disclaimer)
explicitly permits integrating its content into derived works, but requires that
those works "remain licensed non-commercial". MIT permits commercial use, so the
corpus cannot be MIT — hence the split rather than a single repository licence.

The npm package therefore ships **code only**; you build the data locally from
sources you are licensed to use. Full detail, including the per-mod licence
table, is in [data/NOTICE.md](data/NOTICE.md).

Wiki content belongs to Bohemia Interactive and the wiki's contributors, and
every tool response links back to its source page. Classnames are read from your
own installed game and mods and never leave the machine.
