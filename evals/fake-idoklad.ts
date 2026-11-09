// A small, made-up iDoklad company for evals: a few contacts, invoices, proformas and so on.
// The eval server talks to this instead of the real API, so evals never touch real data.
import { fakeFetch, ok, testConfig, type Call } from "../test/helpers.js";

const page = (items: unknown[]) => ok({ Items: items, TotalItems: items.length, TotalPages: 1 });

const contacts = [
  { Id: 3, CompanyName: "ACME s.r.o.", IdentificationNumber: "11111111", Email: "info@acme.cz", City: "Brno", CountryId: 2 },
  { Id: 4, CompanyName: "Globex Corporation", IdentificationNumber: "", Email: "ap@globex.com", City: "Chicago", CountryId: 238 },
  { Id: 5, CompanyName: "Alfa a.s.", IdentificationNumber: "27170616", Email: "fakturace@alfa.cz", City: "Praha", CountryId: 2 },
  { Id: 6, CompanyName: "Hosting Plus s.r.o.", IdentificationNumber: "22222222", Email: "billing@hostingplus.cz", City: "Ostrava", CountryId: 2 },
];
const partner = (id: number) => {
  const c = contacts.find((x) => x.Id === id)!;
  return { PartnerId: id, PartnerAddress: { NickName: c.CompanyName, Email: c.Email } };
};

const doc = (o: { id: number; number: string; partnerId: number; issued: string; due: string; status: number; currency: number; total: number; description: string; items: unknown[] }) => ({
  Id: o.id,
  DocumentNumber: o.number,
  ...partner(o.partnerId),
  DateOfIssue: o.issued,
  DateOfMaturity: o.due,
  PaymentStatus: o.status,
  CurrencyId: o.currency,
  Description: o.description,
  Prices: { TotalWithVat: o.total, TotalWithoutVat: o.total, TotalPaid: o.status === 1 ? o.total : 0 },
  Items: o.items,
});

const item = (name: string, amount: number, unitPrice: number) => ({ Name: name, Amount: amount, UnitPrice: unitPrice, PriceType: 1, VatRateType: 1, IsTaxMovement: true, DiscountPercentage: 0 });

export const DATA = {
  issued: [
    doc({ id: 102, number: "20260019", partnerId: 4, issued: "2026-10-31", due: "2026-11-14", status: 0, currency: 11, total: 2227.18, description: "Web development October", items: [item("Web development", 54, 41.24)] }),
    doc({ id: 101, number: "20260018", partnerId: 4, issued: "2026-09-30", due: "2026-10-14", status: 0, currency: 11, total: 1309.5, description: "Web development September", items: [item("Web development", 31.75, 41.24)] }),
    doc({ id: 103, number: "20260017", partnerId: 3, issued: "2026-09-30", due: "2026-10-14", status: 1, currency: 1, total: 18150, description: "Consulting", items: [item("Consulting", 10, 1500)] }),
    doc({ id: 104, number: "20260015", partnerId: 3, issued: "2026-08-31", due: "2026-09-14", status: 1, currency: 1, total: 24200, description: "Software licences", items: [item("Software licence", 10, 2000)] }),
  ],
  proforma: [
    doc({ id: 201, number: "Z20260002", partnerId: 5, issued: "2026-10-01", due: "2026-10-15", status: 1, currency: 1, total: 60500, description: "Website project deposit", items: [item("Deposit", 1, 50000)] }),
    doc({ id: 202, number: "Z20260003", partnerId: 3, issued: "2026-11-02", due: "2026-11-16", status: 0, currency: 1, total: 12100, description: "Workshop deposit", items: [item("Deposit", 1, 10000)] }),
  ],
  credit: [doc({ id: 301, number: "D20260001", partnerId: 3, issued: "2026-03-10", due: "2026-03-24", status: 1, currency: 1, total: -2420, description: "Discount", items: [item("Discount", 1, -2000)] })],
  received: [doc({ id: 401, number: "PF20260007", partnerId: 6, issued: "2026-11-01", due: "2026-11-15", status: 0, currency: 1, total: 1210, description: "Hosting November", items: [item("Hosting", 1, 1000)] })],
};

const month = (n: number, period: string, total: number, unpaid = 0) => ({ NumericPeriod: n, Period: period, TotalWithVat: total, TotalWithoutVat: total, TotalPaid: total - unpaid, TotalUnpaid: unpaid });

