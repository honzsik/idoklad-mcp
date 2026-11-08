// Tool-choice evals: does Claude pick the right iDoklad tools, with the right inputs, for real requests?
// Runs every case in evals/cases.ts against Claude, with our MCP server wired to a fake iDoklad.
//
//   npm run evals                      all cases
//   npm run evals -- --only overdue-cs,mark-paid-cs
//   npm run evals -- --repeat 3        run each case 3 times (models are not deterministic)
//   EVAL_MODEL=claude-sonnet-5-5 npm run evals
//
// Needs ANTHROPIC_API_KEY (environment or .env). Costs real money: see the cost line at the end.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { IdokladClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { CASES, WRITE_TOOLS, type EvalCase, type ExpectedCall, type Matcher } from "./cases.js";
import { fakeIdoklad } from "./fake-idoklad.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const { values: opts } = parseArgs({
  options: {
    only: { type: "string" },
    repeat: { type: "string", default: "1" },
    concurrency: { type: "string", default: "4" },
    verbose: { type: "boolean", default: false },
  },
});

const MODEL = process.env.EVAL_MODEL ?? "claude-opus-5-5";
const TODAY = "2026-11-09"; // fixed so "this year" and "overdue" mean the same thing on every run
const MAX_REQUESTS = 8; // per case

// $ per million tokens: input, output, cache read. Cache writes cost 1.25x input.
const PRICES: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
};

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface CaseResult {
  id: string;
  run: number;
  pass: boolean;
  reason: string;
  calls: ToolCall[];
  finalText: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// ── MCP server on a fake iDoklad ─────────────────────────────────────────────
const fake = fakeIdoklad();
const server = createServer(new IdokladClient(fake.config, fake.impl, async () => {}), { readOnly: false, downloadDir: tmpdir() });
const mcp = new Client({ name: "evals", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(a), mcp.connect(b)]);

const tools: Anthropic.Tool[] = (await mcp.listTools()).tools.map((t) => {
  const { $schema: _, ...schema } = t.inputSchema as Record<string, unknown>;
  return { name: t.name, description: t.description ?? "", input_schema: schema as Anthropic.Tool.InputSchema };
});
// Clients like Claude Desktop pass the server's instructions to the model; do the same.
const system: Anthropic.TextBlockParam[] = [
  { type: "text", text: `${mcp.getInstructions() ?? ""}\n\nToday is ${TODAY}.`, cache_control: { type: "ephemeral" } },
];

const hasProfile = existsSync(`${homedir()}/.config/anthropic`);
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !hasProfile) {
  console.error("No Anthropic credentials. Add ANTHROPIC_API_KEY=... to .env (get a key at https://console.anthropic.com).");
  process.exit(1);
}
const anthropic = new Anthropic();

// ── Scoring ──────────────────────────────────────────────────────────────────
function matches(expected: Matcher, actual: unknown): boolean {
  if (typeof expected === "function") return Boolean((expected as (v: unknown) => boolean)(actual));
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e) => actual.some((x) => matches(e, x)));
  if (expected && typeof expected === "object") {
    return Boolean(actual) && typeof actual === "object" && Object.entries(expected).every(([k, v]) => matches(v, (actual as Record<string, unknown>)[k]));
  }
  if (typeof expected === "string" && typeof actual === "string") return expected.toLowerCase() === actual.toLowerCase();
  return expected === actual;
}

const callMatches = (e: ExpectedCall, c: ToolCall) => e.tool === c.name && matches(e.args ?? {}, c.input);

function score(c: EvalCase, calls: ToolCall[]): { pass: boolean; reason: string } {
  if (c.noTools && calls.length) return { pass: false, reason: `expected no tools, called ${calls.map((x) => x.name).join(", ")}` };
  const expectedTools = new Set(c.expect.map((e) => e.tool));
  const forbidden = c.forbid ?? WRITE_TOOLS.filter((t) => !expectedTools.has(t));
  const bad = calls.filter((x) => forbidden.includes(x.name));
  if (bad.length) return { pass: false, reason: `called forbidden ${bad.map((x) => x.name).join(", ")}` };
  if (c.expect.length && !calls.some((x) => c.expect.some((e) => callMatches(e, x)))) {
    const sameTool = calls.filter((x) => expectedTools.has(x.name));
    return {
      pass: false,
      reason: sameTool.length
        ? `right tool, wrong inputs: ${sameTool.map((x) => JSON.stringify(x.input)).join(" | ")}`
        : `expected ${[...expectedTools].join(" or ")}, called ${calls.map((x) => x.name).join(", ") || "nothing"}`,
    };
  }
  return { pass: true, reason: "" };
}

