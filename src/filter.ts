export type Operator = "eq" | "!eq" | "lt" | "lte" | "gt" | "gte" | "ct" | "!ct";

export interface Condition {
  field: string;
  op: Operator;
  value: string | number | boolean;
}

/**
 * Builds an iDoklad filter string, e.g. `(IsPaid~eq~false~and~PartnerId~eq~12)`.
 * Text values are base64-encoded so special characters (spaces, ~, diacritics) are safe.
 */
export function buildFilter(conditions: Condition[], join: "and" | "or" = "and"): string | undefined {
  if (!conditions.length) return undefined;
  const parts = conditions.map(({ field, op, value }) => {
    if (typeof value === "string" && (op === "eq" || op === "!eq" || op === "ct" || op === "!ct") && !/^[\w.,-]+$/.test(value)) {
      return `${field}~${op}:base64~${Buffer.from(value, "utf8").toString("base64")}`;
    }
    return `${field}~${op}~${value}`;
  });
  return `(${parts.join(`~${join}~`)})`;
}