// Statistics/* answers, keyed by endpoint. Globex (4) owes the 20260018 invoice; ACME (3) is the biggest customer.
const STATS: Record<string, unknown> = {
  InvoicingForPeriod: {
    IssuedInvoices: [month(202609, "Sep", 63750), month(202610, "Oct", 48552, 28552), month(202611, "Nov", 0)],
    ReceivedInvoices: [month(202609, "Sep", 1210), month(202610, "Oct", 1210), month(202611, "Nov", 1210, 1210)],
  },
  InvoicingForYear: {
    IssuedInvoices: { Paid: 820000, TotalWithVat: 870000, WithoutVat: 870000 },
    ReceivedInvoices: { Paid: 140000, TotalWithVat: 141210, WithoutVat: 116700 },
  },
  DebtIntervals: {
    Issue: [
      { Interval: 30, IntervalDescription: "1 - 30", TotalDebt: 28552 },
      { Interval: 60, IntervalDescription: "31 - 60", TotalDebt: 0 },
      { Interval: 90, IntervalDescription: "61 - 90", TotalDebt: 0 },
      { Interval: 999, IntervalDescription: "90+", TotalDebt: 0 },
    ],
    Entry: [{ Interval: 30, IntervalDescription: "1 - 30", TotalDebt: 0 }],
  },
  TopDebtors: [{ Name: "Globex Corporation", PartnerContactId: 4, TotalWithVatHc: 28552 }],
  TopPartners: [
    { Name: "ACME s.r.o.", PartnerContactId: 3, TotalWithVatHc: 512000 },
    { Name: "Globex Corporation", PartnerContactId: 4, TotalWithVatHc: 298000 },
    { Name: "Alfa a.s.", PartnerContactId: 5, TotalWithVatHc: 60500 },
  ],
  StatisticForContact: { IssuedInvoiceTotalWithVat: 298000, IssuedInvoiceCount: 9, IssuedInvoicePaidCount: 7, IssuedInvoiceUnpaidCount: 2, IssuedInvoiceAfterMaturityCount: 3 },
  VatTotals: { VatOutThisPeriod: 0, VatInThisPeriod: 0, DifferenceThisPeriod: 0, VatOutLastPeriod: 0, VatInLastPeriod: 0, DifferenceLastPeriod: 0 },
  VatPayerProgress: { DateFrom: "2026-01-01", DateTo: "2026-11-09", TotalSaleHc: 870000, VatPayerLimit: 2000000, VatPayerLimitImmediately: 2536500 },
  AgendaSummary: { IssuedInvoices: 4, ProformaInvoices: 2, CreditNotes: 1, ReceivedInvoices: 1, Contacts: 4 },
};

const draft = (from?: Record<string, unknown>) => ({
  DateOfIssue: "2026-11-09",
  DateOfMaturity: "2026-11-23",
  CurrencyId: (from?.CurrencyId as number) ?? 1,
  NumericSequenceId: 9,
  DocumentSerialNumber: 20,
  VariableSymbol: "20260020",
  PartnerId: from?.PartnerId,
  Items: [{ Name: "", Amount: 1, UnitPrice: 0, PriceType: 0, VatRateType: 1, VatRate: 21, VatCodeId: 3, IsTaxMovement: true, DiscountPercentage: 0 }],
});

const LISTS: Record<string, keyof typeof DATA> = {
  IssuedInvoices: "issued",
  ProformaInvoices: "proforma",
  CreditNotes: "credit",
  ReceivedInvoices: "received",
};

/** Applies the parts of the iDoklad filter the evals rely on: document number, partner, company name, IČO. */
function applyFilter<T extends Record<string, unknown>>(items: T[], filter: string | null): T[] {
  if (!filter) return items;
  const decode = (op: string, v: string) => (op.endsWith(":base64") ? Buffer.from(v, "base64").toString("utf8") : v);
  let out = items;
  for (const [, field, op, raw] of filter.matchAll(/(\w+)~([!\w]+(?::base64)?)~([^~)]+)/g)) {
    const value = decode(op, raw).toLowerCase();
    const get = (x: T) => String((field === "SupplierId" ? x.PartnerId : x[field]) ?? "").toLowerCase();
    const date = (x: T) => String(x[field] ?? "").slice(0, 10);
    if (field === "IsPaid") out = out.filter((x) => (x.PaymentStatus === 1) === (value === "true"));
    else if (field === "PaymentStatus") {
      const status = { unpaid: 0, paid: 1, partialpaid: 2, overpaid: 3 }[value] ?? Number(value);
      out = out.filter((x) => (op.startsWith("!") ? x.PaymentStatus !== status : x.PaymentStatus === status));
    } else if (field.startsWith("Date")) {
      const cmp = { lt: (d: string) => d < value, lte: (d: string) => d <= value, gt: (d: string) => d > value, gte: (d: string) => d >= value }[op];
      if (cmp) out = out.filter((x) => cmp(date(x)));
    } else if (op.startsWith("ct")) out = out.filter((x) => get(x).includes(value));
    else if (op.startsWith("eq")) out = out.filter((x) => get(x) === value);
  }
  return out;
}

