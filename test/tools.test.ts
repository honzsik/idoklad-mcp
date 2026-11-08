import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IdokladClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { fakeFetch, ok, testConfig, type Call } from "./helpers.js";

const currencies = ok({ Items: [{ Id: 1, Code: "CZK" }], TotalItems: 1, TotalPages: 1 });

async function connect(handler: Parameters<typeof fakeFetch>[0], readOnly = true) {
  // Answer the currency codebook for every test; route everything else to the test's handler.
  const f = fakeFetch((c) => (c.url.pathname.endsWith("/Currencies") ? currencies : handler(c)));
  const server = createServer(new IdokladClient(testConfig, f.impl, async () => {}), { readOnly });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0].text;
    return { isError: res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, calls: f.calls };
}

const invoice = {
  Id: 7,
  DocumentNumber: "20260001",
  DateOfIssue: "2026-11-01T00:00:00",
  DateOfMaturity: "2026-11-15T00:00:00",
  PartnerId: 3,
  PartnerAddress: { NickName: "ACME s.r.o." },
  PaymentStatus: 0,
  Prices: { TotalWithVat: 1210, TotalWithoutVat: 1000, TotalPaid: 0 },
  CurrencyId: 1,
};

describe("tools", () => {
  it("hides write tools in read-only mode", async () => {
    const { client } = await connect(() => ok({}));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["list_issued_invoices", "get_issued_invoice"]);
  });

  it("exposes write tools when read-only is off", async () => {
    const { client } = await connect(() => ok({}), false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("create_issued_invoice");
  });

  it("list_issued_invoices builds filters and returns summaries", async () => {
    const { call, calls } = await connect(() => ok({ Items: [invoice], TotalItems: 1, TotalPages: 1 }));
    const res = await call("list_issued_invoices", { status: "unpaid", partnerId: 3, issuedFrom: "2026-01-01" });
    const q = calls.find((c) => c.url.pathname.endsWith("/IssuedInvoices"))!.url.searchParams;
    expect(q.get("filter")).toBe("(IsPaid~eq~false~and~PartnerId~eq~3~and~DateOfIssue~gte~2026-01-01)");
    expect(q.get("sort")).toBe("DateOfIssue~desc");
    expect(q.get("pagesize")).toBe("20");
    expect(res.json.invoices[0]).toMatchObject({
      id: 7,
      number: "20260001",
      partner: "ACME s.r.o.",
      issued: "2026-11-01",
      due: "2026-11-15",
      paymentStatus: "unpaid",
      totalWithVat: 1210,
      currency: "CZK",
    });
  });

  it("returns API errors as tool errors", async () => {
    const { call } = await connect(() => ({ status: 404, json: { IsSuccess: false, Message: "Invoice not found" } }));
    const res = await call("get_issued_invoice", { id: 99 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Invoice not found/);
  });

  it("create_issued_invoice starts from the default draft and resolves the partner by name", async () => {
    const handler = (c: Call) => {
      const path = c.url.pathname;
      if (path.endsWith("/Contacts")) return ok({ Items: [{ Id: 3, CompanyName: "ACME s.r.o." }], TotalItems: 1, TotalPages: 1 });
      if (path.endsWith("/IssuedInvoices/Default"))
        return ok({ DateOfIssue: "2026-11-08", BankId: 5, Iban: "CZ00", NumericSequenceId: 9, Items: [{ Name: "", DiscountPercentage: 0, IsTaxMovement: true, VatRate: 21, VatCodeId: 3, VatRateType: 1 }] });
      if (c.method === "POST") return ok({ ...invoice, Id: 8 });
      return { status: 500 };
    };
    const { call, calls } = await connect(handler, false);
    const res = await call("create_issued_invoice", {
      partnerName: "ACME s.r.o.",
      items: [{ name: "Consulting", unitPrice: 1000, amount: 2, unit: "hod" }],
      dueInDays: 14,
      description: "November work",
    });
    expect(res.isError).toBeFalsy();
    expect(res.json.id).toBe(8);

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      BankId: 5,
      Iban: "CZ00",
      NumericSequenceId: 9,
      PartnerId: 3,
      DateOfIssue: "2026-11-08",
      DateOfMaturity: "2026-11-22",
      Description: "November work",
      Items: [
        { Name: "Consulting", UnitPrice: 1000, Amount: 2, Unit: "hod", PriceType: 1, VatRateType: 1, ItemType: 0, DiscountPercentage: 0, IsTaxMovement: true, VatRate: 21 },
      ],
    });
  });

  it("create_issued_invoice refuses ambiguous partner names", async () => {
    const { call, calls } = await connect(
      () => ok({ Items: [{ Id: 1, CompanyName: "ACME a" }, { Id: 2, CompanyName: "ACME b" }], TotalItems: 2, TotalPages: 1 }),
      false,
    );
    const res = await call("create_issued_invoice", { partnerName: "ACME", items: [{ name: "x", unitPrice: 1 }] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Several contacts match/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
