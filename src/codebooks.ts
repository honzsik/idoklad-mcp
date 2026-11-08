import type { IdokladClient, Page } from "./client.js";
import { buildFilter } from "./filter.js";

interface Currency {
  Id: number;
  Code: string;
}

interface Country {
  Id: number;
  Code: string;
}

interface ExchangeRate {
  Amount: number;
  CurrencyId: number;
  Date: string;
  ExchangeListId: number;
  ExchangeRateValue: number;
}

// iDoklad exchange lists: 1 = rates against CZK (ČNB), 2 = rates against EUR (ECB).
const EXCHANGE_LIST_BY_HOME_CURRENCY: Record<string, number> = { CZK: 1, EUR: 2 };

/** Lookups for iDoklad codebooks (číselníky), loaded once and kept for the session. */
export class Codebooks {
  private currencies?: Promise<Currency[]>;
  private countries?: Promise<Country[]>;

  constructor(private readonly client: IdokladClient) {}

  /** Currency code (e.g. "CZK") for a currency ID, or undefined if unknown. */
  async currencyCode(id?: number): Promise<string | undefined> {
    if (id === undefined) return undefined;
    return (await this.loadCurrencies()).find((c) => c.Id === id)?.Code;
  }

  /** Currency ID for a code such as "USD". Throws if the code is unknown. */
  async currencyId(code: string): Promise<number> {
    const list = await this.loadCurrencies();
    const found = list.find((c) => c.Code.toUpperCase() === code.trim().toUpperCase());
    if (!found) throw new Error(`Unknown currency "${code}". Known: ${list.map((c) => c.Code).join(", ")}`);
    return found.Id;
  }

  /** Country ID for an ISO code such as "CZ". Throws if the code is unknown. */
  async countryId(code: string): Promise<number> {
    this.countries ??= this.cached(this.client.get<Page<Country>>("Countries", { pagesize: 200 }).then((p) => p.Items), () => {
      this.countries = undefined;
    });
    const found = (await this.countries).find((c) => c.Code.toUpperCase() === code.trim().toUpperCase());
    if (!found) throw new Error(`Unknown country code "${code}". Use a two-letter ISO code such as CZ, SK, DE, US.`);
    return found.Id;
  }

  /**
   * Latest exchange rate on or before `date` for converting `currencyId` into the home currency.
   * Returns iDoklad's pair: `amount` units of the currency = `rate` units of home currency.
   */
  async exchangeRate(currencyId: number, homeCurrencyId: number, date: string): Promise<{ rate: number; amount: number }> {
    if (currencyId === homeCurrencyId) return { rate: 1, amount: 1 };
    const homeCode = await this.currencyCode(homeCurrencyId);
    const listId = EXCHANGE_LIST_BY_HOME_CURRENCY[homeCode ?? ""];
    if (!listId) throw new Error(`No exchange rate list for home currency ${homeCode ?? homeCurrencyId}.`);

    const page = await this.client.get<Page<ExchangeRate>>("ExchangeRates", {
      filter: buildFilter([
        { field: "CurrencyId", op: "eq", value: currencyId },
        { field: "ExchangeListId", op: "eq", value: listId },
        { field: "Date", op: "lte", value: date },
      ]),
      sort: "Id~desc",
      pagesize: 1,
    });
    const found = page.Items[0];
    if (!found) throw new Error(`No exchange rate found for currency ${await this.currencyCode(currencyId)} on ${date}.`);
    return { rate: found.ExchangeRateValue, amount: found.Amount };
  }

  private loadCurrencies() {
    this.currencies ??= this.cached(this.client.get<Page<Currency>>("Currencies", { pagesize: 200 }).then((p) => p.Items), () => {
      this.currencies = undefined;
    });
    return this.currencies;
  }

  // Forget a failed load so the next call tries again.
  private cached<T>(promise: Promise<T>, reset: () => void): Promise<T> {
    return promise.catch((err) => {
      reset();
      throw err;
    });
  }
}
