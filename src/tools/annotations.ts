/**
 * Every tool only reads the local index and never reaches the network, so all
 * of them are read-only and closed-world. Clients that auto-approve read-only
 * tools can then do so.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