// ── One case: a short conversation with tool calls answered by the MCP server ─
async function runCase(c: EvalCase, run: number): Promise<CaseResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: c.prompt }];
  const calls: ToolCall[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let confirmed = false;
  let finalText = "";

  for (let i = 0; i < MAX_REQUESTS; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system,
      tools,
      messages,
    });
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;

    if (response.stop_reason === "refusal") return { id: c.id, run, pass: false, reason: "model refused", calls, finalText, usage };
    messages.push({ role: "assistant", content: response.content });
    finalText = response.content.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("\n");

    const toolUses = response.content.filter((x): x is Anthropic.ToolUseBlock => x.type === "tool_use");
    if (!toolUses.length) {
      // Claude stopped to ask "shall I go ahead?" before a write. Answer yes once, like a user would.
      const needsWrite = c.expect.some((e) => WRITE_TOOLS.includes(e.tool));
      if (needsWrite && !confirmed && !calls.some((x) => c.expect.some((e) => callMatches(e, x)))) {
        confirmed = true;
        messages.push({ role: "user", content: c.id.endsWith("-cs") ? "Ano, pokračuj." : "Yes, go ahead." });
        continue;
      }
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const input = use.input as Record<string, unknown>;
      calls.push({ name: use.name, input });
      const res = await mcp.callTool({ name: use.name, arguments: input });
      const text = (res.content as { type: string; text?: string }[]).map((x) => x.text ?? "").join("\n");
      results.push({ type: "tool_result", tool_use_id: use.id, content: text, is_error: Boolean(res.isError) });
    }
    messages.push({ role: "user", content: results });
  }

  return { id: c.id, run, ...score(c, calls), calls, finalText, usage };
}

// ── Run all ──────────────────────────────────────────────────────────────────
const only = opts.only?.split(",").map((s) => s.trim());
const selected = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
if (!selected.length) throw new Error(`No cases match --only ${opts.only}`);
const jobs = Array.from({ length: Number(opts.repeat) }, (_, run) => selected.map((c) => ({ c, run }))).flat();

console.log(`Running ${jobs.length} case run(s) on ${MODEL}…\n`);
const results: CaseResult[] = [];

async function runJob({ c, run }: (typeof jobs)[number]) {
  try {
    const r = await runCase(c, run);
    results.push(r);
    console.log(`${r.pass ? "✓" : "✗"} ${c.id.padEnd(24)} ${r.calls.map((x) => x.name).join(" → ") || "(no tools)"}${r.pass ? "" : `\n    ${r.reason}`}`);
    if (opts.verbose && !r.pass) console.log(`    final answer: ${r.finalText.slice(0, 300).replace(/\n/g, " ")}`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("Anthropic API key missing or invalid. Set ANTHROPIC_API_KEY in your environment or .env.");
      process.exit(1);
    }
    // Account-level problems (no credits, no access) would fail every case the same way: stop now.
    if (err instanceof Anthropic.PermissionDeniedError || (err instanceof Anthropic.BadRequestError && /credit balance|billing/i.test(err.message))) {
      console.error(`Anthropic API refused the request: ${err.message}`);
      process.exit(1);
    }
    const reason = err instanceof Anthropic.APIError ? `API error ${err.status}: ${err.message}` : String(err);
    results.push({ id: c.id, run, pass: false, reason, calls: [], finalText: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    console.log(`! ${c.id.padEnd(24)} ${reason}`);
  }
}

// Run the first job alone so the shared tools + system prompt are cached before the rest start in parallel.
const [first, ...rest] = jobs;
await runJob(first);
let next = 0;
await Promise.all(
  Array.from({ length: Number(opts.concurrency) }, async () => {
    while (next < rest.length) await runJob(rest[next++]);
  }),
);

// ── Summary ──────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.pass).length;
const total = results.reduce(
  (t, r) => ({
    input: t.input + r.usage.input,
    output: t.output + r.usage.output,
    cacheRead: t.cacheRead + r.usage.cacheRead,
    cacheWrite: t.cacheWrite + r.usage.cacheWrite,
  }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
);
const price = PRICES[MODEL];
const cost = price
  ? (total.input * price[0] + total.cacheWrite * price[0] * 1.25 + total.cacheRead * price[2] + total.output * price[1]) / 1e6
  : undefined;

console.log(`\n${passed}/${results.length} passed (${Math.round((passed / results.length) * 100)} %)`);
console.log(
  `Tokens: ${total.input} input, ${total.cacheWrite} cache write, ${total.cacheRead} cache read, ${total.output} output` +
    (cost !== undefined ? ` ≈ $${cost.toFixed(2)}` : ""),
);

await mkdir("evals/results", { recursive: true });
const file = `evals/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(file, JSON.stringify({ model: MODEL, date: new Date().toISOString(), passed, total: results.length, cost, results }, null, 2));
console.log(`Details: ${file}`);
await mcp.close();
process.exit(passed === results.length ? 0 : 1);
