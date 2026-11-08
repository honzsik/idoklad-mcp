# idoklad-mcp

[![CI](https://github.com/honzsik/idoklad-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/honzsik/idoklad-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An **unofficial** [MCP](https://modelcontextprotocol.io) server for [iDoklad](https://www.idoklad.cz), the Czech and Slovak online invoicing service.
It lets Claude, Codex, Cursor and other AI assistants read and create invoices in your iDoklad account.

> [!NOTE]
> This project is not affiliated with or endorsed by iDoklad or Seyfor, a. s.
> 🇨🇿 [Návod v češtině](#česky)

> [!WARNING]
> **Early development (v0.1).** So far it only covers issued invoices. See the [roadmap](#roadmap).

## What you can ask

- *"Which invoices are overdue?"*
- *"How much has ACME paid us this year?"*
- *"Show me the last invoice for Globex."*
- *"Create an invoice for ACME s.r.o.: 10 hours of consulting at 1,500 CZK, due in 14 days."* (needs [write mode](#read-only-by-default))

## Requirements

- An iDoklad plan **that includes API access**: Oblíbený (Popular) or Prémiový (Premium). The Free and Basic plans have no API.
- [Node.js](https://nodejs.org) 22 or newer.
- An MCP client: Claude Desktop, Claude Code, Codex, Cursor, VS Code or similar.

## Setup

### 1. Get your credentials

You need three values. They take about five minutes to get.

**Client ID and Client Secret**, from iDoklad:

1. Sign in to [app.idoklad.cz](https://app.idoklad.cz).
2. Go to **Nastavení (Settings) → API**.
3. Copy the **Client ID** and **Client Secret**.

These belong to one company (agenda) and one user.

**Application ID**, from the iDoklad developer portal:

1. Create an account at [developer.idoklad.cz](https://developer.idoklad.cz).
2. Under **Nová aplikace**, enter any name and set **Flow** to **ClientCredentials**. Then click Uložit.
3. Copy the new app's **Client Id** from the list. That value is your Application ID.

> [!IMPORTANT]
> The app **must use the ClientCredentials flow**. With an AuthorizationCode app, iDoklad rejects the login with `Invalid parameter application_id`.

### 2. Add the server to your AI client

Replace the `...` placeholders with your three values.

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add idoklad \
  -e IDOKLAD_CLIENT_ID=... \
  -e IDOKLAD_CLIENT_SECRET=... \
  -e IDOKLAD_APPLICATION_ID=... \
  -- npx -y idoklad-mcp
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

Open **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "idoklad": {
      "command": "npx",
      "args": ["-y", "idoklad-mcp"],
      "env": {
        "IDOKLAD_CLIENT_ID": "...",
        "IDOKLAD_CLIENT_SECRET": "...",
        "IDOKLAD_APPLICATION_ID": "..."
      }
    }
  }
}
```

Restart Claude Desktop afterwards.

</details>

<details>
<summary><b>Codex</b></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.idoklad]
command = "npx"
args = ["-y", "idoklad-mcp"]

[mcp_servers.idoklad.env]
IDOKLAD_CLIENT_ID = "..."
IDOKLAD_CLIENT_SECRET = "..."
IDOKLAD_APPLICATION_ID = "..."
```

</details>

<details>
<summary><b>Cursor, VS Code and other clients</b></summary>

Use the same `command`, `args` and `env` values as in the Claude Desktop example, in your client's MCP settings.

</details>

### 3. Try it

Ask your assistant *"Which of my iDoklad invoices are unpaid?"*

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `IDOKLAD_CLIENT_ID` | yes | | From iDoklad → Settings → API |
| `IDOKLAD_CLIENT_SECRET` | yes | | From iDoklad → Settings → API |
| `IDOKLAD_APPLICATION_ID` | yes | | The Client Id of your ClientCredentials app on developer.idoklad.cz |
| `IDOKLAD_READ_ONLY` | no | `true` | Set to `false` to enable tools that create or change data |

To use **several companies**, add the server once per company under different names (for example `idoklad-firma-a` and `idoklad-firma-b`), each with that company's credentials.

## Read-only by default

Out of the box, the server can only **read** your data. To let the assistant create or change documents, set:

```
IDOKLAD_READ_ONLY=false
```

Write tools are marked as such, so clients can ask you to confirm before running them.

## Tools

| Tool | Mode | What it does |
| --- | --- | --- |
| `list_issued_invoices` | read | List issued invoices, newest first. You can filter by unpaid, paid, partly paid or overdue, by customer, by issue date and by invoice number. |
| `get_issued_invoice` | read | Get the full detail of one invoice: items, customer and totals. |
| `create_issued_invoice` | write | Create an invoice from your company's default settings (numbering, bank account, VAT), identifying the customer by name or ID. |

## Privacy and security

- The server runs **on your computer**. Your credentials stay in your local client configuration and are only sent to iDoklad.
- Data the assistant reads from iDoklad, such as invoices and contacts, is passed to the AI model you use, just like anything else you share in the chat.
- Treat your Client Secret like a password. Never commit it or paste it into a chat. To revoke it, delete it in iDoklad → Settings → API.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Missing environment variables: …` | One of the three credentials is not set in your client configuration. |
| `Invalid parameter application_id` | Your developer portal app doesn't use the **ClientCredentials** flow, or you copied the wrong value. Use the app's Client Id. |
| `iDoklad login failed (HTTP 400)` | Check the Client ID and Secret in iDoklad → Settings → API. They may have been regenerated. |
| `HTTP 402` | Your iDoklad plan doesn't include the API, or your subscription has expired. |
| `HTTP 429` | You've hit iDoklad's rate limit: 200 requests per minute, and a monthly quota that depends on your plan. The server retries on its own; wait and try again. |

## Roadmap

- [x] Issued invoices: list, detail, create
- [ ] Choose the currency for new invoices (USD, EUR and others)
- [ ] Proforma invoices, credit notes, received invoices
- [ ] Contacts and price list items
- [ ] Payments (mark as paid)
- [ ] PDF download and sending invoices by email
- [ ] Generic tools: call any iDoklad endpoint, search the API docs
- [ ] One-click install for Claude Desktop, and a listing in the MCP Registry
- [ ] Hosted version with iDoklad login (OAuth) for claude.ai and ChatGPT

Ideas and requests are welcome in [issues](https://github.com/honzsik/idoklad-mcp/issues).

## Development

```bash
git clone https://github.com/honzsik/idoklad-mcp.git
cd idoklad-mcp
npm install
cp .env.example .env   # add your credentials
```

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests against a fake API, with no network calls |
| `npm run test:live` | Read-only checks against your real iDoklad account (uses `.env`) |
| `npm run smoke` | Calls the read tools through a real MCP connection |
| `npm run inspect` | Opens the tools in [MCP Inspector](https://github.com/modelcontextprotocol/inspector) |
| `npm run build` | Compiles to `dist/` |

If you open this folder in Claude Code, it picks up [`.mcp.json`](.mcp.json) and runs the server from source as `idoklad-dev`.

> [!TIP]
> For anything that writes data, use a separate test company in iDoklad, so test invoices don't use up your real invoice numbers.

The code is in `src/`:

- `client.ts`: the iDoklad API client. It handles login, token renewal and retries.
- `filter.ts`: the iDoklad filter syntax.
- `tools/`: the MCP tools.

Pull requests are welcome. Please run `npm run typecheck && npm test` before opening one.

## License

[MIT](LICENSE) © Jan Vítek

---

## Česky

**idoklad-mcp** je neoficiální MCP server pro [iDoklad](https://www.idoklad.cz). Umožní AI asistentům (Claude, Codex, Cursor a dalším) číst a vystavovat faktury ve vašem iDokladu. Projekt není spojen se společností Seyfor, a. s.

### Co budete potřebovat

- Tarif iDokladu **s přístupem k API**: Oblíbený nebo Prémiový. Tarify Zdarma a Základní API nemají.
- Node.js ve verzi 22 nebo novější.

### Postup

1. V iDokladu otevřete **Nastavení → API** a zkopírujte **Client ID** a **Client Secret**.
2. Na [developer.idoklad.cz](https://developer.idoklad.cz) si založte účet a vytvořte novou aplikaci s **Flow: ClientCredentials**. Její **Client Id** použijete jako `IDOKLAD_APPLICATION_ID`.
3. Server přidejte do svého AI klienta podle [návodu výše](#2-add-the-server-to-your-ai-client).
4. Zeptejte se asistenta: *„Které faktury v iDokladu jsou po splatnosti?"*

Ve výchozím stavu server data **jen čte**. Vystavování faktur zapnete proměnnou `IDOKLAD_READ_ONLY=false`.

Pokud iDoklad hlásí `Invalid parameter application_id`, vytvořili jste aplikaci s jiným flow než ClientCredentials.
