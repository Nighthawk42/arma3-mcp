# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

A TypeScript MCP server (stdio) serving Bohemia Interactive scripting
documentation from a local SQLite index. Two independent ingest pipelines feed
it; the server itself never makes a network request.

1. **Wiki pipeline** — MediaWiki API -> wikitext -> `{{RV}}` parser -> `data/corpus.json`
2. **Config pipeline** — PBO archives on disk -> de-rapified configs -> `data/classes.json`
   (local only; never committed — see Licensing below)

Both are folded into `data/index.sqlite` by `scripts/build-index.ts`.

## Commands

```bash
npm run build      # tsc -> dist/
npm run dev        # run the server from source
npm test           # vitest (parser fixtures in tests/fixtures/)
npm run typecheck  # tsc over src, scripts and tests
npm run eval       # search relevance: hit@1 / hit@3 / MRR over tests/search-eval.json
npm run ingest     # full wiki ingest — slow, resumable, safe to re-run
npm run assemble   # rebuild corpus.json from ingest checkpoints
npm run update     # incremental wiki update via recentchanges
npm run scan -- "<Arma install path>"   # scan PBOs for classnames
npm run index      # build data/index.sqlite from the corpora
npm run smoke      # drive every tool through an in-memory MCP client
```

## Layout

- `src/index.ts` — entry point (stdio transport)
- `src/server.ts` — tool registration
- `src/games.ts` — canonical game registry; the only place game codes are decided
- `src/wiki/` — `client.ts` (paced API client), `wikitext.ts`, `rv-parser.ts`
- `src/config/` — `pbo.ts` (archive reader), `rapify.ts` (config.bin), `classes.ts`
- `src/index/` — `store.ts` (schema + fusion), `query.ts` (read side), `embed.ts`
- `src/format.ts` — markdown renderers for tool output

## Things that will bite you

- **Pages carry more than one `{{RV}}` block.** `addAction` has an OFP-era block
  and a separate Arma 3 block with a different signature. Parse them all and
  merge; reading only the first silently loses whole games.
- **MediaWiki normalises underscores to spaces in titles.** The page is
  `diag log`; the identifier is `diag_log`. `identifierFor()` recovers it, and
  must leave operator pages (`! a`, `a + b`) alone.
- **`p21` is ambiguous** — syntax 1's 21st parameter, or syntax 2's first?
  Resolved by only taking the prefixed reading when syntax 2 exists.
- **Rapified configs have a 16-byte header**, not 20. Each class body is
  followed by a trailing u32 that can be ignored, since nested bodies are
  reached by explicit offsets.
- **Value subtype 6 is a 64-bit int.** The base game stores `transportRepair`
  and friends as 1e12; reading it narrower desyncs the whole file.
- **BI's LZSS reference is a distance back from the output position**, not an
  absolute index into a space-filled ring buffer. Textbook LZSS decodes the
  first bytes of a file correctly either way and then corrupts everything after,
  so this fails silently rather than loudly.
- **Read PBOs by seeking**, never `readFileSync`. Some are 250MB and we want a
  few KB of config from each.
- **sqlite-vec rejects plain JS numbers as vec0 rowids.** Bind `BigInt`.
- **Do not write TypeScript containing regexes via a bash heredoc** — backslash
  escapes get eaten. Use the Write tool.
- **Event handlers have no pages of their own.** No page uses
  `{{RV|type=eventhandler}}`; each handler is a section of a long reference page
  (`src/wiki/event-handlers.ts`). A handler heading is a bare identifier,
  optionally qualified (`HitPart (Projectile)`); a phrase heading is a group.
  Heading levels differ per page, so never key off the level. Listing
  `Category:Event Handlers` is one of the requests Cloudflare refuses outright
  (by title *and* by page id), so the pages are named, not discovered.
- **Config classes inherit across PBOs.** `scope` and `displayName` are often
  only set on an ancestor in a different mod, so inheritance is resolved after
  every source is collected, not per file.

## Licensing — do not "simplify" this

The repository is licensed **by component**, and that is deliberate:

- `src/`, `scripts/`, `tests/` are MIT.
- `data/corpus.json` is wiki content under Bohemia Interactive's terms, which
  require derived works to remain **non-commercial**. It therefore cannot be
  MIT, and the repository cannot carry a single MIT licence while containing it.
- Classname data is **never committed or published**. RHS ships under
  CC BY-NC-ND; a classname index is a derivative carrying thousands of their
  authored `displayName` strings, so NoDerivatives rules out redistributing it.
  It is generated locally by `npm run scan`.
- `package.json` `files` is `dist` + docs only, for the same reason: publishing
  the corpus to npm would put non-commercial content where consumers may use it
  commercially.

If someone asks to "just make it all MIT", the answer is that we do not hold the
rights to do so. See `data/NOTICE.md` for the sourced quotations.

## Conventions

- ESM, Node 22.13+ (`node:sqlite`), strict TypeScript, `snake_case` tool names, zod-validated input.
- Every tool declares `annotations: READ_ONLY` (`src/tools/annotations.ts`): read-only and closed-world, since the server never touches the network.
- Tool responses are markdown text — the format every client renders.
- Keep stdout clean in server code: the stdio transport owns it, log to stderr.
- Game ids are exactly the wiki's own codes. Never invent aliases; add them to
  `ALIASES` or `EXCLUDED_GAME_CODES` in `src/games.ts` with a reason.
- Be gentle with the wiki. It is behind Cloudflare and throttles volume; the
  pacing, batching, backoff and checkpointing in `src/wiki/client.ts` and
  `scripts/ingest.ts` are load-bearing, not decoration.

## Known gaps

- Only Arma 3's event handler reference pages are ingested (see
  `EVENT_HANDLER_PAGES`); older games' handler lists are not.
- 2 of 2,548 PBOs still fail to parse: one uses rapified value subtype 4, which
  is undocumented here and not yet handled.
- Macros in text `config.cpp` are not expanded, so a class whose *name* comes
  from a macro is skipped rather than guessed at.

## Cloudflare 403s — what was actually measured

Early runs stalled with 403s that looked like rate limiting. They were not.
Ruled out by direct A/B testing, so don't re-litigate these:

| Hypothesis | Result |
| --- | --- |
| User-Agent looks like a bot | No — same result with and without a `node-fetch` suffix, and with a browser UA |
| Batch size / response size | No — 5, 15, 30 and 50 titles all returned 200 |
| `URLSearchParams` encoding (`+` vs `%20`) | No — both forms behaved identically |
| Node `fetch` TLS fingerprint vs curl | No — plain Node `fetch` returned 200 on the same URL |
| Sliding window on request volume | No — `[400:450]` and `[100:150]` were interleaved; the first succeeded twice, the second failed twice |

**Actual cause:** a small number of individual pages are refused outright.
Bisecting the failing batch isolated `BIN fnc droneDestructionFX`, which 403s
when requested entirely on its own. It sits at index 101 of the sorted title
list, which is exactly where every resumed run began — so the same page blocked
every attempt and produced a convincing illusion of throttling.

`fetchResilient` in `scripts/ingest.ts` handles it: bisect a failed batch, keep
the halves that succeed, quarantine a single title that still fails. Retries are
enabled only on the first attempt at a batch — during bisection a 403 is already
known to be a hard block, and retrying each probe made isolation cost minutes
instead of seconds.
