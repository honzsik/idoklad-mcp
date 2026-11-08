import { z } from "zod";
import type { Page } from "../client.js";
import { buildFilter, type Condition } from "../filter.js";
import { READ, WRITE, type ToolContext } from "./context.js";
import { run } from "./util.js";

interface Contact {
  Id: number;
  CompanyName?: string;
  Firstname?: string;
  Surname?: string;
  IdentificationNumber?: string;
  VatIdentificationNumber?: string;
  Email?: string;
  Phone?: string;
  City?: string;
  CountryId?: number;
  [key: string]: unknown;
}

interface PriceListItem {
  Id: number;
  Name?: string;
  Code?: string;
  Unit?: string;
  Price?: number;
  PriceType?: number;
  CurrencyId?: number;
  VatRateType?: number;
  StockBalance?: number;
  [key: string]: unknown;
}

const summarizeContact = (c: Contact) => ({
  id: c.Id,
  name: c.CompanyName || [c.Firstname, c.Surname].filter(Boolean).join(" ") || undefined,
  ico: c.IdentificationNumber || undefined,
  dic: c.VatIdentificationNumber || undefined,
  email: c.Email || undefined,
  phone: c.Phone || undefined,
  city: c.City || undefined,
});

export function registerContactTools(ctx: ToolContext) {
  const { server, client, codebooks } = ctx;

  server.registerTool(
    "list_contacts",
    {
      title: "List contacts",
      description: "Search contacts (kontakty: customers and suppliers) by company name, IČO, DIČ or email. Without filters, lists all contacts.",
      inputSchema: z.object({
        name: z.string().optional().describe("Part of the company name."),
        ico: z.string().optional().describe("Company ID (IČO)."),
        dic: z.string().optional().describe("VAT ID (DIČ)."),
        email: z.string().optional().describe("Part of the email address."),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(200).default(20),
      }),
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const conditions: Condition[] = [];
        if (args.name) conditions.push({ field: "CompanyName", op: "ct", value: args.name });
        if (args.ico) conditions.push({ field: "IdentificationNumber", op: "eq", value: args.ico });
        if (args.dic) conditions.push({ field: "VatIdentificationNumber", op: "eq", value: args.dic });
        if (args.email) conditions.push({ field: "Email", op: "ct", value: args.email });
        const page = await client.get<Page<Contact>>("Contacts", {
          filter: buildFilter(conditions),
          sort: "CompanyName~asc",
          page: args.page,
          pagesize: args.pageSize,
        });
        return { totalItems: page.TotalItems, totalPages: page.TotalPages, page: args.page, contacts: page.Items.map(summarizeContact) };
      }),
  );

  server.registerTool(
    "get_contact",
    {
      title: "Get contact",
      description: "Get full detail of one contact by ID: address, IČO, DIČ, bank account, default due days.",
      inputSchema: z.object({ id: z.number().int() }),
      annotations: READ,
    },
    ({ id }) => run(() => client.get<Contact>(`Contacts/${id}`)),
  );

  server.registerTool(
    "list_price_list_items",
    {
      title: "List price list items",
      description: "Search the price list (ceník) by item name or code. Use the prices when creating invoices.",
      inputSchema: z.object({
        name: z.string().optional().describe("Part of the item name."),
        code: z.string().optional().describe("Part of the item code."),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(200).default(20),
      }),
      annotations: READ,
    },
    (args) =>
      run(async () => {
        const conditions: Condition[] = [];
        if (args.name) conditions.push({ field: "Name", op: "ct", value: args.name });
        if (args.code) conditions.push({ field: "Code", op: "ct", value: args.code });
        const page = await client.get<Page<PriceListItem>>("PriceListItems", {
          filter: buildFilter(conditions),
          sort: "Name~asc",
          page: args.page,
          pagesize: args.pageSize,
        });
        const items = await Promise.all(
          page.Items.map(async (i) => ({
            id: i.Id,
            name: i.Name,
            code: i.Code || undefined,
            unit: i.Unit || undefined,
            price: i.Price,
            priceIncludesVat: i.PriceType === 0,
            currency: await codebooks.currencyCode(i.CurrencyId),
            stock: i.StockBalance,
          })),
        );
        return { totalItems: page.TotalItems, totalPages: page.TotalPages, page: args.page, items };
      }),
  );

  if (ctx.readOnly) return;

  server.registerTool(
    "create_contact",
    {
      title: "Create contact",
      description: "Create a new contact (customer or supplier). Confirm the details with the user before creating.",
      inputSchema: z.object({
        companyName: z.string().min(1).max(200),
        ico: z.string().max(20).optional().describe("Company ID (IČO)."),
        dic: z.string().max(20).optional().describe("VAT ID (DIČ), e.g. CZ12345678."),
        street: z.string().max(100).optional(),
        city: z.string().max(50).optional(),
        postalCode: z.string().max(11).optional(),
        country: z.string().length(2).optional().describe("Two-letter ISO country code. Default: the company's own country."),
        email: z.string().email().optional(),
        phone: z.string().max(20).optional(),
        firstname: z.string().max(50).optional(),
        surname: z.string().max(50).optional(),
        defaultDueDays: z.number().int().min(0).optional().describe("Default invoice due period for this contact."),
        note: z.string().optional(),
      }),
      annotations: WRITE,
    },
    (args) =>
      run(async () => {
        const draft = await client.get<Record<string, unknown>>("Contacts/Default");
        const contact: Record<string, unknown> = { ...draft, CompanyName: args.companyName };
        const fields: Record<string, unknown> = {
          IdentificationNumber: args.ico,
          VatIdentificationNumber: args.dic,
          Street: args.street,
          City: args.city,
          PostalCode: args.postalCode,
          Email: args.email,
          Phone: args.phone,
          Firstname: args.firstname,
          Surname: args.surname,
          DefaultInvoiceMaturity: args.defaultDueDays,
          Note: args.note,
          CountryId: args.country ? await codebooks.countryId(args.country) : undefined,
        };
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) contact[k] = v;
        const created = await client.post<Contact>("Contacts", contact);
        return summarizeContact(created);
      }),
  );
}
