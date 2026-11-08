import type { Fetch } from "../src/client.js";
import type { Config } from "../src/config.js";

export const testConfig: Config = {
  clientId: "cid",
  clientSecret: "secret",
  applicationId: "app",
  readOnly: true,
  apiUrl: "https://api.test/v3",
  tokenUrl: "https://identity.test/token",
  downloadDir: "/tmp/idoklad-mcp-test",
};

export interface Call {
  method: string;
  url: URL;
  body?: unknown;
  headers: Record<string, string>;
}

type Handler = (call: Call) => { status?: number; json?: unknown; headers?: Record<string, string> };

/** Fake fetch: answers token requests automatically and routes API calls to `handler`. */
export function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  let tokenRequests = 0;
  const impl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.href === testConfig.tokenUrl) {
      tokenRequests++;
      return Response.json({ access_token: `token-${tokenRequests}`, expires_in: 6000 });
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method: init?.method ?? "GET", url, body, headers };
    calls.push(call);
    const res = handler(call);
    return new Response(res.json === undefined ? "" : JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: res.headers,
    });
  };
  return { impl, calls, tokenRequests: () => tokenRequests };
}

export const ok = (data: unknown) => ({ json: { Data: data, IsSuccess: true, StatusCode: 200, ErrorCode: 0 } });
