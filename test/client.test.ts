import { describe, expect, it } from "vitest";
import { IdokladClient, IdokladError } from "../src/client.js";
import { fakeFetch, ok, testConfig } from "./helpers.js";

const noSleep = async () => {};

describe("IdokladClient", () => {
  it("logs in once, sends the bearer token and unwraps Data", async () => {
    const f = fakeFetch(() => ok({ Id: 1 }));
    const client = new IdokladClient(testConfig, f.impl, noSleep);
    expect(await client.get("IssuedInvoices/1")).toEqual({ Id: 1 });
    await client.get("IssuedInvoices/1");
    expect(f.tokenRequests()).toBe(1);
    expect(f.calls[0].headers.Authorization).toBe("Bearer token-1");
    expect(f.calls[0].url.href).toBe("https://api.test/v3/IssuedInvoices/1");
  });

  it("drops empty query values", async () => {
    const f = fakeFetch(() => ok({}));
    await new IdokladClient(testConfig, f.impl, noSleep).get("Contacts", { filter: undefined, page: 2 });
    expect(f.calls[0].url.search).toBe("?page=2");
  });

  it("gets a new token after a 401", async () => {
    let n = 0;
    const f = fakeFetch(() => (n++ === 0 ? { status: 401 } : ok("done")));
    const client = new IdokladClient(testConfig, f.impl, noSleep);
    expect(await client.get("x")).toBe("done");
    expect(f.tokenRequests()).toBe(2);
    expect(f.calls[1].headers.Authorization).toBe("Bearer token-2");
  });

  it("retries on 429 using Retry-After", async () => {
    const waits: number[] = [];
    let n = 0;
    const f = fakeFetch(() => (n++ < 2 ? { status: 429, headers: { "retry-after": "3" } } : ok("done")));
    const client = new IdokladClient(testConfig, f.impl, async (ms) => void waits.push(ms));
    expect(await client.get("x")).toBe("done");
    expect(waits).toEqual([3000, 3000]);
  });

  it("explains plan errors", async () => {
    const f = fakeFetch(() => ({ status: 402, json: { IsSuccess: false, Message: "Payment required", ErrorCode: 126 } }));
    const err = (await new IdokladClient(testConfig, f.impl, noSleep).get("x").catch((e) => e)) as IdokladError;
    expect(err).toBeInstanceOf(IdokladError);
    expect(err.status).toBe(402);
    expect(err.errorCode).toBe(126);
    expect(err.message).toMatch(/Oblíbený or Prémiový/);
  });

  it("treats IsSuccess=false as an error even with HTTP 200", async () => {
    const f = fakeFetch(() => ({ json: { IsSuccess: false, Message: "Invalid partner", ErrorCode: 5 } }));
    await expect(new IdokladClient(testConfig, f.impl, noSleep).get("x")).rejects.toThrow(/Invalid partner/);
  });

  it("points to the ClientCredentials flow when the application ID is rejected", async () => {
    const impl: typeof fetch = async () => new Response("Invalid parameter application_id.", { status: 400 });
    await expect(new IdokladClient(testConfig, impl, noSleep).get("x")).rejects.toThrow(/ClientCredentials/);
  });

  it("reports login failures clearly", async () => {
    const impl: typeof fetch = async () => new Response("invalid_client", { status: 400 });
    await expect(new IdokladClient(testConfig, impl, noSleep).get("x")).rejects.toThrow(/login failed/);
  });
});
