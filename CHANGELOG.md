# Changelog

## 0.1.0 (unreleased)

- First version.
- Tools: `list_issued_invoices`, `get_issued_invoice`, `create_issued_invoice`.
- Read-only by default; write tools are enabled with `IDOKLAD_READ_ONLY=false`.
- Automatic login and token renewal, and retries when iDoklad's rate limit is hit.
- Clear error messages for missing credentials, plans without API access and the wrong developer app flow.
