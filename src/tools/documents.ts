import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Page } from "../client.js";
import {
  DOC_TYPE_KEYS,
  DOC_TYPES,
  paymentConditions,
  REPORT_LANGUAGE,
  summarizeDocument,
  type DocTypeKey,
  type Document,
} from "../documents.js";
import { buildFilter, type Condition } from "../filter.js";
import { READ, WRITE, type ToolContext } from "./context.js";
import { run, todayIso } from "./util.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const TOOL_NAMES: Record<DocTypeKey, { list: string; get: string }> = {
  issued_invoice: { list: "list_issued_invoices", get: "get_issued_invoice" },
  proforma_invoice: { list: "list_proforma_invoices", get: "get_proforma_invoice" },
  credit_note: { list: "list_credit_notes", get: "get_credit_note" },
  received_invoice: { list: "list_received_invoices", get: "get_received_invoice" },
};

export function registerDocumentTools(ctx: ToolContext) {
  const { server, client, codebooks } = ctx;
  const summarize = async (doc: Document) => summarizeDocument(doc, await codebooks.currencyCode(doc.CurrencyId));

  for (const key of DOC_TYPE_KEYS) {
    const doc = DOC_TYPES[key];
    const names = TOOL_NAMES[key];
    const partnerWord = doc.partnerField === "SupplierId" ? "supplier" : "customer";

    server.registerTool(
      names.list,
      {
        title: `List ${doc.label.split(" (")[0]}s`,
        description:
          `List ${doc.label} documents, newest first. Filter by payment status, overdue, ${partnerWord}, issue date range or document number. ` +
          `Returns a compact summary per document; use ${names.get} for full detail.`,
        inputSchema: {
          status: z.enum(["unpaid", "paid", "partially_paid", "overdue"]).optional().describe("Payment status. 'overdue' = unpaid and past due date."),
          partnerId: z.number().int().optional().describe(`Contact ID of the ${partnerWord} (see list_contacts).`),
          issuedFrom: date.optional().describe("Issue date from (inclusive)."),
          issuedTo: date.optional().describe("Issue date to (inclusive)."),
          documentNumber: z.string().optional().describe("Part of the document number."),
          page: z.number().int().min(1).default(1),
          pageSize: z.number().int().min(1).max(200).default(20),
        },
        annotations: READ,
      },
      (args) =>
        run(async () => {
          const conditions: Condition[] = [];
          if (args.status) conditions.push(...paymentConditions(doc, args.status, todayIso()));
          if (args.partnerId) conditions.push({ field: doc.partnerField, op: "eq", value: args.partnerId });
          if (args.issuedFrom) conditions.push({ field: "DateOfIssue", op: "gte", value: args.issuedFrom });
          if (args.issuedTo) conditions.push({ field: "DateOfIssue", op: "lte", value: args.issuedTo });
          if (args.documentNumber) conditions.push({ field: "DocumentNumber", op: "ct", value: args.documentNumber });

          const page = await client.get<Page<Document>>(doc.path, {
            filter: buildFilter(conditions),
            sort: "DateOfIssue~desc",
            page: args.page,
            pagesize: args.pageSize,
          });
          return {
            totalItems: page.TotalItems,
            totalPages: page.TotalPages,
            page: args.page,
            documents: await Promise.all(page.Items.map(summarize)),
          };
        }),
    );

    server.registerTool(
      names.get,
      {
        title: `Get ${doc.label.split(" (")[0]}`,
        description: `Get full detail of one ${doc.label} by ID, including items, partner and prices.`,
        inputSchema: { id: z.number().int().describe("Document ID (not the document number).") },
        annotations: READ,
      },
      ({ id }) => run(() => client.get<Document>(`${doc.path}/${id}`)),
    );
  }

  server.registerTool(
    "get_document_pdf",
    {
      title: "Download document PDF",
      description:
        "Download the PDF of an invoice, proforma, credit note or received invoice and save it to a local folder. Returns the file path.",
      inputSchema: {
        documentType: z.enum(DOC_TYPE_KEYS),
        id: z.number().int().describe("Document ID."),
        language: z.enum(["cs", "sk", "en", "de"]).optional().describe("PDF language. Default: the document's own language."),
        withPayments: z.boolean().default(false).describe("Include the payment summary (not for received invoices)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const doc = DOC_TYPES[args.documentType];
        const variant = args.withPayments && args.documentType !== "received_invoice" ? "PdfWithPayments" : "Pdf";
        const [base64, detail] = await Promise.all([
          client.get<string>(`Reports/${doc.report}/${args.id}/${variant}`, {
            language: args.language ? REPORT_LANGUAGE[args.language] : undefined,
          }),
          client.get<Document>(`${doc.path}/${args.id}`),
        ]);
        const pdf = Buffer.from(base64, "base64");
        const name = `${args.documentType.replace("_", "-")}-${safeName(detail.DocumentNumber || String(args.id))}.pdf`;
        await mkdir(ctx.downloadDir, { recursive: true });
        const path = join(ctx.downloadDir, name);
        await writeFile(path, pdf);
        return { path, sizeKb: Math.round(pdf.length / 1024) };
      }),
  );

  if (ctx.readOnly) return;

  server.registerTool(
    "send_document_email",
    {
      title: "Email document",
      description:
        "Email an issued invoice, proforma or credit note through iDoklad, using the email template from iDoklad settings. " +
        "This sends a real email; always confirm the recipients with the user first.",
      inputSchema: {
        documentType: z.enum(["issued_invoice", "proforma_invoice", "credit_note"]),
        id: z.number().int().describe("Document ID."),
        sendToPartner: z.boolean().default(true).describe("Send to the email on the customer's contact."),
        otherRecipients: z.array(z.string().email()).max(5).optional().describe("Extra recipients."),
        sendToSelf: z.boolean().default(false).describe("Send a copy to your company email."),
        sendToAccountant: z.boolean().default(false).describe("Send to the accountant set in iDoklad settings."),
        subject: z.string().optional().describe("Custom subject. Default: iDoklad template."),
        body: z.string().optional().describe("Custom body. Default: iDoklad template."),
        language: z.enum(["cs", "sk", "en", "de"]).optional(),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    (args) =>
      run(async () => {
        const doc = DOC_TYPES[args.documentType];
        const result = await client.post<{ Sent?: string[]; NotSent?: string[] }>(`Mails/${doc.report}/Send`, {
          DocumentId: args.id,
          SendToPartner: args.sendToPartner,
          SendToSelf: args.sendToSelf,
          SendToAccountant: args.sendToAccountant,
          OtherRecipients: args.otherRecipients,
          EmailSubject: args.subject,
          EmailBody: args.body,
          ReportLanguage: args.language ? REPORT_LANGUAGE[args.language] : undefined,
        });
        return { sent: result.Sent ?? [], notSent: result.NotSent ?? [] };
      }),
  );

  const payable = DOC_TYPE_KEYS.filter((k) => "payments" in DOC_TYPES[k]) as [DocTypeKey, ...DocTypeKey[]];

  server.registerTool(
    "mark_document_paid",
    {
      title: "Mark document as paid",
      description: "Record full payment of an issued invoice, proforma or received invoice (uhrazeno) on a given date.",
      inputSchema: {
        documentType: z.enum(payable),
        id: z.number().int().describe("Document ID."),
        dateOfPayment: date.optional().describe("Default: today."),
      },
      annotations: WRITE,
    },
    (args) =>
      run(async () => {
        const doc = DOC_TYPES[args.documentType] as { payments: string };
        await client.put(`${doc.payments}/FullyPay/${args.id}`, undefined, { dateOfPayment: args.dateOfPayment ?? todayIso() });
        return { id: args.id, paid: true, dateOfPayment: args.dateOfPayment ?? todayIso() };
      }),
  );

  server.registerTool(
    "mark_document_unpaid",
    {
      title: "Mark document as unpaid",
      description: "Remove all payments from an issued invoice, proforma or received invoice, so it is unpaid again.",
      inputSchema: { documentType: z.enum(payable), id: z.number().int().describe("Document ID.") },
      annotations: { ...WRITE, destructiveHint: true },
    },
    (args) =>
      run(async () => {
        const doc = DOC_TYPES[args.documentType] as { payments: string };
        await client.put(`${doc.payments}/FullyUnpay/${args.id}`);
        return { id: args.id, paid: false };
      }),
  );
}

function safeName(s: string): string {
  return s.replace(/[^\w.-]+/g, "_");
}
