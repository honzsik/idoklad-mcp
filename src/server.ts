import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IdokladClient } from "./client.js";
import { Codebooks } from "./codebooks.js";
import type { Config } from "./config.js";
import { registerInvoiceTools } from "./tools/invoices.js";

export const VERSION = "0.1.0";

export function createServer(client: IdokladClient, config: Pick<Config, "readOnly">): McpServer {
  const server = new McpServer(
    { name: "idoklad-mcp", version: VERSION },
    {
      instructions:
        "Tools for the iDoklad invoicing service (Czech/Slovak). IDs are numeric iDoklad IDs, not document numbers. " +
        "Dates are YYYY-MM-DD. " +
        (config.readOnly
          ? "The server runs in read-only mode: tools that create or change data are disabled (set IDOKLAD_READ_ONLY=false to enable them)."
          : "Write tools are enabled; confirm with the user before creating or changing documents."),
    },
  );
  registerInvoiceTools(server, client, new Codebooks(client), { readOnly: config.readOnly });
  return server;
}
