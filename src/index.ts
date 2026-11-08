#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IdokladClient } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const server = createServer(new IdokladClient(config), config);
  await server.connect(new StdioServerTransport());
  console.error(`idoklad-mcp running (${config.readOnly ? "read-only" : "read-write"})`);
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `idoklad-mcp: ${err.message}` : err);
  process.exit(1);
});
