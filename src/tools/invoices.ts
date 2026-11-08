import { z } from "zod";
import type { IdokladClient, Page } from "../client.js";
import { REPORT_LANGUAGE, summarizeDocument, type Document } from "../documents.js";
import { buildFilter } from "../filter.js";
import { WRITE, type ToolContext } from "./context.js";
import { addDays, run, todayIso } from "./util.js";

interface Contact {
  Id: number;
  CompanyName?: string;
  IdentificationNumber?: string;
}

const VAT_RATE_TYPE = { reduced1: 0, basic: 1, zero: 2, reduced2: 3 } as const;
const PRICE_TYPE = { with_vat: 0, without_vat: 1, only_base: 2 } as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export function registerInvoiceTools(ctx: ToolContext) {
  const { server, client, codebooks } = ctx;
  if (ctx.readOnly) return;

  server.registerTool(
    "create_issued_invoice",
    {
      title: "Create issued invoice",
      description:
        "Create a new issued invoice (vydaná faktura). By default it starts from the company's default invoice in iDoklad " +
        "(numbering, bank account, VAT settings). For a repeat customer, pass copyFromInvoiceId of their previous invoice " +
        "to reuse its currency, VAT treatment, language and payment method; only the items and dates change. " +
        "Identify the customer by partnerId, or by partnerName which must match exactly one contact. " +
        "Confirm the details with the user before creating.",
      inputSchema: {
        partnerId: z.number().int().optional().describe("Contact ID of the customer."),
        partnerName: z.string().optional().describe("Customer company name (searched in contacts) if partnerId is unknown."),
        copyFromInvoiceId: z.number().int().optional().describe("ID of an earlier issued invoice to copy settings from."),
        items: z
          .array(
            z.object({
              name: z.string().min(1).max(200),
              unitPrice: z.number(),
              amount: z.number().default(1).describe("Quantity."),
              unit: z.string().max(20).optional().describe("Unit, e.g. 'ks', 'hod'."),
              priceType: z.enum(["without_vat", "with_vat", "only_base"]).optional().describe("Whether unitPrice excludes or includes VAT. Default: without_vat, or the copied invoice's setting."),
              vatRateType: z.enum(["basic", "reduced1", "reduced2", "zero"]).optional().describe("VAT rate (basic = 21 % in CZ). Default: the template's rate."),
            }),
          )
          .min(1),
        currency: z.string().length(3).optional().describe("Currency code, e.g. CZK, EUR, USD. The exchange rate is filled in automatically."),
        language: z.enum(["cs", "sk", "en", "de"]).optional().describe("Invoice language."),
        dateOfIssue: date.optional().describe("Default: today."),
        dueInDays: z.number().int().min(0).optional().describe("Days until due. Default: the company's setting."),
        description: z.string().optional().describe("Invoice description (popis)."),
        note: z.string().optional(),
        orderNumber: z.string().max(25).optional(),
        variableSymbol: z.string().max(10).optional().describe("Default: generated from the invoice number."),
      },
      annotations: WRITE,
    },
    (args) =>
      run(async () => {
        const partnerId = args.partnerId ?? (await findPartnerId(client, args.partnerName));
        const [defaults, copied] = await Promise.all([
          client.get<Record<string, unknown>>("IssuedInvoices/Default"),
          args.copyFromInvoiceId ? client.get<Record<string, unknown>>(`IssuedInvoices/${args.copyFromInvoiceId}/Copy`) : undefined,
        ]);
        const draft = copied ?? defaults;

        // The draft carries a template item with every field iDoklad requires; reuse it for each line.
        const itemTemplate: Record<string, unknown> = {
          DiscountPercentage: 0,
          IsTaxMovement: false,
          ...((draft.Items as Record<string, unknown>[] | undefined)?.[0] ?? {}),
        };

        const dateOfIssue = args.dateOfIssue ?? todayIso();
        const invoice: Record<string, unknown> = {
          ...draft,
          PartnerId: partnerId,
          DateOfIssue: dateOfIssue,
          DateOfTaxing: dateOfIssue,
          Items: args.items.map((item) => buildItem(item, itemTemplate, !copied)),
        };

        // Keep the due period: from the copied invoice's own dates, or the default draft's.
        const dueDays = args.dueInDays ?? daysBetween(draft.DateOfIssue, draft.DateOfMaturity);
        if (dueDays !== undefined) invoice.DateOfMaturity = addDays(dateOfIssue, dueDays);

        if (args.currency || copied) {
          const currencyId = args.currency ? await codebooks.currencyId(args.currency) : (draft.CurrencyId as number);
          const { rate, amount } = await codebooks.exchangeRate(currencyId, defaults.CurrencyId as number, dateOfIssue);
          invoice.CurrencyId = currencyId;
          invoice.ExchangeRate = rate;
          invoice.ExchangeRateAmount = amount;
        }
        if (args.language) invoice.ReportLanguage = REPORT_LANGUAGE[args.language];
        if (args.description !== undefined) invoice.Description = args.description;
        if (args.note !== undefined) invoice.Note = args.note;
        if (args.orderNumber !== undefined) invoice.OrderNumber = args.orderNumber;
        if (args.variableSymbol !== undefined) invoice.VariableSymbol = args.variableSymbol;
        if (copied) {
          // Take numbering from the default draft so the new invoice gets the next free number.
          invoice.NumericSequenceId = defaults.NumericSequenceId;
          invoice.DocumentSerialNumber = defaults.DocumentSerialNumber;
          if (args.variableSymbol === undefined) invoice.VariableSymbol = defaults.VariableSymbol;
        }

        const created = await client.post<Document>("IssuedInvoices", invoice);
        return summarizeDocument(created, await codebooks.currencyCode(created.CurrencyId));
      }),
  );
}

type ItemInput = {
  name: string;
  unitPrice: number;
  amount: number;
  unit?: string;
  priceType?: keyof typeof PRICE_TYPE;
  vatRateType?: keyof typeof VAT_RATE_TYPE;
};

function buildItem(item: ItemInput, template: Record<string, unknown>, isDefaultTemplate: boolean): Record<string, unknown> {
  const line: Record<string, unknown> = {
    ...template,
    Name: item.name,
    UnitPrice: item.unitPrice,
    Amount: item.amount,
    Unit: item.unit ?? template.Unit ?? "",
    ItemType: 0,
  };
  // The default draft has PriceType "with VAT"; we default to "without VAT" as people usually quote net prices.
  if (item.priceType) line.PriceType = PRICE_TYPE[item.priceType];
  else if (isDefaultTemplate) line.PriceType = PRICE_TYPE.without_vat;

  if (item.vatRateType) {
    const vatRateType = VAT_RATE_TYPE[item.vatRateType];
    line.VatRateType = vatRateType;
    // The template's VAT rate and code belong to its own rate type; let iDoklad pick them for other types.
    if (vatRateType !== template.VatRateType) {
      delete line.VatRate;
      delete line.VatCodeId;
    }
  }
  delete line.Id;
  delete line.Prices;
  return line;
}

function daysBetween(from: unknown, to: unknown): number | undefined {
  if (typeof from !== "string" || typeof to !== "string") return undefined;
  const ms = Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10));
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 86_400_000) : undefined;
}

export async function findPartnerId(client: IdokladClient, name?: string): Promise<number> {
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
      ? `No contact matches "${name}". Create the contact first (create_contact) or pass partnerId.`
      : `Several contacts match "${name}"; pass partnerId instead:\n${list.join("\n")}`,
  );
}
