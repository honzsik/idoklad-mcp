import { z } from "zod";
import type { IdokladClient, Page } from "../client.js";
import type { Codebooks } from "../codebooks.js";
import { REPORT_LANGUAGE, summarizeDocument, type Document } from "../documents.js";
import { buildFilter } from "../filter.js";
import { WRITE, type ToolContext } from "./context.js";
import { addDays, run, todayIso } from "./util.js";

interface Contact {
  Id: number;
  CompanyName?: string;
  IdentificationNumber?: string;
}

type Draft = Record<string, unknown>;

const VAT_RATE_TYPE = { reduced1: 0, basic: 1, zero: 2, reduced2: 3 } as const;
const PRICE_TYPE = { with_vat: 0, without_vat: 1, only_base: 2 } as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const itemSchema = z.object({
  name: z.string().min(1).max(200),
  unitPrice: z.number(),
  amount: z.number().default(1).describe("Quantity."),
  unit: z.string().max(20).optional().describe("Unit, e.g. 'ks', 'hod'."),
  priceType: z
    .enum(["without_vat", "with_vat", "only_base"])
    .optional()
    .describe("Whether unitPrice excludes or includes VAT. Default: without_vat, or the copied document's setting."),
  vatRateType: z.enum(["basic", "reduced1", "reduced2", "zero"]).optional().describe("VAT rate (basic = 21 % in CZ). Default: the template's rate."),
});
type ItemInput = z.infer<typeof itemSchema>;

/** Sale documents created the same way: start from the Default (or a Copy) draft and fill in partner and items. */
const SALE_DOCS = {
  issued_invoice: { tool: "create_issued_invoice", path: "IssuedInvoices", label: "issued invoice (vydaná faktura)" },
  proforma_invoice: { tool: "create_proforma_invoice", path: "ProformaInvoices", label: "proforma invoice (zálohová faktura)" },
} as const;

