// Eval cases: a user request, the tool call(s) that must happen, and tool calls that must not.
// Ids in the fake company (evals/fake-idoklad.ts): contacts ACME 3, Globex 4, Alfa 5;
// invoices 20260018 → 101, 20260019 → 102, 20260017 → 103, 20260015 → 104;
// proformas Z20260002 → 201 (paid), Z20260003 → 202.

/** Expected value for one argument: an exact value, or a check function. */
export type Matcher = unknown | ((value: unknown) => boolean);

export interface ExpectedCall {
  tool: string;
  /** Arguments that must match. Other arguments are ignored. Nested objects/arrays match partially. */
  args?: Record<string, Matcher>;
}

export interface EvalCase {
  id: string;
  prompt: string;
  /** At least one of these calls must happen during the conversation. Empty = no tool call expected. */
  expect: ExpectedCall[];
  /** Tools that must not be called. Write tools are forbidden by default unless expected. */
  forbid?: string[];
  /** For "no tools" cases: fail if any tool is called. */
  noTools?: boolean;
}

export const WRITE_TOOLS = [
  "create_issued_invoice",
  "create_proforma_invoice",
  "create_credit_note",
  "create_invoice_from_proforma",
  "create_contact",
  "send_document_email",
  "mark_document_paid",
  "mark_document_unpaid",
];

const contains = (s: string) => (v: unknown) => typeof v === "string" && v.toLowerCase().includes(s.toLowerCase());
const oneOf = (...xs: unknown[]) => (v: unknown) => xs.includes(v);

