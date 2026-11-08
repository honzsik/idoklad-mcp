// Builds a Claude Desktop extension (MCP Bundle, .mcpb) for one-click install.
// Run after `npm run build`: npm run build:mcpb  →  idoklad-mcp-<version>.mcpb
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { IdokladClient } from "../src/client.js";
import { createServer } from "../src/server.js";

const OUT = "build/mcpb";
const pkg = JSON.parse(await readFile("package.json", "utf8"));

// List every tool (write mode shows them all) so the install dialog can show them.
const server = createServer(new IdokladClient({} as never), { readOnly: false, downloadDir: "" });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "build", version: "1" });
await Promise.all([server.connect(a), client.connect(b)]);
const tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description?.split(". ")[0] ?? "" }));
await client.close();

const manifest = {
  $schema: "https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.3.schema.json",
  manifest_version: "0.3",
  name: "idoklad-mcp",
  display_name: "iDoklad",
  version: pkg.version,
  description: "Read and create invoices in iDoklad, the Czech and Slovak online invoicing service. Unofficial.",
  long_description:
    "Unofficial MCP server for the iDoklad API v3. List and search issued and received invoices, proformas and credit notes, " +
    "download PDFs, look up contacts and the price list. With write mode on, create invoices, proformas, credit notes and contacts, " +
    "mark documents paid and send them by email. Read-only by default. Not affiliated with iDoklad or Seyfor, a. s.",
  author: { name: "Jan Vítek", email: "info@vitekjan.cz", url: "https://github.com/honzsik" },
  repository: { type: "git", url: "https://github.com/honzsik/idoklad-mcp" },
  homepage: "https://github.com/honzsik/idoklad-mcp",
  documentation: "https://github.com/honzsik/idoklad-mcp#readme",
  support: "https://github.com/honzsik/idoklad-mcp/issues",
  icon: "icon.png",
  license: "MIT",
  keywords: ["idoklad", "invoice", "faktura", "accounting", "czech"],
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.js"],
      env: {
        IDOKLAD_CLIENT_ID: "${user_config.client_id}",
        IDOKLAD_CLIENT_SECRET: "${user_config.client_secret}",
        IDOKLAD_APPLICATION_ID: "${user_config.application_id}",
        IDOKLAD_READ_ONLY: "${user_config.read_only}",
        IDOKLAD_DOWNLOAD_DIR: "${user_config.download_dir}",
      },
    },
  },
  tools,
  user_config: {
    client_id: {
      type: "string",
      title: "Client ID",
      description: "From iDoklad → Settings (Nastavení) → API.",
      required: true,
    },
    client_secret: {
      type: "string",
      title: "Client Secret",
      description: "From iDoklad → Settings (Nastavení) → API.",
      required: true,
      sensitive: true,
    },
    application_id: {
      type: "string",
      title: "Application ID",
      description: "The Client Id of an app with the ClientCredentials flow on developer.idoklad.cz.",
      required: true,
    },
    read_only: {
      type: "boolean",
      title: "Read-only",
      description: "Only read data. Turn off to let Claude create invoices, record payments and send emails.",
      default: true,
    },
    download_dir: {
      type: "directory",
      title: "PDF folder",
      description: "Where downloaded invoice PDFs are saved.",
      default: "${HOME}/Downloads",
    },
  },
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=22.0.0" },
  },
};

// Bundle layout: manifest.json, server/ (compiled code), package.json, production node_modules.
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp("dist", `${OUT}/server`, { recursive: true, filter: (src) => !src.endsWith(".map") });
for (const f of ["package.json", "package-lock.json", "LICENSE", "README.md"]) await cp(f, `${OUT}/${f}`);
await cp("assets/icon.png", `${OUT}/icon.png`);
await writeFile(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: OUT, stdio: "inherit" });

const file = `idoklad-mcp-${pkg.version}.mcpb`;
execFileSync("npx", ["mcpb", "validate", `${OUT}/manifest.json`], { stdio: "inherit" });
execFileSync("npx", ["mcpb", "pack", OUT, file], { stdio: "inherit" });
console.log(`\nBuilt ${file}`);