export function registerInvoiceTools(ctx: ToolContext) {
  const { server, client, codebooks } = ctx;
  if (ctx.readOnly) return;

  for (const doc of Object.values(SALE_DOCS)) {
    server.registerTool(
      doc.tool,
      {
        title: `Create ${doc.label.split(" (")[0]}`,
        description:
          `Create a new ${doc.label}. By default it starts from the company's default settings in iDoklad ` +
          "(numbering, bank account, VAT). For a repeat customer, pass copyFromId of their previous document of the same type " +
          "to reuse its currency, VAT treatment, language and payment method; only the items and dates change. " +
          "Identify the customer by partnerId, or by partnerName which must match exactly one contact. " +
          "Confirm the details with the user before creating.",
        inputSchema: {
          partnerId: z.number().int().optional().describe("Contact ID of the customer."),
          partnerName: z.string().optional().describe("Customer company name (searched in contacts) if partnerId is unknown."),
          copyFromId: z.number().int().optional().describe(`ID of an earlier ${doc.label.split(" (")[0]} to copy settings from.`),
          items: z.array(itemSchema).min(1),
          currency: z.string().length(3).optional().describe("Currency code, e.g. CZK, EUR, USD. The exchange rate is filled in automatically."),
          language: z.enum(["cs", "sk", "en", "de"]).optional().describe("Document language."),
          dateOfIssue: date.optional().describe("Default: today."),
          dueInDays: z.number().int().min(0).optional().describe("Days until due. Default: the company's setting or the copied document's."),
          description: z.string().optional().describe("Description (popis)."),
          note: z.string().optional(),
          orderNumber: z.string().max(25).optional(),
          variableSymbol: z.string().max(10).optional().describe("Default: generated from the document number."),
        },
        annotations: WRITE,
      },
      (args) =>
        run(async () => {
          const partnerId = args.partnerId ?? (await findPartnerId(client, args.partnerName));
          const [defaults, copied] = await Promise.all([
            client.get<Draft>(`${doc.path}/Default`),
            args.copyFromId ? client.get<Draft>(`${doc.path}/${args.copyFromId}/Copy`) : undefined,
          ]);
          const draft = copied ?? defaults;
          const dateOfIssue = args.dateOfIssue ?? todayIso();

          const body: Draft = {
            ...draft,
            PartnerId: partnerId,
            DateOfIssue: dateOfIssue,
            DateOfTaxing: dateOfIssue,
            Items: args.items.map((item) => buildItem(item, itemTemplate(draft), { netPricesByDefault: !copied })),
          };

          // Keep the due period: from the copied document's own dates, or the default draft's.
          const dueDays = args.dueInDays ?? daysBetween(draft.DateOfIssue, draft.DateOfMaturity);
          if (dueDays !== undefined) body.DateOfMaturity = addDays(dateOfIssue, dueDays);

          if (args.currency || copied) {
            const currencyId = args.currency ? await codebooks.currencyId(args.currency) : (draft.CurrencyId as number);
            Object.assign(body, await exchangeFields(codebooks, currencyId, defaults.CurrencyId as number, dateOfIssue));
          }
          if (copied) {
            // Take numbering from the default draft so the new document gets the next free number.
            body.NumericSequenceId = defaults.NumericSequenceId;
            body.DocumentSerialNumber = defaults.DocumentSerialNumber;
            body.VariableSymbol = defaults.VariableSymbol;
          }
          setOptional(body, {
            ReportLanguage: args.language ? REPORT_LANGUAGE[args.language] : undefined,
            Description: args.description,
            Note: args.note,
            OrderNumber: args.orderNumber,
            VariableSymbol: args.variableSymbol,
          });

          const created = await client.post<Document>(doc.path, body);
          return summarizeDocument(created, await codebooks.currencyCode(created.CurrencyId));
        }),
    );
  }

  server.registerTool(
    "create_credit_note",
    {
      title: "Create credit note",
      description:
        "Create a credit note (opravný daňový doklad / dobropis) for an issued invoice. Without items it credits the whole invoice; " +
        "with items it credits only those (give positive prices; they are entered as negative). " +
        "With offset=true the credit note is settled against the invoice right away. Confirm with the user before creating.",
      inputSchema: {
        invoiceId: z.number().int().describe("ID of the issued invoice to credit."),
        reason: z.string().min(1).describe("Reason for the credit note (důvod opravy), shown on the document."),
        items: z.array(itemSchema).min(1).optional().describe("Items to credit. Default: all items of the invoice."),
        offset: z.boolean().default(false).describe("Settle the credit note against the invoice (započtení)."),
        dateOfIssue: date.optional().describe("Default: today."),
        description: z.string().optional(),
        note: z.string().optional(),
      },
      annotations: WRITE,
    },
    (args) =>
      run(async () => {
        const draft = await client.get<Draft>(`CreditNotes/Default/${args.invoiceId}`);
        const dateOfIssue = args.dateOfIssue ?? todayIso();
        const body: Draft = { ...draft, CreditNoteReason: args.reason, DateOfIssue: dateOfIssue, DateOfTaxing: dateOfIssue };
        if (args.items) {
          const template = itemTemplate(draft);
          body.Items = args.items.map((item) => {
            const line = buildItem(item, template, { netPricesByDefault: false });
            line.UnitPrice = -Math.abs(item.unitPrice);
            return line;
          });
        }
        const dueDays = daysBetween(draft.DateOfIssue, draft.DateOfMaturity);
        if (dueDays !== undefined) body.DateOfMaturity = addDays(dateOfIssue, dueDays);
        setOptional(body, { Description: args.description, Note: args.note });

        const created = await client.post<Document>(args.offset ? "CreditNotes/Offset" : "CreditNotes", body);
        return summarizeDocument(created, await codebooks.currencyCode(created.CurrencyId));
      }),
  );

  server.registerTool(
    "create_invoice_from_proforma",
    {
      title: "Create invoice from paid proforma",
      description:
        "Create the final issued invoice (vyúčtování zálohy) from a fully paid proforma invoice. " +
        "The proforma must be paid first (see mark_document_paid). Confirm with the user before creating.",
      inputSchema: { proformaId: z.number().int().describe("ID of the paid proforma invoice.") },
      annotations: WRITE,
    },
    ({ proformaId }) =>
      run(async () => {
        const created = await client.put<Document>(`ProformaInvoices/${proformaId}/Account`);
        return summarizeDocument(created, await codebooks.currencyCode(created.CurrencyId));
      }),
  );
}

/** The draft's first item carries every field iDoklad requires; reuse it for each new line. */
function itemTemplate(draft: Draft): Draft {
  return { DiscountPercentage: 0, IsTaxMovement: false, ...((draft.Items as Draft[] | undefined)?.[0] ?? {}) };
}

function buildItem(item: ItemInput, template: Draft, opts: { netPricesByDefault: boolean }): Draft {
  const line: Draft = {
    ...template,
    Name: item.name,
    UnitPrice: item.unitPrice,
    Amount: item.amount,
    Unit: item.unit ?? template.Unit ?? "",
    ItemType: 0,
  };
  // The default draft has PriceType "with VAT"; we default to "without VAT" as people usually quote net prices.
  if (item.priceType) line.PriceType = PRICE_TYPE[item.priceType];
  else if (opts.netPricesByDefault) line.PriceType = PRICE_TYPE.without_vat;

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

async function exchangeFields(codebooks: Codebooks, currencyId: number, homeCurrencyId: number, date: string) {
  const { rate, amount } = await codebooks.exchangeRate(currencyId, homeCurrencyId, date);
  return { CurrencyId: currencyId, ExchangeRate: rate, ExchangeRateAmount: amount };
}

function setOptional(target: Draft, values: Draft) {
  for (const [key, value] of Object.entries(values)) if (value !== undefined) target[key] = value;
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
