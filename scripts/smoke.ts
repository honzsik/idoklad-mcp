// Read-only smoke test: starts the server like an AI client would and calls every read tool once.
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { tmpdir } from "node:os";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "--env-file-if-exists=.env", "src/index.ts"],
  cwd: process.cwd(),
  env: { ...process.env, IDOKLAD_READ_ONLY: "true", IDOKLAD_DOWNLOAD_DIR: tmpdir() } as Record<string, string>,
});
// "auto" negotiates the newest protocol the server supports (2026-07-28 at the time of writing).
const client = new Client({ name: "smoke", version: "1" }, { versionNegotiation: { mode: "auto" } });
await client.connect(transport);
console.log("protocol:", client.getNegotiatedProtocolVersion());

let failures = 0;
async function check(name: string, args: Record<string, unknown> = {}) {
  const res: any = await client.callTool({ name, arguments: args });
  const text: string = res.content[0].text;
  if (res.isError) failures++;
  console.log(`${res.isError ? "FAIL" : "ok  "} ${name} ${JSON.stringify(args)}\n     ${text.replace(/\s+/g, " ").slice(0, 160)}`);
  return res.isError ? undefined : JSON.parse(text);
}

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const invoices = await check("list_issued_invoices", { pageSize: 2 });
await check("list_issued_invoices", { status: "overdue", pageSize: 2 });
const id = invoices?.documents?.[0]?.id;
if (id) {
  await check("get_issued_invoice", { id });
  await check("get_document_pdf", { documentType: "issued_invoice", id });
}
await check("list_proforma_invoices", { pageSize: 2 });
await check("list_credit_notes", { pageSize: 2 });
const received = await check("list_received_invoices", { status: "unpaid", pageSize: 2 });
if (received?.documents?.[0]) await check("get_received_invoice", { id: received.documents[0].id });
const contacts = await check("list_contacts", { pageSize: 2 });
if (contacts?.contacts?.[0]) await check("get_contact", { id: contacts.contacts[0].id });
await check("list_price_list_items", { pageSize: 2 });
for (const codebook of ["currencies", "vat_rates", "payment_options", "bank_accounts"]) await check("get_codebook", { codebook });
await check("search_api_docs", { query: "bank statement", limit: 2 });
await check("idoklad_api_request", { method: "GET", path: "BankStatements", query: { pagesize: 1 } });

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
