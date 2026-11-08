import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IdokladClient, Page } from "../client.js";
import type { Codebooks } from "../codebooks.js";
import { buildFilter, type Condition } from "../filter.js";
import { addDays, run, todayIso } from "./util.js";

// Subset of the iDoklad issued invoice model we rely on.
interface IssuedInvoice {
  Id: number;
  DocumentNumber?: string;
  DateOfIssue?: string;
  DateOfMaturity?: string;
  DateOfPayment?: string;
  Description?: string;
  VariableSymbol?: string;
  CurrencyId?: number;
  PartnerId?: number;
  PartnerAddress?: { NickName?: string; Firstname?: string; Surname?: string; IdentificationNumber?: string };
  PaymentStatus?: number;
  Prices?: { TotalWithVat?: number; TotalWithoutVat?: number; TotalPaid?: number };
  Items?: unknown[];
  [key: string]: unknown;
}

interface Contact {
  Id: number;
  CompanyName?: string;
  Firstname?: string;
  Surname?: string;
  IdentificationNumber?: string;
  Email?: string;
}

const PAYMENT_STATUS = ["unpaid", "paid", "partially_paid", "overpaid"] as const;

export function summarizeInvoice(inv: IssuedInvoice, currency?: string) {
  const partner = inv.PartnerAddress;
  return {
    id: inv.Id,
    number: inv.DocumentNumber,
    partner: partner?.NickName || [partner?.Firstname, partner?.Surname].filter(Boolean).join(" ") || undefined,
    partnerId: inv.PartnerId,
    description: inv.Description || undefined,
    issued: inv.DateOfIssue?.slice(0, 10),
    due: inv.DateOfMaturity?.slice(0, 10),
    paymentStatus: inv.PaymentStatus !== undefined ? PAYMENT_STATUS[inv.PaymentStatus] : undefined,
    totalWithVat: inv.Prices?.TotalWithVat,
    totalWithoutVat: inv.Prices?.TotalWithoutVat,
    totalPaid: inv.Prices?.TotalPaid,
    currency: currency ?? (inv.CurrencyId !== undefined ? `currencyId ${inv.CurrencyId}` : undefined),
    variableSymbol: inv.VariableSymbol || undefined,
  };
}

const VAT_RATE_TYPE = { reduced1: 0, basic: 1, zero: 2, reduced2: 3 } as const;
const PRICE_TYPE = { with_vat: 0, without_vat: 1, only_base: 2 } as const;