export const CASES: EvalCase[] = [
  // ── Reading ────────────────────────────────────────────────────────────────
  { id: "overdue-cs", prompt: "Které faktury jsou po splatnosti?", expect: [{ tool: "list_issued_invoices", args: { status: "overdue" } }] },
  { id: "unpaid-en", prompt: "Which of our invoices haven't been paid yet?", expect: [{ tool: "list_issued_invoices", args: { status: oneOf("unpaid", "overdue") } }] },
  { id: "partner-invoices-cs", prompt: "Ukaž mi všechny faktury pro ACME.", expect: [{ tool: "list_issued_invoices", args: { partnerId: 3 } }] },
  {
    id: "invoice-by-number-en",
    prompt: "Show me invoice 20260018.",
    expect: [{ tool: "get_issued_invoice", args: { id: 101 } }, { tool: "list_issued_invoices", args: { documentNumber: contains("20260018") } }],
  },
  { id: "october-en", prompt: "List the invoices we issued in October 2026.", expect: [{ tool: "list_issued_invoices", args: { issuedFrom: "2026-10-01", issuedTo: "2026-10-31" } }] },
  { id: "pdf-latest-cs", prompt: "Stáhni mi PDF poslední faktury pro Globex.", expect: [{ tool: "get_document_pdf", args: { documentType: "issued_invoice", id: 102 } }] },
  { id: "pdf-english-en", prompt: "Download invoice 20260018 as a PDF in English.", expect: [{ tool: "get_document_pdf", args: { documentType: "issued_invoice", id: 101, language: "en" } }] },
  { id: "received-unpaid-cs", prompt: "Které přijaté faktury ještě nemáme zaplacené?", expect: [{ tool: "list_received_invoices", args: { status: oneOf("unpaid", "overdue") } }] },
  { id: "proformas-en", prompt: "List our proforma invoices.", expect: [{ tool: "list_proforma_invoices" }] },
  { id: "credit-notes-cs", prompt: "Vypiš dobropisy vystavené letos.", expect: [{ tool: "list_credit_notes", args: { issuedFrom: "2026-01-01" } }] },
  { id: "contact-by-ico-en", prompt: "Find the contact with IČO 27170616.", expect: [{ tool: "list_contacts", args: { ico: "27170616" } }] },
  { id: "contact-email-cs", prompt: "Jaký e-mail má Alfa a.s.?", expect: [{ tool: "list_contacts" }, { tool: "get_contact", args: { id: 5 } }] },
  { id: "price-list-en", prompt: "What do we charge for web design according to our price list?", expect: [{ tool: "list_price_list_items" }] },
  { id: "bank-accounts-cs", prompt: "Jaká máme v iDokladu bankovní účty?", expect: [{ tool: "get_codebook", args: { codebook: "bank_accounts" } }] },
  { id: "vat-rates-en", prompt: "Which VAT rates can I use on invoices?", expect: [{ tool: "get_codebook", args: { codebook: "vat_rates" } }] },
  {
    id: "bank-statements-cs",
    prompt: "Ukaž mi naše bankovní výpisy v iDokladu.",
    expect: [{ tool: "idoklad_api_request", args: { method: "GET", path: contains("BankStatements") } }],
  },

  // ── Writing (the runner answers "yes" once if Claude asks for confirmation) ─
  {
    id: "create-invoice-en",
    prompt: "Create an invoice for ACME s.r.o.: 10 hours of consulting at 1,500 CZK per hour, due in 14 days.",
    expect: [{ tool: "create_issued_invoice", args: { items: [{ unitPrice: 1500, amount: 10 }], dueInDays: 14 } }],
  },
  {
    id: "invoice-like-last-cs",
    prompt: "Vystav fakturu pro Globex stejně jako minule, jen tentokrát za 42 hodin.",
    expect: [{ tool: "create_issued_invoice", args: { copyFromId: 102, items: [{ amount: 42 }] } }],
  },
  {
    id: "invoice-usd-en",
    prompt: "Bill Globex Corporation 500 USD for server hosting in November.",
    expect: [{ tool: "create_issued_invoice", args: { currency: "USD", items: [{ unitPrice: 500 }] } }],
  },
  {
    id: "mark-paid-cs",
    prompt: "Označ fakturu 20260018 jako zaplacenou k dnešnímu dni.",
    expect: [{ tool: "mark_document_paid", args: { documentType: "issued_invoice", id: 101 } }],
  },
  {
    id: "mark-unpaid-cs",
    prompt: "Zruš úhradu u faktury 20260017, platba se vrátila.",
    expect: [{ tool: "mark_document_unpaid", args: { documentType: "issued_invoice", id: 103 } }],
  },
  {
    id: "send-email-en",
    prompt: "Email invoice 20260018 to the customer.",
    expect: [{ tool: "send_document_email", args: { documentType: "issued_invoice", id: 101 } }],
  },
  {
    id: "credit-note-cs",
    prompt: "Vystav dobropis k faktuře 20260015, klient vrátil 2 z 10 licencí.",
    expect: [{ tool: "create_credit_note", args: { invoiceId: 104, items: [{ amount: 2 }] } }],
  },
  {
    id: "proforma-en",
    prompt: "Create a proforma invoice for Alfa a.s.: a 5,000 CZK deposit for the new website.",
    expect: [{ tool: "create_proforma_invoice", args: { partnerId: 5, items: [{ unitPrice: 5000 }] } }, { tool: "create_proforma_invoice", args: { partnerName: contains("Alfa"), items: [{ unitPrice: 5000 }] } }],
  },
  {
    id: "final-from-proforma-en",
    prompt: "Proforma Z20260002 has been paid. Create the final invoice from it.",
    expect: [{ tool: "create_invoice_from_proforma", args: { proformaId: 201 } }],
  },
  {
    id: "new-contact-cs",
    prompt: "Přidej nový kontakt: Nová firma s.r.o., IČO 12345678, Praha.",
    expect: [{ tool: "create_contact", args: { companyName: contains("Nová firma"), ico: "12345678" } }],
  },

  // ── Must not act ───────────────────────────────────────────────────────────
  { id: "paid-question-cs", prompt: "Je faktura 20260018 už zaplacená?", expect: [{ tool: "get_issued_invoice", args: { id: 101 } }, { tool: "list_issued_invoices" }] },
  { id: "quote-only-cs", prompt: "Kolik by činila faktura pro ACME za 10 hodin po 1 500 Kč bez DPH, včetně 21 % DPH? Nic nevystavuj.", expect: [], forbid: WRITE_TOOLS },
  {
    id: "draft-reminder-en",
    prompt: "Write me the text of a polite payment reminder for invoice 20260018. Don't send anything.",
    expect: [{ tool: "get_issued_invoice", args: { id: 101 } }, { tool: "list_issued_invoices" }],
  },
  { id: "off-topic-en", prompt: "What's a good name for a cat?", expect: [], noTools: true },
];
