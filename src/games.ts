/**
 * Canonical game registry.
 *
 * The BI wiki's {{RV}} template tags every command/function page with one or
 * more `gameN=` codes plus a matching `versionN=` (the version that introduced
 * it *in that game*). Those codes are the wiki's own vocabulary — we map them
 * to canonical ids rather than inventing our own, so ingest stays faithful to
 * the source.
 *
 * Take On Helicopters (`tkoh`) and VBS are deliberately excluded: they run the
 * same engine lineage but are not Arma titles. A page tagged for an excluded
 * game *and* an included one is kept — only the excluded tag is dropped.
 */

export const GAMES = {
  ofp: { name: "Operation Flashpoint: Cold War Crisis", released: 2001, engine: "Real Virtuality" },
  ofpe: { name: "Operation Flashpoint: Elite", released: 2005, engine: "Real Virtuality" },
  arma1: { name: "Arma: Armed Assault", released: 2006, engine: "Real Virtuality 2" },
  arma2: { name: "Arma 2", released: 2009, engine: "Real Virtuality 3" },
  arma2oa: { name: "Arma 2: Operation Arrowhead", released: 2010, engine: "Real Virtuality 3" },
  arma3: { name: "Arma 3", released: 2013, engine: "Real Virtuality 4" },
} as const;

export type GameId = keyof typeof GAMES;

export const GAME_IDS = Object.keys(GAMES) as GameId[];

/**
 * Wiki game codes we knowingly discard. Anything *not* listed here and not in
 * GAMES is surfaced by the ingest as an unknown code rather than silently
 * dropped — the wiki occasionally adds titles.
 */
export const EXCLUDED_GAME_CODES = new Set([
  "tkoh", "tkohe", "tkoh_",
  "vbs1", "vbs2", "vbs3", "vbs",
  "ofpr", // Resistance — folded into ofp on the wiki, kept out to avoid a phantom title
]);

/** Wiki codes that mean the same title as a canonical id. */
const ALIASES: Record<string, GameId> = {
  arma3dev: "arma3", // dev-branch tag on the same title
  arma: "arma1",
  armedassault: "arma1",
  arma2co: "arma2oa",
};

/** Resolve a raw wiki `gameN=` code. Returns null for deliberately excluded titles. */
export function resolveGameCode(raw: string): { id: GameId } | { excluded: true } | { unknown: string } {
  const code = raw.trim().toLowerCase();
  if (!code) return { unknown: raw };
  if (code in GAMES) return { id: code as GameId };
  if (code in ALIASES) return { id: ALIASES[code] };
  if (EXCLUDED_GAME_CODES.has(code)) return { excluded: true };
  return { unknown: code };
}

export function isGameId(value: string): value is GameId {
  return value in GAMES;
}
