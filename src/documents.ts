import type { Condition } from "./filter.js";

/** iDoklad document types that share list, detail, PDF and payment behaviour. */
export interface DocType {
  /** API path, e.g. "IssuedInvoices". */
  path: string;
  /** Name used in Reports/{report}/{id}/Pdf and Mails/{report}/Send. */
  report: string;
  /** Human label for tool descriptions. */
  label: string;
  /** Filter column holding the partner (customer or supplier) ID. */
  partnerField: "PartnerId" | "SupplierId";
  /** Payments endpoint group, if the document can be marked paid. */
  payments?: "IssuedDocumentPayments" | "ReceivedDocumentPayments";
  /** Whether iDoklad can email this document. */
  canEmail: boolean;
  /** Whether the list supports the IsPaid filter column (received invoices only have PaymentStatus). */
  hasIsPaid: boolean;
}

export const DOC_TYPES = {
  issued_invoice: {
    path: "IssuedInvoices",
    report: "IssuedInvoice",
    label: "issued invoice (vydaná faktura)",
    partnerField: "PartnerId",
    payments: "IssuedDocumentPayments",
    canEmail: true,
    hasIsPaid: true,
  },
  proforma_invoice: {
    path: "ProformaInvoices",
    report: "ProformaInvoice",
    label: "proforma invoice (zálohová faktura)",
    partnerField: "PartnerId",
    payments: "IssuedDocumentPayments",
    canEmail: true,
    hasIsPaid: true,
  },
  credit_note: {
    path: "CreditNotes",
    report: "CreditNote",
    label: "credit note (opravný daňový doklad / dobropis)",
    partnerField: "PartnerId",
    canEmail: true,
    hasIsPaid: true,
  },
  received_invoice: {
    path: "ReceivedInvoices",
    report: "ReceivedInvoice",
    label: "received invoice (přijatá faktura)",
    partnerField: "SupplierId",
    payments: "ReceivedDocumentPayments",
    canEmail: false,
    hasIsPaid: false,
  },
} as const satisfies Record<string, DocType>;

export type DocTypeKey = keyof typeof DOC_TYPES;
export const DOC_TYPE_KEYS = Object.keys(DOC_TYPES) as [DocTypeKey, ...DocTypeKey[]];

export type PaymentFilter = "unpaid" | "paid" | "partially_paid" | "overdue";

/** Filter conditions for a payment status, using the columns this document type supports. */
export function paymentConditions(doc: DocType, status: PaymentFilter, today: string): Condition[] {
  const unpaid: Condition = doc.hasIsPaid
    ? { field: "IsPaid", op: "eq", value: false }
    : { field: "PaymentStatus", op: "!eq", value: "Paid" };
  switch (status) {
    case "paid":
      return [doc.hasIsPaid ? { field: "IsPaid", op: "eq", value: true } : { field: "PaymentStatus", op: "eq", value: "Paid" }];
    case "unpaid":
      return [unpaid];
    case "partially_paid":
      return [{ field: "PaymentStatus", op: "eq", value: "PartialPaid" }];
    case "overdue":
      return [unpaid, { field: "DateOfMaturity", op: "lt", value: today }];
  }
}

// Subset of the document model shared by all types.
export interface Document {
  Id: number;
  DocumentNumber?: string;
  ReceivedDocumentNumber?: string;
  DateOfIssue?: string;
  DateOfMaturity?: string;
  Description?: string;
  VariableSymbol?: string;
  CurrencyId?: number;
  PartnerId?: number;
  PartnerAddress?: { NickName?: string; CompanyName?: string; Firstname?: string; Surname?: string };
  PaymentStatus?: number;
  Prices?: { TotalWithVat?: number; TotalWithoutVat?: number; TotalPaid?: number };
  [key: string]: unknown;
}

const PAYMENT_STATUS = ["unpaid", "paid", "partially_paid", "overpaid"] as const;

/** Compact view of a document for lists and confirmations. */
export function summarizeDocument(doc: Document, currency?: string) {
  const partner = doc.PartnerAddress;
  return {
    id: doc.Id,
    number: doc.DocumentNumber,
    supplierNumber: doc.ReceivedDocumentNumber || undefined,
    partner:
      partner?.NickName || partner?.CompanyName || [partner?.Firstname, partner?.Surname].filter(Boolean).join(" ") || undefined,
    partnerId: doc.PartnerId,
    description: doc.Description || undefined,
    issued: doc.DateOfIssue?.slice(0, 10),
    due: doc.DateOfMaturity?.slice(0, 10),
    paymentStatus: doc.PaymentStatus !== undefined ? PAYMENT_STATUS[doc.PaymentStatus] : undefined,
    totalWithVat: doc.Prices?.TotalWithVat,
    totalWithoutVat: doc.Prices?.TotalWithoutVat,
    totalPaid: doc.Prices?.TotalPaid,
    currency: currency ?? (doc.CurrencyId !== undefined ? `currencyId ${doc.CurrencyId}` : undefined),
    variableSymbol: doc.VariableSymbol || undefined,
  };
}

export const REPORT_LANGUAGE = { cs: 1, sk: 2, en: 3, de: 4 } as const;
