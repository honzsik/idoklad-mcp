// Builds src/data/api-index.json, a compact searchable index of the iDoklad API v3,
// from the official apiDoc data. Run with: npm run build:api-index
import { writeFile } from "node:fs/promises";

const SOURCE = "https://api.idoklad.cz/Help/v3/en/api_data.json";

interface ApiDocField {
  field: string;
  type?: string;
  optional?: boolean;
  description?: string;
}
interface ApiDocEntry {
  type: string;
  url: string;
  title: string;
  group: string;
  description?: string;
  parameter?: { fields?: Record<string, ApiDocField[]> };
}

const clean = (s = "") => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const entries = (await res.json()) as ApiDocEntry[];

const index = entries
  .filter((e) => e.url.includes("api.idoklad.cz/v3/"))
  .map((e) => {
    const fields = e.parameter?.fields ?? {};
    const pick = (group: RegExp, maxDepth: number) =>
      Object.entries(fields)
        .filter(([name]) => group.test(name))
        .flatMap(([, list]) => list)
        .filter((f) => f.field.split(".").length <= maxDepth)
        .map((f) => `${f.field}${f.optional === false ? "*" : ""}: ${clean(f.description).slice(0, 160)}`);
    return {
      method: e.type.toUpperCase(),
      path: e.url.replace(/^.*\/v3\//, ""),
      title: clean(e.title),
      group: e.group,
      description: clean(e.description).slice(0, 300),
      query: pick(/^(URI|Query)/i, 1),
      body: e.type.toLowerCase() === "get" ? [] : pick(/^Request/i, 2),
    };
  });

await writeFile(new URL("../src/data/api-index.json", import.meta.url), JSON.stringify(index));
console.log(`Wrote ${index.length} endpoints.`);
