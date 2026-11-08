#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { IdokladClient } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";

try {
  const config = loadConfig();
  // One client for the whole process, so the login token is shared across connections.
  const client = new IdokladClient(config);
  // serveStdio speaks both the 2026-07-28 protocol and the older 2025 one, whichever the client opens with.
  serveStdio(() => createServer(client, config), { onerror: (err) => console.error("idoklad-mcp:", err) });
  console.error(`idoklad-mcp running (${config.readOnly ? "read-only" : "read-write"})`);
} catch (err) {
  console.error(err instanceof ConfigError ? `idoklad-mcp: ${err.message}` : err);
  process.exit(1);
}
