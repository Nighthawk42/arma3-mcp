# Data licensing

The code in this repository is MIT (see `../LICENSE`). **The data in this
directory is not**, and cannot be relicensed by us — we do not hold the rights
to it. This file records what applies to each source, and why the repository is
laid out the way it is.

## `corpus.json` — Bohemia Interactive Community Wiki

Derived from <https://community.bistudio.com> via the MediaWiki API.

The wiki declares no licence through the API (`rightsinfo` is empty), so the
governing text is its own disclaimer at
[Meta:General disclaimer](https://community.bistudio.com/wiki/Meta:General_disclaimer):

> Content stored on this site contains information that is the protected
> Intellectual Property of Bohemia Interactive and other users. Your usage of
> any content stored, distributed, documented, or referenced through this site
> may only be for your **personal, non-commercial entertainment use only**. You
> may integrate content from this site in whole or in part into works you create
> or derive, **as long as your content and any derived or included works remain
> licensed non-commercial**.

Two consequences:

1. Including this corpus is **explicitly permitted** — the disclaimer allows
   integration into derived works.
2. Those derived works **must remain non-commercial**. MIT permits commercial
   use without restriction, so the corpus cannot be MIT. That is why licensing
   here is split by component rather than applied to the whole repository.

Every tool response links back to its source wiki page.

## Config classnames — **not distributed**

`classes.json` and `classes-curated.json.gz` are produced by `npm run scan` from
an Arma installation on the machine running it. **They are deliberately not
committed and not published**, because the mods they are derived from carry
licences that do not permit us to redistribute derived data:

| Source | Licence | Redistribution of derived data |
| --- | --- | --- |
| Arma base game data | Arma Public License family — non-commercial, Arma-only | restricted |
| RHS (AFRF/GREF/SAF/USAF) | **CC BY-NC-ND 3.0** | **No Derivatives — prohibited** |
| CUP | CUP-L v1.0 | restricted |
| CBA_A3 | GPL | copyleft |
| ACE3 | GPL | copyleft |
| Zeus Enhanced | GPLv3 | copyleft |

RHS is the decisive one. A classname index is a transformation of their
material, and it carries thousands of their authored `displayName` strings —
"T-72B (obr. 1984g.)" and so on. Bare identifiers might be defensible as
uncopyrightable facts; several thousand authored display strings are not.
NoDerivatives leaves no room for shipping that.

Scanning your own installation for your own use is a different thing entirely,
and is what the tooling is built for:

```bash
npm run scan -- "D:/SteamLibrary/steamapps/common/Arma 3"
npm run index
```

The class tools report that no index is present until you do, rather than
failing.

## Summary

| Component | Licence |
| --- | --- |
| `src/`, `scripts/`, `tests/` | MIT |
| `data/corpus.json` | Bohemia Interactive wiki terms — non-commercial, attributed |
| `data/classes*.json` | not distributed; generated locally from your own install |
