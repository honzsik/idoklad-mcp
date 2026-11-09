import { z } from "zod";
import { READ, type ToolContext } from "./context.js";
import { run } from "./util.js";

interface PeriodTotals {
  NumericPeriod: number;
  Period: string;
  TotalPaid: number;
  TotalUnpaid: number;
  TotalWithoutVat: number;
  TotalWithVat: number;
}

interface YearTotals {
  Paid: number;
  TotalWithVat: number;
  WithoutVat: number;
}

interface DebtInterval {
  Interval: number;
  IntervalDescription: string;
  TotalDebt: number;
}

interface Partner {
  Name: string;
  PartnerContactId: number;
  TotalWithVatHc: number;
}

const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 100) / 100);
const PERIOD_TYPE = { month: 1, quarter: 3, year: 12 } as const;
const DEFAULT_PERIODS = { month: 12, quarter: 4, year: 3 } as const;

const REPORTS = [
  "revenue_by_period",
  "year_comparison",
  "overdue_aging",
  "vat",
  "vat_registration_limit",
  "document_counts",
] as const;

export function registerStatsTools(ctx: ToolContext) {
  const { server, client } = ctx;

  server.registerTool(
    "get_business_stats",
    {
      title: "Get business statistics",
      description:
        "Business overview calculated by iDoklad. All amounts are in the company's home currency (usually CZK). Reports:\n" +
        "- revenue_by_period: issued (income) and received (costs) invoice totals per month, quarter or year, with paid/unpaid split.\n" +
        "- year_comparison: this year's totals against last year's.\n" +
        "- overdue_aging: overdue amounts by age (1–30, 31–60, 61–90, 90+ days), for receivables (customers owe you) and payables (you owe suppliers).\n" +
        "- vat: VAT on output and input for the current and previous VAT period (VAT payers).\n" +
        "- vat_registration_limit: this calendar year's sales against the CZ VAT registration limit (for companies not yet registered for VAT).\n" +
        "- document_counts: how many invoices, contacts and other documents the company has.",
      inputSchema: z.object({
        report: z.enum(REPORTS),
        period: z.enum(["month", "quarter", "year"]).default("month").describe("For revenue_by_period and vat (vat: month or quarter only)."),
        periods: z.number().int().min(1).max(36).optional().describe("For revenue_by_period: how many periods back, including the current one. Default 12 months, 4 quarters or 3 years."),
      }),
      annotations: READ,
    },
    (args) =>
      run(async () => {
        switch (args.report) {
          case "revenue_by_period": {
            const count = args.periods ?? DEFAULT_PERIODS[args.period];
            const data = await client.get<{ IssuedInvoices?: PeriodTotals[]; ReceivedInvoices?: PeriodTotals[] }>("Statistics/InvoicingForPeriod", {
              periodType: PERIOD_TYPE[args.period],
              PeriodsCount: count,
              IncludeIssuedInvoice: true,
              IncludeCreditNote: true,
              IncludeSalesReceipt: true,
              IncludeReceivedInvoice: true,
              IncludeReceivedReceipt: true,
            });
            const byPeriod = new Map<number, { period: string; income?: object; costs?: object }>();
            const totals = (p: PeriodTotals) => ({
              withVat: round(p.TotalWithVat),
              withoutVat: round(p.TotalWithoutVat),
              paid: round(p.TotalPaid),
              unpaid: round(p.TotalUnpaid),
            });
            // iDoklad labels months only "Dec"; NumericPeriod (202512) gives the year too.
            const label = (p: PeriodTotals) =>
              args.period === "month" && /^\d{6}$/.test(String(p.NumericPeriod))
                ? `${String(p.NumericPeriod).slice(0, 4)}-${String(p.NumericPeriod).slice(4)}`
                : p.Period;
            for (const p of data.IssuedInvoices ?? []) byPeriod.set(p.NumericPeriod, { period: label(p), income: totals(p) });
            for (const p of data.ReceivedInvoices ?? []) {
              const row = byPeriod.get(p.NumericPeriod) ?? { period: label(p) };
              byPeriod.set(p.NumericPeriod, { ...row, costs: totals(p) });
            }
            return { period: args.period, rows: [...byPeriod.entries()].sort(([a], [b]) => a - b).map(([, row]) => row) };
          }

          case "year_comparison": {
            const [thisYear, lastYear] = await Promise.all(
              [0, 1].map((yearType) => client.get<{ IssuedInvoices: YearTotals; ReceivedInvoices: YearTotals }>("Statistics/InvoicingForYear", { yearType })),
            );
            const view = (y: { IssuedInvoices: YearTotals; ReceivedInvoices: YearTotals }) => ({
              income: { withVat: round(y.IssuedInvoices.TotalWithVat), withoutVat: round(y.IssuedInvoices.WithoutVat), paid: round(y.IssuedInvoices.Paid) },
              costs: { withVat: round(y.ReceivedInvoices.TotalWithVat), withoutVat: round(y.ReceivedInvoices.WithoutVat), paid: round(y.ReceivedInvoices.Paid) },
            });
            return { thisYear: view(thisYear), lastYear: view(lastYear) };
          }

          case "overdue_aging": {
            const data = await client.get<{ Issue: DebtInterval[]; Entry: DebtInterval[] }>("Statistics/DebtIntervals");
            const view = (list: DebtInterval[]) => list.map((i) => ({ daysOverdue: i.IntervalDescription, amount: round(i.TotalDebt) }));
            const sum = (list: DebtInterval[]) => round(list.reduce((s, i) => s + i.TotalDebt, 0));
            return {
              receivables: { total: sum(data.Issue), byAge: view(data.Issue) },
              payables: { total: sum(data.Entry), byAge: view(data.Entry) },
            };
          }

          case "vat": {
            if (args.period === "year") throw new Error("VAT periods are month or quarter.");
            const data = await client.get<Record<string, number>>("Statistics/VatTotals", { vatPeriod: PERIOD_TYPE[args.period], isVatOnPay: false });
            const view = (suffix: "ThisPeriod" | "LastPeriod") => ({
              vatOnSales: round(data[`VatOut${suffix}`]),
              vatOnPurchases: round(data[`VatIn${suffix}`]),
              toPay: round(data[`Difference${suffix}`]),
            });
            return { period: args.period, currentPeriod: view("ThisPeriod"), previousPeriod: view("LastPeriod") };
          }

          case "vat_registration_limit": {
            const d = await client.get<{ DateFrom: string; DateTo: string; TotalSaleHc: number; VatPayerLimit: number; VatPayerLimitImmediately: number }>(
              "Statistics/VatPayerProgress",
            );
            return {
              from: d.DateFrom?.slice(0, 10),
              to: d.DateTo?.slice(0, 10),
              sales: round(d.TotalSaleHc),
              limit: d.VatPayerLimit,
              percentOfLimit: d.VatPayerLimit ? round((d.TotalSaleHc / d.VatPayerLimit) * 100) : undefined,
              remainingToLimit: round(d.VatPayerLimit - d.TotalSaleHc),
              immediateRegistrationLimit: d.VatPayerLimitImmediately,
            };
          }

          case "document_counts":
            return client.get<Record<string, number>>("Statistics/AgendaSummary");
        }
      }),
  );

  server.registerTool(
    "get_top_partners",
    {
      title: "Get top customers or debtors",
      description:
        "Biggest customers by total invoiced, or biggest debtors by unpaid amount (who owes you the most). Amounts in home currency.",
      inputSchema: z.object({
        kind: z.enum(["customers", "debtors"]),
        count: z.number().int().min(1).max(50).default(10),
      }),
      annotations: READ,
    },
    ({ kind, count }) =>
      run(async () => {
        const list = await client.get<Partner[]>(kind === "customers" ? "Statistics/TopPartners" : "Statistics/TopDebtors", { count });
        return list.map((p) => ({ contactId: p.PartnerContactId, name: p.Name, amount: round(p.TotalWithVatHc) }));
      }),
  );

  server.registerTool(
    "get_contact_stats",
    {
      title: "Get customer payment statistics",
      description: "How a customer pays: number of invoices, total invoiced, how many are paid, unpaid and were paid after the due date.",
      inputSchema: z.object({ contactId: z.number().int().describe("Contact ID (see list_contacts).") }),
      annotations: READ,
    },
    ({ contactId }) =>
      run(async () => {
        const s = await client.get<Record<string, number>>(`Statistics/StatisticForContact/${contactId}`);
        return {
          contactId,
          invoices: s.IssuedInvoiceCount,
          totalInvoiced: round(s.IssuedInvoiceTotalWithVat),
          paid: s.IssuedInvoicePaidCount,
          unpaid: s.IssuedInvoiceUnpaidCount,
          paidLateOrOverdue: s.IssuedInvoiceAfterMaturityCount,
        };
      }),
  );
}
