import { z } from "zod";
import apiIndex from "../data/api-index.json" with { type: "json" };
import type { Page } from "../client.js";
import { READ, WRITE, type ToolContext } from "./context.js";
import { run, todayIso } from "./util.js";

interface Endpoint {
  method: string;
  path: string;
  title: string;
  group: string;
  description: string;
  query: string[];
  body: string[];
}

const ENDPOINTS = apiIndex as Endpoint[];

/** Ranks endpoints by how many query words appear in their path, title, group and description. */
export function searchEndpoints(query: string, limit = 8): Endpoint[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  return ENDPOINTS.map((e) => {
    const head = `${e.path} ${e.title} ${e.group}`.toLowerCase();
    const rest = `${e.description} ${e.query.join(" ")} ${e.body.join(" ")}`.toLowerCase();
    const score = words.reduce((s, w) => s + (head.includes(w) ? 3 : 0) + (rest.includes(w) ? 1 : 0), 0);
    return { e, score };
  })
    .filter((r) => r.score > 0)
    // Ties: prefer reads and shorter (more general) paths.
    .sort((a, b) => b.score - a.score || Number(b.e.method === "GET") - Number(a.e.method === "GET") || a.e.path.length - b.e.path.length)
    .slice(0, limit)
    .map((r) => r.e);
}

const CODEBOOKS = {
  currencies: "Currencies",
  countries: "Countries",
  vat_rates: "VatRates",
  vat_codes: "VatCodes",
  payment_options: "PaymentOptions",
  bank_accounts: "BankAccounts",
  numeric_sequences: "NumericSequences",
  constant_symbols: "ConstantSymbols",
  tags: "Tags",
} as const;

export function registerApiTools(ctx: ToolContext) {
  const { server, client } = ctx;

  server.registerTool(
    "get_codebook",
    {
      title: "Get codebook",
      description:
        "Get an iDoklad codebook (číselník) or company setting list: currencies, countries, VAT rates (current only), VAT codes, " +
        "payment options, your bank accounts, numeric sequences, constant symbols or tags. Use it to translate IDs in documents.",
      inputSchema: { codebook: z.enum(Object.keys(CODEBOOKS) as [keyof typeof CODEBOOKS, ...(keyof typeof CODEBOOKS)[]]) },
      annotations: READ,
    },
    ({ codebook }) =>
      run(async () => {
        const page = await client.get<Page<Record<string, unknown>>>(CODEBOOKS[codebook], { pagesize: 200 });
        let items = page.Items;
        if (codebook === "vat_rates") {
          const today = todayIso();
          items = items.filter((r) => !r.DateValidityTo || String(r.DateValidityTo) >= today);
        }
        return { total: items.length, items };
      }),
  );

  server.registerTool(
    "search_api_docs",
    {
      title: "Search iDoklad API docs",
      description:
        "Search the iDoklad API v3 reference for endpoints not covered by other tools (bank statements, cash vouchers, " +
        "recurring invoices, sales orders, stock, webhooks…). Returns method, path, parameters (* = required). " +
        "Then call idoklad_api_request.",
      inputSchema: {
        query: z.string().min(2).describe("Keywords in English, e.g. 'bank statement list' or 'recurring invoice'."),
        limit: z.number().int().min(1).max(20).default(8),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, limit }) =>
      run(async () => {
        const results = searchEndpoints(query, limit);
        return results.length ? results : `No endpoints match "${query}". Try other English keywords.`;
      }),
  );

  const methods = ctx.readOnly ? (["GET"] as const) : (["GET", "POST", "PUT", "PATCH", "DELETE"] as const);
  server.registerTool(
    "idoklad_api_request",
    {
      title: "Call iDoklad API",
      description:
        "Call any iDoklad API v3 endpoint directly (find it with search_api_docs first). Path is relative, e.g. 'BankStatements'. " +
        "List endpoints accept filter, sort, page and pagesize query parameters; filter syntax: (Field~op~value~and~Field~op~value) " +
        "with ops eq, !eq, lt, lte, gt, gte, ct, !ct. " +
        (ctx.readOnly
          ? "Read-only mode: only GET is allowed."
          : "Prefer the dedicated tools when one exists, and confirm any change with the user before calling POST, PUT, PATCH or DELETE."),
      inputSchema: {
        method: z.enum(methods),
        path: z.string().min(1).describe("Endpoint path after /v3/, e.g. 'IssuedInvoices/123'."),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional().describe("JSON body for POST, PUT, PATCH."),
      },
      annotations: ctx.readOnly ? READ : { ...WRITE, destructiveHint: true },
    },
    (args) =>
      run(async () => {
        if (/^(https?:)?\/\//i.test(args.path) || args.path.includes("..")) throw new Error("Use a relative API path, e.g. 'Contacts'.");
        return client.request(args.method, args.path, { query: args.query, body: args.body });
      }),
  );
}
