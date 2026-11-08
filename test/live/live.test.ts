// Read-only checks against a real iDoklad account. Runs only with `npm run test:live`
// and IDOKLAD_* variables set (from the environment or a local .env file).
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IdokladClient, type Page } from "../../src/client.js";
import { loadConfig } from "../../src/config.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const enabled = process.env.IDOKLAD_LIVE_TESTS === "1";

describe.skipIf(!enabled)("live iDoklad API (read-only)", () => {
  const client = () => new IdokladClient(loadConfig());

  it("logs in and lists issued invoices", async () => {
    const page = await client().get<Page<unknown>>("IssuedInvoices", { pagesize: 1 });
    expect(page).toHaveProperty("TotalItems");
  });

  it("returns the default invoice draft", async () => {
    const draft = await client().get<Record<string, unknown>>("IssuedInvoices/Default");
    expect(draft).toHaveProperty("Items");
  });
});
