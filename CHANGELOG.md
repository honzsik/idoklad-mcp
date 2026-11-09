# Changelog

## 0.4.0 (2026-11-09)

- `get_business_stats`: income and costs by month, quarter or year; this year against last year; overdue amounts by age; VAT for the period; progress toward the VAT registration limit; document counts.
- `get_top_partners`: biggest customers or biggest debtors. `get_contact_stats`: how a customer pays.
- `send_payment_reminder`: overdue payment reminders using the iDoklad reminder template.
- `send_payment_confirmation`: confirm to a customer that their payment arrived.
- Evals: 9 new cases (39 in total).

## 0.3.0 (2026-11-09)

- `create_proforma_invoice`: create proforma invoices, from defaults or copied from an earlier proforma.
- `create_invoice_from_proforma`: create the final invoice from a paid proforma (vyúčtování zálohy).
- `create_credit_note`: credit a whole invoice or selected items, optionally settled against the invoice.
- **Breaking:** `create_issued_invoice` input `copyFromInvoiceId` is renamed to `copyFromId`.
- One-click install for Claude Desktop: each GitHub release includes an `idoklad-mcp-<version>.mcpb` extension.
- Listed in the official MCP Registry as `io.github.honzsik/idoklad-mcp`.
- Upgraded to MCP TypeScript SDK v2 (`@modelcontextprotocol/server`). The server now speaks the 2026-07-28 protocol as well as the older 2025 versions, so new and existing clients both work.
- Much smaller install: two runtime dependencies instead of dozens, and the Claude Desktop extension shrank from 3.8 MB to 2.3 MB.
- Development: `npm run evals` checks that Claude picks the right tools for 30 Czech and English requests.

## 0.2.0 (2026-11-08)

- New document types: proforma invoices, credit notes and received invoices (list and detail).
- `get_document_pdf`: saves a document's PDF to your Downloads folder (`IDOKLAD_DOWNLOAD_DIR`).
- `create_issued_invoice`: choose the currency (the exchange rate is filled in automatically) and language, and copy settings from a previous invoice with `copyFromInvoiceId`. Items keep the template's VAT rate unless you set one.
- `mark_document_paid` and `mark_document_unpaid`.
- `send_document_email`: email invoices, proformas and credit notes through iDoklad.
- Contacts: `list_contacts`, `get_contact`, `create_contact`. Price list: `list_price_list_items`.
- `get_codebook` for currencies, countries, VAT rates, payment options, bank accounts and more.
- `search_api_docs` and `idoklad_api_request` for any other endpoint. Only GET is allowed in read-only mode.
- `list_issued_invoices` now returns `documents` instead of `invoices`, and `currency` codes instead of IDs.
- Node.js 22 or newer is required.

## 0.1.0 (2026-11-08, not published)

- First version.
- Tools: `list_issued_invoices`, `get_issued_invoice`, `create_issued_invoice`.
- Read-only by default; write tools are enabled with `IDOKLAD_READ_ONLY=false`.
- Automatic login and token renewal, and retries when iDoklad's rate limit is hit.
- Clear error messages for missing credentials, plans without API access and the wrong developer app flow.
