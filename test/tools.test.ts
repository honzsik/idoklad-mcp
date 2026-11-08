import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IdokladClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { fakeFetch, ok, testConfig, type Call } from "./helpers.js";

const page = (items: unknown[]) => ok({ Items: items, TotalItems: items.length, TotalPages: 1 });
const currencies = page([
  { Id: 1, Code: "CZK" },
  { Id: 11, Code: "USD" },
]);

async function connect(handler: (c: Call) => ReturnType<typeof ok> | { status: number; json?: unknown }, readOnly = true) {
  // Answer the currency codebook for every test; route everything else to the test's handler.
  const f = fakeFetch((c) => (c.url.pathname.endsWith("/Currencies") ? currencies : handler(c)));
  const server = createServer(new IdokladClient(testConfig, f.impl, async () => {}), { readOnly, downloadDir: testConfig.downloadDir });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0].text;
    return { isError: res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
  };
  const apiCalls = () => f.calls.filter((c) => !c.url.pathname.endsWith("/Currencies"));
  return { client, call, apiCalls };
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

const defaultDraft = {
  DateOfIssue: "2026-11-08",
  DateOfMaturity: "2026-11-22",
  CurrencyId: 1,
  BankId: 5,
  NumericSequenceId: 9,
  DocumentSerialNumber: 21,
  VariableSymbol: "20260021",
  Items: [{ Name: "", DiscountPercentage: 0, IsTaxMovement: true, VatRate: 21, VatCodeId: 3, VatRateType: 1, PriceType: 0 }],
};

describe("tool list", () => {
  it("read-only mode exposes only read tools", async () => {
    const { client } = await connect(() => ok({}));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_codebook",
        "get_contact",
        "get_credit_note",
        "get_document_pdf",
        "get_issued_invoice",
        "get_proforma_invoice",
        "get_received_invoice",
        "idoklad_api_request",
        "list_contacts",
        "list_credit_notes",
        "list_issued_invoices",
        "list_price_list_items",
        "list_proforma_invoices",
        "list_received_invoices",
        "search_api_docs",
      ].sort(),
    );
  });

  it("write mode adds the write tools", async () => {
    const { client } = await connect(() => ok({}), false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["create_issued_invoice", "create_contact", "send_document_email", "mark_document_paid", "mark_document_unpaid"]),
    );
  });
});

