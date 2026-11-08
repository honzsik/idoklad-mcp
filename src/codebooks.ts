import type { IdokladClient, Page } from "./client.js";

interface Currency {
  Id: number;
  Code: string;
}

/** Lookups for iDoklad codebooks (číselníky), loaded once and kept for the session. */
export class Codebooks {
  private currencies?: Promise<Map<number, string>>;

  constructor(private readonly client: IdokladClient) {}

  /** Currency code (e.g. "CZK") for a currency ID, or undefined if unknown. */
  async currencyCode(id?: number): Promise<string | undefined> {
    if (id === undefined) return undefined;
    this.currencies ??= this.client
      .get<Page<Currency>>("Currencies", { pagesize: 200 })
      .then((page) => new Map(page.Items.map((c) => [c.Id, c.Code])))
      .catch((err) => {
        this.currencies = undefined; // retry next time
        throw err;
      });
    return (await this.currencies).get(id);
  }
}
