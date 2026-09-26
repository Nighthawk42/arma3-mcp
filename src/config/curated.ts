/**
 * The curated mod set shipped with the package.
 *
 * Classnames from a local install reflect one machine and belong in an
 * untracked file. But the mods almost everyone actually scripts against are
 * stable — most Arma 2/3-era content mods see no meaningful config changes for
 * years — so scanning those once and committing the result gives every user a
 * useful index without needing the mods installed.
 *
 * Matching is on the workshop folder name, case-insensitively, by prefix. Keep
 * the list to genuinely widely used mods: every entry adds to a file that ships
 * in the package.
 */
export const CURATED_MOD_PREFIXES = [
  // Base game — always worth having.
  "@ArmA3",
  // Community Base Addons: near-universal dependency.
  "@CBA_A3",
  // Community Upgrade Project: the Arma 1/2 content ported forward.
  "@CUP",
  // Red Hammer Studios: the largest modern content set.
  "@RHS",
  // Advanced Combat Environment.
  "@ace",
  // Common supporting mods.
  "@Zeus Enhanced",
  "@3den Enhanced",
  "@Project OPFOR",
  "@LAMBS",
  "@TFAR",
  "@acre",
] as const;

export function isCuratedMod(modFolder: string): boolean {
  const name = modFolder.toLowerCase();
  return CURATED_MOD_PREFIXES.some((p) => name.startsWith(p.toLowerCase()));
}
