import type { McpServer } from "@modelcontextprotocol/server";
import type { IdokladClient } from "../client.js";
import type { Codebooks } from "../codebooks.js";

export interface ToolContext {
  server: McpServer;
  client: IdokladClient;
  codebooks: Codebooks;
  readOnly: boolean;
  /** Folder where downloaded PDFs are saved. */
  downloadDir: string;
}

export const READ = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
