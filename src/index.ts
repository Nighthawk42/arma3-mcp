#!/usr/bin/env node
/**
 * Entry point: stdio MCP server.
 *
 * stdout belongs to the transport, so every diagnostic goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, openIndexOrExit } from "./server.js";

const db = openIndexOrExit();
const server = createServer(db);
await server.connect(new StdioServerTransport());
console.error("arma-mcp ready (stdio)");
