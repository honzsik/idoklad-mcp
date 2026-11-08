import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Read-only smoke test: starts the server like an AI client would and calls the read tools.
const transport = new StdioClientTransport({
  command: "npx", args: ["tsx", "--env-file-if-exists=.env", "src/index.ts"], cwd: process.cwd(),
  env: { ...process.env, PATH: process.env.PATH!, IDOKLAD_READ_ONLY: "true" } as Record<string, string>,
});
const c = new Client({ name: "e2e", version: "1" });
await c.connect(transport);
const show = async (name: string, args: any) => {
  const r: any = await c.callTool({ name, arguments: args });
  console.log(`\n### ${name} ${JSON.stringify(args)} ${r.isError ? "ERROR" : ""}\n${r.content[0].text.slice(0, 1500)}`);
  return r;
};
console.log("tools:", (await c.listTools()).tools.map((t) => t.name).join(", "));
const list = await show("list_issued_invoices", { pageSize: 3 });
await show("list_issued_invoices", { status: "unpaid", pageSize: 2 });
await show("list_issued_invoices", { status: "overdue", pageSize: 2 });
const first = JSON.parse(list.content[0].text).invoices?.[0];
if (first) await show("get_issued_invoice", { id: first.id });
await c.close();
