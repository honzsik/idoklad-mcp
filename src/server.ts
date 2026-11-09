import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import type { IdokladClient } from "./client.js";
import { Codebooks } from "./codebooks.js";
import type { Config } from "./config.js";
import { registerApiTools } from "./tools/api.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerStatsTools } from "./tools/stats.js";

// Read from package.json (one level up from both src/ and dist/) so releases only bump one place.
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

export function createServer(client: IdokladClient, config: Pick<Config, "readOnly" | "downloadDir">): McpServer {
  const server = new McpServer(
    { name: "idoklad-mcp", version: VERSION },
    {
      instructions:
        "Tools for the iDoklad invoicing service (Czech/Slovak). IDs are numeric iDoklad IDs, not document numbers. " +
        "Dates are YYYY-MM-DD. Find customers with list_contacts and use their IDs. " +
        "For questions about revenue, costs, debts or VAT, use get_business_stats and get_top_partners. " +
        "For anything without a dedicated tool, use search_api_docs and then idoklad_api_request. " +
        (config.readOnly
          ? "The server runs in read-only mode: tools that create or change data are disabled (set IDOKLAD_READ_ONLY=false to enable them)."
          : "Write tools are enabled. Confirm with the user before creating documents, recording payments or sending emails."),
    },
  );
  const ctx = { server, client, codebooks: new Codebooks(client), readOnly: config.readOnly, downloadDir: config.downloadDir };
  registerDocumentTools(ctx);
  registerInvoiceTools(ctx);
  registerContactTools(ctx);
  registerStatsTools(ctx);
  registerApiTools(ctx);
  return server;
}
