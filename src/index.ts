#!/usr/bin/env node
/**
 * Entry point: stdio MCP server.
 *
 * stdout belongs to the transport, so every diagnostic goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, openIndexOrExit } from "./server.js";
import { getEmbedder, MODEL_DIR } from "./index/embed.js";

const db = openIndexOrExit();
const server = createServer(db);
await server.connect(new StdioServerTransport());
console.error("arma-mcp ready (stdio)");

// Load the embedding model in the background so the first search doesn't pay
// for it. It is read from the local cache only; without it, search falls back
// to its lexical arms.
getEmbedder().catch(() => {
  console.error(`arma-mcp: semantic search off (no cached model in ${MODEL_DIR}; \`npm run index\` fetches it)`);
});
