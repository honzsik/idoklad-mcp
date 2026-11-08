// Writes server.json for the official MCP Registry (registry.modelcontextprotocol.io).
// Usage: tsx scripts/server-json.ts [path/to/idoklad-mcp-<version>.mcpb]
// With a .mcpb file it also lists the Claude Desktop bundle from the matching GitHub release.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const mcpbFile = process.argv[2];

const env = [
  { name: "IDOKLAD_CLIENT_ID", description: "Client ID from iDoklad → Settings → API", isRequired: true },
  { name: "IDOKLAD_CLIENT_SECRET", description: "Client Secret from iDoklad → Settings → API", isRequired: true, isSecret: true },
  { name: "IDOKLAD_APPLICATION_ID", description: "Client Id of a ClientCredentials app on developer.idoklad.cz", isRequired: true },
  { name: "IDOKLAD_READ_ONLY", description: "Set to false to enable tools that create or change data (default true)" },
  { name: "IDOKLAD_DOWNLOAD_DIR", description: "Folder for downloaded PDFs (default ~/Downloads)" },
];

const packages: Record<string, unknown>[] = [
  {
    registryType: "npm",
    registryBaseUrl: "https://registry.npmjs.org",
    identifier: pkg.name,
    version: pkg.version,
    transport: { type: "stdio" },
    environmentVariables: env,
  },
];

if (mcpbFile) {
  const sha = createHash("sha256").update(await readFile(mcpbFile)).digest("hex");
  packages.push({
    registryType: "mcpb",
    identifier: `https://github.com/honzsik/idoklad-mcp/releases/download/v${pkg.version}/${basename(mcpbFile)}`,
    version: pkg.version,
    fileSha256: sha,
    transport: { type: "stdio" },
  });
}

const server = {
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: pkg.mcpName,
  title: "iDoklad",
  description: "Unofficial iDoklad invoicing: read and create invoices, proformas, credit notes and contacts.",
  version: pkg.version,
  repository: { url: "https://github.com/honzsik/idoklad-mcp", source: "github" },
  websiteUrl: "https://github.com/honzsik/idoklad-mcp#readme",
  packages,
};

await writeFile("server.json", JSON.stringify(server, null, 2) + "\n");
console.log(`Wrote server.json (${packages.map((p) => p.registryType).join(", ")}) for version ${pkg.version}`);
