// Keeps the eval fixtures honest: the fake iDoklad used by `npm run evals` must answer the
// lookups the eval cases depend on, with the IDs the cases expect.
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { IdokladClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { fakeIdoklad } from "../evals/fake-idoklad.js";

async function connect() {
  const fake = fakeIdoklad();
  const server = createServer(new IdokladClient(fake.config, fake.impl, async () => {}), { readOnly: false, downloadDir: tmpdir() });
  const client = new Client({ name: "t", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0].text;
    if (res.isError) throw new Error(text);
    return JSON.parse(text);
  };
}

describe("eval fake iDoklad", () => {
  it("finds documents and contacts by the numbers and names the cases use", async () => {
    const call = await connect();
    const ids = (r: { documents: { id: number }[] }) => r.documents.map((d) => d.id);
    expect(ids(await call("list_issued_invoices", { documentNumber: "20260018" }))).toEqual([101]);
    expect(ids(await call("list_issued_invoices", { documentNumber: "20260015" }))).toEqual([104]);
    expect(ids(await call("list_issued_invoices", { partnerId: 4 }))).toEqual([102, 101]);
    expect(ids(await call("list_proforma_invoices", { documentNumber: "Z20260002" }))).toEqual([201]);
    expect((await call("list_contacts", { name: "ACME" })).contacts.map((c: { id: number }) => c.id)).toEqual([3]);
    expect((await call("list_contacts", { name: "Alfa" })).contacts.map((c: { id: number }) => c.id)).toEqual([5]);
  });

  it("applies payment status and date filters", async () => {
    const call = await connect();
    const ids = (r: { documents: { id: number }[] }) => r.documents.map((d) => d.id);
    expect(ids(await call("list_issued_invoices", { status: "unpaid" }))).toEqual([102, 101]);
    expect(ids(await call("list_issued_invoices", { status: "paid" }))).toEqual([103, 104]);
    expect(ids(await call("list_issued_invoices", { issuedFrom: "2026-10-01", issuedTo: "2026-10-31" }))).toEqual([102]);
    expect(ids(await call("list_received_invoices", { status: "unpaid" }))).toEqual([401]);
  });

  it("answers the statistics the overview cases ask for", async () => {
    const call = await connect();
    expect((await call("get_top_partners", { kind: "debtors" }))[0].contactId).toBe(4);
    expect((await call("get_top_partners", { kind: "customers" }))[0].contactId).toBe(3);
    expect((await call("get_business_stats", { report: "vat_registration_limit" })).percentOfLimit).toBe(43.5);
    expect((await call("get_business_stats", { report: "revenue_by_period", periods: 3 })).rows).toHaveLength(3);
    expect((await call("get_contact_stats", { contactId: 4 })).unpaid).toBe(2);
  });

  it("accepts every write the cases expect", async () => {
    await (await connect())("send_payment_reminder", { id: 101 });
    expect((await (await connect())("send_payment_confirmation", { documentId: 201 })).paymentId).toBeGreaterThan(0);
    const call = await connect();
    await call("create_issued_invoice", { partnerId: 4, copyFromId: 102, items: [{ name: "Dev", unitPrice: 41.24, amount: 42 }] });
    await call("create_credit_note", { invoiceId: 104, reason: "Returned", items: [{ name: "Licence", unitPrice: 2000, amount: 2 }] });
    expect((await call("create_invoice_from_proforma", { proformaId: 201 })).partnerId).toBe(5);
    await call("mark_document_paid", { documentType: "issued_invoice", id: 101 });
    await call("send_document_email", { documentType: "issued_invoice", id: 101 });
  });
});