export function registerInvoiceTools(
  server: McpServer,
  client: IdokladClient,
  codebooks: Codebooks,
  opts: { readOnly: boolean },
) {
  const summarize = async (inv: IssuedInvoice) => summarizeInvoice(inv, await codebooks.currencyCode(inv.CurrencyId));

  server.registerTool(
    "list_issued_invoices",
    {
      title: "List issued invoices",
      description:
        "List issued invoices (vydané faktury), newest first. Filter by payment status, overdue, partner, issue date range or document number. " +
        "Returns a compact summary per invoice; use get_issued_invoice for full detail.",
      inputSchema: {
        status: z.enum(["unpaid", "paid", "partially_paid", "overdue"]).optional().describe("Payment status. 'overdue' = unpaid and past due date."),
        partnerId: z.number().int().optional().describe("Contact ID of the customer."),
        issuedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Issue date from (YYYY-MM-DD, inclusive)."),
        issuedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Issue date to (YYYY-MM-DD, inclusive)."),
        documentNumber: z.string().optional().describe("Part of the invoice number."),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(200).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const conditions: Condition[] = [];
        if (args.status === "paid") conditions.push({ field: "IsPaid", op: "eq", value: true });
        if (args.status === "unpaid") conditions.push({ field: "IsPaid", op: "eq", value: false });
        if (args.status === "partially_paid") conditions.push({ field: "PaymentStatus", op: "eq", value: "PartialPaid" });
        if (args.status === "overdue") {
          conditions.push({ field: "IsPaid", op: "eq", value: false }, { field: "DateOfMaturity", op: "lt", value: todayIso() });
        }
        if (args.partnerId) conditions.push({ field: "PartnerId", op: "eq", value: args.partnerId });
        if (args.issuedFrom) conditions.push({ field: "DateOfIssue", op: "gte", value: args.issuedFrom });
        if (args.issuedTo) conditions.push({ field: "DateOfIssue", op: "lte", value: args.issuedTo });
        if (args.documentNumber) conditions.push({ field: "DocumentNumber", op: "ct", value: args.documentNumber });

        const page = await client.get<Page<IssuedInvoice>>("IssuedInvoices", {
          filter: buildFilter(conditions),
          sort: "DateOfIssue~desc",
          page: args.page,
          pagesize: args.pageSize,
        });
        return {
          totalItems: page.TotalItems,
          totalPages: page.TotalPages,
          page: args.page,
          invoices: await Promise.all(page.Items.map(summarize)),
        };
      }),
  );

  server.registerTool(
    "get_issued_invoice",
    {
      title: "Get issued invoice",
      description: "Get full detail of one issued invoice (vydaná faktura) by ID, including items, partner and prices.",
      inputSchema: { id: z.number().int().describe("Invoice ID (not the document number).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ id }) => run(() => client.get<IssuedInvoice>(`IssuedInvoices/${id}`, { include: "Partner" })),
  );

  if (opts.readOnly) return;

  server.registerTool(
    "create_issued_invoice",
    {
      title: "Create issued invoice",
      description:
        "Create a new issued invoice (vydaná faktura). Starts from the company's default invoice in iDoklad " +
        "(numbering, bank account, VAT settings) and fills in the customer and items. " +
        "Identify the customer by partnerId, or by partnerName which must match exactly one contact.",
      inputSchema: {
        partnerId: z.number().int().optional().describe("Contact ID of the customer."),
        partnerName: z.string().optional().describe("Customer company name (searched in contacts) if partnerId is unknown."),
        items: z
          .array(
            z.object({
              name: z.string().min(1).max(200),
              unitPrice: z.number(),
              amount: z.number().default(1).describe("Quantity."),
              unit: z.string().max(20).optional().describe("Unit, e.g. 'ks', 'hod'."),
              priceType: z.enum(["without_vat", "with_vat", "only_base"]).default("without_vat").describe("Whether unitPrice excludes or includes VAT."),
              vatRateType: z.enum(["basic", "reduced1", "reduced2", "zero"]).default("basic").describe("VAT rate (basic = 21 % in CZ)."),
            }),
          )
          .min(1),
        dateOfIssue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Default: today."),
        dueInDays: z.number().int().min(0).optional().describe("Days until due. Default: the company's setting."),
        description: z.string().optional().describe("Invoice description (popis)."),
        note: z.string().optional(),
        orderNumber: z.string().max(25).optional(),
        variableSymbol: z.string().max(10).optional().describe("Default: generated from the invoice number."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const partnerId = args.partnerId ?? (await findPartnerId(client, args.partnerName));
        const draft = await client.get<Record<string, unknown>>("IssuedInvoices/Default");
        // The draft carries one blank item with every field iDoklad requires; reuse it for each line.
        const itemTemplate: Record<string, unknown> = {
          DiscountPercentage: 0,
          IsTaxMovement: false,
          ...((draft.Items as Record<string, unknown>[] | undefined)?.[0] ?? {}),
        };

        const dateOfIssue = args.dateOfIssue ?? (draft.DateOfIssue as string | undefined)?.slice(0, 10) ?? todayIso();
        const invoice: Record<string, unknown> = {
          ...draft,
          PartnerId: partnerId,
          DateOfIssue: dateOfIssue,
          DateOfTaxing: dateOfIssue,
          Items: args.items.map((item) => {
            const vatRateType = VAT_RATE_TYPE[item.vatRateType];
            const line: Record<string, unknown> = {
              ...itemTemplate,
              Name: item.name,
              UnitPrice: item.unitPrice,
              Amount: item.amount,
              Unit: item.unit ?? itemTemplate.Unit ?? "",
              PriceType: PRICE_TYPE[item.priceType],
              VatRateType: vatRateType,
              ItemType: 0,
            };
            // The template's VAT rate and code belong to its own rate type; let iDoklad pick them for other types.
            if (vatRateType !== itemTemplate.VatRateType) {
              delete line.VatRate;
              delete line.VatCodeId;
            }
            return line;
          }),
        };
        if (args.dueInDays !== undefined) invoice.DateOfMaturity = addDays(dateOfIssue, args.dueInDays);
        if (args.description !== undefined) invoice.Description = args.description;
        if (args.note !== undefined) invoice.Note = args.note;
        if (args.orderNumber !== undefined) invoice.OrderNumber = args.orderNumber;
        if (args.variableSymbol !== undefined) invoice.VariableSymbol = args.variableSymbol;

        const created = await client.post<IssuedInvoice>("IssuedInvoices", invoice);
        return summarize(created);
      }),
  );
}

async function findPartnerId(client: IdokladClient, name?: string): Promise<number> {
  if (!name) throw new Error("Provide partnerId or partnerName.");
  const page = await client.get<Page<Contact>>("Contacts", {
    filter: buildFilter([{ field: "CompanyName", op: "ct", value: name }]),
    pagesize: 10,
  });
  const exact = page.Items.filter((c) => c.CompanyName?.toLowerCase() === name.toLowerCase());
  const matches = exact.length ? exact : page.Items;
  if (matches.length === 1) return matches[0].Id;

  const list = matches.map((c) => `${c.Id}: ${c.CompanyName ?? ""} ${c.IdentificationNumber ? `(IČO ${c.IdentificationNumber})` : ""}`.trim());
  throw new Error(
    matches.length === 0
      ? `No contact matches "${name}". Create the contact first or pass partnerId.`
      : `Several contacts match "${name}"; pass partnerId instead:\n${list.join("\n")}`,
  );
}
