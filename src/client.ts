import type { Config } from "./config.js";

export type Fetch = typeof fetch;

/** Error returned by the iDoklad API, with its HTTP status and iDoklad error code. */
export class IdokladError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: number,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
}

interface ApiResult<T> {
  Data: T;
  IsSuccess: boolean;
  Message?: string;
  StatusCode?: number;
  ErrorCode?: number;
}

export interface Page<T> {
  Items: T[];
  TotalItems: number;
  TotalPages: number;
}

const MAX_RETRIES = 3;

export class IdokladClient {
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: Fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get<T>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query });
  }
  post<T>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("POST", path, { body, query });
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, { body });
  }
  put<T>(path: string, body?: unknown, query?: Query) {
    return this.request<T>("PUT", path, { body, query });
  }
  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    let refreshedToken = false;

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.getToken()}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });

      // Token expired or revoked: get a new one and try once more.
      if (res.status === 401 && !refreshedToken) {
        this.token = undefined;
        refreshedToken = true;
        continue;
      }

      // Rate limit (200 requests/minute) or temporary server trouble: back off and retry.
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }

      return this.unwrap<T>(res);
    }
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(this.config.apiUrl.replace(/\/$/, "") + "/" + path.replace(/^\//, ""));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async unwrap<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: Partial<ApiResult<T>> | undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON (e.g. an HTML error page); handled below.
    }

    if (!res.ok || json?.IsSuccess === false) {
      throw new IdokladError(describeError(res.status, json?.Message || text.slice(0, 300)), res.status, json?.ErrorCode);
    }
    if (json && "Data" in json) return json.Data as T;
    return json as T;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const res = await this.fetchImpl(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        application_id: this.config.applicationId,
        scope: "idoklad_api",
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      const hint = /application_id/i.test(text)
        ? "IDOKLAD_APPLICATION_ID was rejected. Use the Client Id of an app with the ClientCredentials flow from developer.idoklad.cz."
        : "Check IDOKLAD_CLIENT_ID, IDOKLAD_CLIENT_SECRET and IDOKLAD_APPLICATION_ID.";
      throw new IdokladError(`iDoklad login failed (HTTP ${res.status}). ${hint} ${text.slice(0, 300)}`, res.status);
    }
    const data = JSON.parse(text) as { access_token: string; expires_in?: number };
    // Renew a minute early so a token never expires mid-request.
    const lifetimeMs = Math.max((data.expires_in ?? 3600) - 60, 30) * 1000;
    this.token = { value: data.access_token, expiresAt: Date.now() + lifetimeMs };
    return this.token.value;
  }
}

function describeError(status: number, message: string): string {
  const hints: Record<number, string> = {
    402: "Your iDoklad plan does not include API access (Oblíbený or Prémiový plan required), or the subscription expired.",
    403: "Access denied for this operation.",
    404: "Not found.",
    429: "iDoklad rate limit reached (200 requests/minute or the monthly quota). Try again later.",
  };
  return [`iDoklad API error (HTTP ${status})`, hints[status], message].filter(Boolean).join(": ");
}