describe("document tools", () => {
  it("list_issued_invoices builds filters and returns summaries", async () => {
    const { call, apiCalls } = await connect(() => page([invoice]));
    const res = await call("list_issued_invoices", { status: "unpaid", partnerId: 3, issuedFrom: "2026-01-01" });
    const q = apiCalls()[0].url.searchParams;
    expect(q.get("filter")).toBe("(IsPaid~eq~false~and~PartnerId~eq~3~and~DateOfIssue~gte~2026-01-01)");
    expect(q.get("sort")).toBe("DateOfIssue~desc");
    expect(res.json.documents[0]).toMatchObject({
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

  it("list_received_invoices filters by supplier and payment status", async () => {
    const { call, apiCalls } = await connect(() => page([]));
    await call("list_received_invoices", { status: "unpaid", partnerId: 4 });
    const call0 = apiCalls()[0];
    expect(call0.url.pathname).toBe("/v3/ReceivedInvoices");
    expect(call0.url.searchParams.get("filter")).toBe("(PaymentStatus~!eq~Paid~and~SupplierId~eq~4)");
  });

  it("returns API errors as tool errors", async () => {
    const { call } = await connect(() => ({ status: 404, json: { IsSuccess: false, Message: "Invoice not found" } }));
    const res = await call("get_issued_invoice", { id: 99 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Invoice not found/);
  });

  it("get_document_pdf saves the PDF named after the document number", async () => {
    await rm(testConfig.downloadDir, { recursive: true, force: true });
    const { call } = await connect((c) =>
      c.url.pathname.includes("/Reports/") ? ok(Buffer.from("%PDF-test").toString("base64")) : ok(invoice),
    );
    const res = await call("get_document_pdf", { documentType: "issued_invoice", id: 7, language: "en" });
    expect(res.json.path).toBe(`${testConfig.downloadDir}/issued-invoice-20260001.pdf`);
    expect(await readFile(res.json.path, "utf8")).toBe("%PDF-test");
  });

  it("mark_document_paid calls FullyPay with the payment date", async () => {
    const { call, apiCalls } = await connect(() => ok(true), false);
    await call("mark_document_paid", { documentType: "received_invoice", id: 5, dateOfPayment: "2026-11-01" });
    const c = apiCalls()[0];
    expect(c.method).toBe("PUT");
    expect(c.url.pathname).toBe("/v3/ReceivedDocumentPayments/FullyPay/5");
    expect(c.url.searchParams.get("dateOfPayment")).toBe("2026-11-01");
  });

  it("send_document_email posts to the Mails endpoint", async () => {
    const { call, apiCalls } = await connect(() => ok({ Sent: ["a@b.cz"], NotSent: [] }), false);
    const res = await call("send_document_email", { documentType: "proforma_invoice", id: 8 });
    expect(apiCalls()[0].url.pathname).toBe("/v3/Mails/ProformaInvoice/Send");
    expect(apiCalls()[0].body).toMatchObject({ DocumentId: 8, SendToPartner: true, SendToSelf: false, SendToAccountant: false });
    expect(res.json.sent).toEqual(["a@b.cz"]);
  });
});

describe("create_issued_invoice", () => {
  const handler = (extra?: (c: Call) => ReturnType<typeof ok> | undefined) => (c: Call) => {
    const hit = extra?.(c);
    if (hit) return hit;
    const path = c.url.pathname;
    if (path.endsWith("/Contacts")) return page([{ Id: 3, CompanyName: "ACME s.r.o." }]);
    if (path.endsWith("/IssuedInvoices/Default")) return ok(defaultDraft);
    if (path.endsWith("/ExchangeRates")) return page([{ Amount: 1, ExchangeRateValue: 21.8, CurrencyId: 11, ExchangeListId: 1 }]);
    if (c.method === "POST") return ok({ ...invoice, Id: 8 });
    return { status: 500 } as never;
  };
  const posted = (calls: Call[]) => calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;

  it("starts from the default draft and resolves the partner by name", async () => {
    const { call, apiCalls } = await connect(handler(), false);
    const res = await call("create_issued_invoice", {
      partnerName: "ACME s.r.o.",
      items: [{ name: "Consulting", unitPrice: 1000, amount: 2, unit: "hod" }],
      dateOfIssue: "2026-11-08",
      dueInDays: 14,
      description: "November work",
    });
    expect(res.isError).toBeFalsy();
    expect(res.json.id).toBe(8);
    expect(posted(apiCalls())).toMatchObject({
      BankId: 5,
      PartnerId: 3,
      DateOfIssue: "2026-11-08",
      DateOfMaturity: "2026-11-22",
      Description: "November work",
      Items: [
        { Name: "Consulting", UnitPrice: 1000, Amount: 2, Unit: "hod", PriceType: 1, VatRateType: 1, VatRate: 21, ItemType: 0, DiscountPercentage: 0, IsTaxMovement: true },
      ],
    });
    expect(apiCalls().some((c) => c.url.pathname.endsWith("/ExchangeRates"))).toBe(false);
  });

  it("sets currency and exchange rate", async () => {
    const { call, apiCalls } = await connect(handler(), false);
    await call("create_issued_invoice", { partnerId: 3, currency: "usd", language: "en", items: [{ name: "Dev", unitPrice: 50, vatRateType: "zero" }] });
    const rate = apiCalls().find((c) => c.url.pathname.endsWith("/ExchangeRates"))!;
    expect(rate.url.searchParams.get("filter")).toMatch(/^\(CurrencyId~eq~11~and~ExchangeListId~eq~1~and~Date~lte~\d{4}-\d{2}-\d{2}\)$/);
    const body = posted(apiCalls());
    expect(body).toMatchObject({ CurrencyId: 11, ExchangeRate: 21.8, ExchangeRateAmount: 1, ReportLanguage: 3 });
    const item = (body.Items as Record<string, unknown>[])[0];
    expect(item.VatRateType).toBe(2);
    expect(item).not.toHaveProperty("VatRate");
    expect(item).not.toHaveProperty("VatCodeId");
  });

  it("copies settings from a previous invoice but takes fresh numbering", async () => {
    const copy = {
      ...defaultDraft,
      CurrencyId: 11,
      ReportLanguage: 3,
      DocumentSerialNumber: 19,
      VariableSymbol: "20260019",
      DateOfIssue: "2026-10-31",
      DateOfMaturity: "2026-11-14",
      Items: [{ Name: "Old", Id: 55, Prices: {}, VatRateType: 2, VatRate: 0, VatCodeId: 14, PriceType: 1, IsTaxMovement: true, DiscountPercentage: 0 }],
    };
    const { call, apiCalls } = await connect(handler((c) => (c.url.pathname.endsWith("/IssuedInvoices/67/Copy") ? ok(copy) : undefined)), false);
    await call("create_issued_invoice", { partnerId: 3, copyFromInvoiceId: 67, dateOfIssue: "2026-11-30", items: [{ name: "Dev November", unitPrice: 42 }] });
    const body = posted(apiCalls());
    expect(body).toMatchObject({
      CurrencyId: 11,
      ExchangeRate: 21.8,
      ReportLanguage: 3,
      DocumentSerialNumber: 21,
      VariableSymbol: "20260021",
      DateOfMaturity: "2026-12-14",
      Items: [{ Name: "Dev November", UnitPrice: 42, VatRateType: 2, VatRate: 0, VatCodeId: 14, PriceType: 1 }],
    });
    const item = (body.Items as Record<string, unknown>[])[0];
    expect(item).not.toHaveProperty("Id");
    expect(item).not.toHaveProperty("Prices");
  });

  it("refuses ambiguous partner names", async () => {
    const { call, apiCalls } = await connect(() => page([{ Id: 1, CompanyName: "ACME a" }, { Id: 2, CompanyName: "ACME b" }]), false);
    const res = await call("create_issued_invoice", { partnerName: "ACME", items: [{ name: "x", unitPrice: 1 }] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Several contacts match/);
    expect(apiCalls().some((c) => c.method === "POST")).toBe(false);
  });
});

describe("contact tools", () => {
  it("create_contact starts from the default contact and resolves the country", async () => {
    const { call, apiCalls } = await connect((c) => {
      if (c.url.pathname.endsWith("/Contacts/Default")) return ok({ CountryId: 2, CompanyName: "" });
      if (c.url.pathname.endsWith("/Countries")) return page([{ Id: 2, Code: "CZ" }, { Id: 1, Code: "SK" }]);
      return ok({ Id: 10, CompanyName: "Nová s.r.o.", IdentificationNumber: "123" });
    }, false);
    const res = await call("create_contact", { companyName: "Nová s.r.o.", ico: "123", country: "sk" });
    expect(apiCalls().find((c) => c.method === "POST")!.body).toMatchObject({ CompanyName: "Nová s.r.o.", IdentificationNumber: "123", CountryId: 1 });
    expect(res.json).toMatchObject({ id: 10, name: "Nová s.r.o.", ico: "123" });
  });

  it("list_contacts searches by name with base64 encoding", async () => {
    const { call, apiCalls } = await connect(() => page([{ Id: 1, CompanyName: "Alfa a.s.", Email: "x@alfa.cz" }]));
    const res = await call("list_contacts", { name: "Alfa a.s." });
    expect(apiCalls()[0].url.searchParams.get("filter")).toBe(`(CompanyName~ct:base64~${Buffer.from("Alfa a.s.").toString("base64")})`);
    expect(res.json.contacts[0]).toEqual({ id: 1, name: "Alfa a.s.", email: "x@alfa.cz" });
  });
});

describe("generic API tools", () => {
  it("search_api_docs finds endpoints by keyword", async () => {
    const { call } = await connect(() => ok({}));
    const res = await call("search_api_docs", { query: "bank statements list" });
    expect(res.json.map((e: { path: string }) => e.path)).toContain("BankStatements");
  });

  it("idoklad_api_request only allows GET in read-only mode", async () => {
    const { call } = await connect(() => ok({ done: true }));
    expect((await call("idoklad_api_request", { method: "GET", path: "BankAccounts" })).json).toEqual({ done: true });
    expect((await call("idoklad_api_request", { method: "DELETE", path: "Contacts/1" })).isError).toBe(true);
  });

  it("idoklad_api_request rejects absolute URLs", async () => {
    const { call } = await connect(() => ok({}));
    const res = await call("idoklad_api_request", { method: "GET", path: "https://evil.example/x" });
    expect(res.isError).toBe(true);
  });
});