function route(c: Call) {
  const parts = c.url.pathname.replace(/^\/v3\//, "").split("/");
  const [root, a, b] = parts;
  const filter = c.url.searchParams.get("filter");

  if (c.method === "GET") {
    if (root === "Currencies") return page([{ Id: 1, Code: "CZK" }, { Id: 2, Code: "EUR" }, { Id: 11, Code: "USD" }]);
    if (root === "Countries") return page([{ Id: 2, Code: "CZ" }, { Id: 1, Code: "SK" }, { Id: 238, Code: "US" }]);
    if (root === "ExchangeRates") return page([{ Amount: 1, ExchangeRateValue: 21.8, CurrencyId: 11, ExchangeListId: 1, Date: "2026-11-09" }]);
    if (root === "BankAccounts") return page([{ Id: 1, Name: "Hlavní účet", AccountNumber: "123456789/0300", CurrencyId: 1, IsDefault: true }]);
    if (root === "VatRates") return page([{ Id: 1, Name: "Základní sazba 21%", Rate: 21, RateType: 1, DateValidityTo: "9999-12-31" }, { Id: 2, Name: "Snížená sazba 12%", Rate: 12, RateType: 0, DateValidityTo: "9999-12-31" }]);
    if (root === "PaymentOptions") return page([{ Id: 1, Name: "Bank transfer", IsDefault: true }, { Id: 3, Name: "Cash" }]);
    if (root === "PriceListItems") return page(applyFilter([{ Id: 501, Name: "Grafický návrh webové prezentace", Code: "WEB", Price: 5000, PriceType: 1, CurrencyId: 1 }], filter));
    if (root === "Statistics") return ok(STATS[a] ?? {});
    if (root === "IssuedDocumentPayments") {
      const docId = Number(/InvoiceId~eq~(\d+)/.exec(filter ?? "")?.[1]);
      const paid = [...DATA.issued, ...DATA.proforma].filter((d) => d.PaymentStatus === 1 && (!docId || d.Id === docId));
      return page(paid.map((d, i) => ({ Id: 900 + i, InvoiceId: d.Id, InvoiceDocumentNumber: d.DocumentNumber, DateOfPayment: d.DateOfMaturity })));
    }
    if (root === "BankStatements") return page([{ Id: 601, DocumentNumber: "BV20260011", DateOfPayment: "2026-11-03", Amount: 18150, Description: "Platba 20260017" }]);
    if (root === "Contacts") {
      if (a === "Default") return ok({ CountryId: 2, CompanyName: "" });
      if (a) return ok(contacts.find((x) => x.Id === Number(a)) ?? contacts[0]);
      return page(applyFilter(contacts, filter));
    }
    if (root === "CreditNotes" && a === "Default") {
      const inv = DATA.issued.find((x) => x.Id === Number(b)) ?? DATA.issued[0];
      return ok({ ...draft(inv), CreditedInvoiceId: inv.Id, CreditNoteReason: "", Items: (inv.Items as Record<string, unknown>[]).map((i) => ({ ...i, UnitPrice: -(i.UnitPrice as number) })) });
    }
    if (root === "Reports") return ok(Buffer.from("%PDF-1.7 fake").toString("base64"));
    if (root in LISTS) {
      const list = DATA[LISTS[root]];
      if (!a) return page(applyFilter(list, filter));
      if (a === "Default") return ok(draft());
      const found = list.find((x) => x.Id === Number(a));
      if (!found) return { status: 404, json: { IsSuccess: false, Message: `Document ${a} not found` } };
      return ok(b === "Copy" ? draft(found) : found);
    }
    return page([]);
  }

  // Writes: pretend they succeeded. Nothing is stored.
  if (root === "Mails") return ok({ Sent: ["customer@example.com"], NotSent: [] });
  if (c.method === "PUT" && root === "ProformaInvoices") {
    const proforma = DATA.proforma.find((x) => x.Id === Number(a)) ?? DATA.proforma[0];
    return ok({ ...proforma, Id: 150, DocumentNumber: "20260020", DateOfIssue: "2026-11-09", DateOfMaturity: "2026-11-23" });
  }
  if (c.method === "PUT") return ok(true);
  if (root === "Contacts") return ok({ Id: 99, ...(c.body as object) });
  return ok({ ...(c.body as object), Id: 150, DocumentNumber: root === "CreditNotes" ? "D20260002" : "20260020", PaymentStatus: 0 });
}

export function fakeIdoklad() {
  return { config: testConfig, ...fakeFetch(route) };
}
