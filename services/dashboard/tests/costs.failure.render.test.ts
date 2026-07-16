import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = { id: "org_acme", kind: "github_org", login: "acme", displayName: "Acme", role: "org:admin" };
const PROJECT = {
  projectId: "project_1",
  name: "one",
  repoUrl: "https://github.com/acme/one",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};
const RUN = {
  runId: "run_1",
  specId: "spec_1",
  projectId: "project_1",
  branch: "main",
  trigger: "operator",
  status: "completed",
  outcome: "ok",
  startedAt: "2026-05-01T00:00:00.000Z",
  endedAt: "2026-05-01T00:01:00.000Z",
  prUrl: null,
  specTitle: "One",
  costTotalUsd: null,
  lastEventAt: null,
  needsReview: false,
};
const UNKNOWN_COST = {
  id: "1",
  runId: "run_1",
  taskId: "task_1",
  projectId: "project_1",
  cli: "=danger",
  provider: "openai",
  model: "gpt",
  inputTokens: 4,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 2,
  reasoningOutputTokens: 0,
  totalTokens: 6,
  costUsd: null,
  notionalCostUsd: null,
  billingMode: "subscription",
  costBasis: "unknown",
  recordedAt: "2026-05-01T00:00:30.000Z",
};
const PRICED_COST = {
  ...UNKNOWN_COST,
  id: "2",
  costUsd: "0.04",
  notionalCostUsd: null,
  billingMode: "per_token",
  costBasis: "ccusage",
  recordedAt: "2026-05-01T00:00:31.000Z",
};
const KNOWN_ZERO_COST = {
  ...UNKNOWN_COST,
  costUsd: "0",
  notionalCostUsd: null,
  billingMode: "per_token",
  costBasis: "ccusage",
};

// A per-token / ccusage record used as the SHARED ProviderRow key for the CSV
// partial + known-zero cases. A priced record and a null record share the exact
// (cli · model · provider · billingMode · costBasis) so they collapse into ONE
// row — partial state must arise from mixed coverage inside a single source
// group, not from two fully-priced / fully-unpriced groups side-by-side.
// `ccusage` keeps a non-null `costUsd` legal under the strict decoder (only
// `unknown`/`unattributed` force null), so a priced + null pair can co-key.
const TOKEN_COST = {
  id: "10",
  runId: "run_1",
  taskId: "task_1",
  projectId: "project_1",
  cli: "codex",
  provider: "openai",
  model: "gpt-5",
  inputTokens: 4,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 2,
  reasoningOutputTokens: 0,
  totalTokens: 6,
  costUsd: null,
  notionalCostUsd: null,
  billingMode: "per_token",
  costBasis: "ccusage",
  recordedAt: "2026-05-01T00:00:30.000Z",
};
// Same ProviderRow key as TOKEN_COST; priced subtotal $0.04 + one unpriced row.
const PARTIAL_NONZERO_COSTS = [
  { ...TOKEN_COST, id: "10", costUsd: "0.04", recordedAt: "2026-05-01T00:00:30.000Z" },
  { ...TOKEN_COST, id: "11", costUsd: null, recordedAt: "2026-05-01T00:00:31.000Z" },
];
// Same ProviderRow key; priced subtotal is a genuine known ZERO + one unpriced
// row — the regression case: a zero subtotal must NOT downgrade partial→unknown.
const PARTIAL_KNOWN_ZERO_COSTS = [
  { ...TOKEN_COST, id: "20", costUsd: "0", recordedAt: "2026-05-01T00:00:30.000Z" },
  { ...TOKEN_COST, id: "21", costUsd: null, recordedAt: "2026-05-01T00:00:31.000Z" },
];
// A single fully-priced record carrying a genuine known-zero real spend.
const KNOWN_ZERO_TOKEN_COST = { ...TOKEN_COST, id: "30", costUsd: "0" };
// These distinct five-field tuples produce the same text under a naive `|`
// join. Provider grouping must retain both rows in HTML and CSV.
const DELIMITER_DISTINCT_COSTS = [
  { ...TOKEN_COST, id: "40", cli: "codex|gpt", model: "5", costUsd: "0.01" },
  {
    ...TOKEN_COST,
    id: "41",
    cli: "codex",
    model: "gpt|5",
    costUsd: "0.02",
    recordedAt: "2026-05-01T00:00:31.000Z",
  },
];
// Contract-valid priced values whose billing mode is outside the three model
// cards. They remain provider-visible, but must never be normalized away by the
// model bar/card percentages on either selected monetary axis.
const PRICED_UNATTRIBUTED_REAL_COST = {
  ...TOKEN_COST,
  id: "50",
  cli: "rogue-real",
  provider: "edge",
  costUsd: "1.00",
  billingMode: "unattributed",
  costBasis: "provider_response",
};
const SUBSCRIPTION_NOTIONAL_COST = {
  ...TOKEN_COST,
  id: "60",
  cli: "subscription-cli",
  costUsd: null,
  notionalCostUsd: "1.00",
  billingMode: "subscription",
  costBasis: "unknown",
};
const PRICED_UNATTRIBUTED_NOTIONAL_COST = {
  ...SUBSCRIPTION_NOTIONAL_COST,
  id: "61",
  cli: "rogue-notional",
  provider: "edge",
  billingMode: "unattributed",
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function commonResponse(url: string): Response | undefined {
  if (url.endsWith("/auth/me")) {
    return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
  }
  if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
  if (/\/orgs\/[^/]+\/projects$/u.test(url)) {
    return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
  }
  if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
  return undefined;
}

function mockCosts(handler: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const common = commonResponse(url);
    if (common !== undefined) return common;
    if (/\/orgs\/[^/]+\/costs(?:\?|$)/u.test(url)) return handler(url);
    if (/\/runs(?:\?|$)/u.test(url)) return new Response(JSON.stringify({ items: [RUN] }), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

const CSV_HEADER =
  "cli,model,provider,billing_mode,cost_basis,runs,total_tokens,cost_state,cost_usd,notional_state,notional_cost_usd,share";
const PER_TOKEN_HINT = "token-billed api keys · real metered spend (provider charge / ccusage)";
const SUBSCRIPTION_HINT = "chatgpt / claude subscription · window-capped";

/** A strict-decoding, keyset-terminal OrgCosts body binding costs→runs→project. */
function orgCostsBody(costs: unknown[], runs: unknown[]): string {
  return JSON.stringify({ orgId: ORG.id, costs, runs, nextCursor: null });
}

/** Fetch /costs/export.csv against a mocked successful OrgCosts read model. */
async function fetchCsv(costs: unknown[], runs: unknown[] = [RUN]): Promise<{ response: Response; body: string }> {
  mockCosts(() => new Response(orgCostsBody(costs, runs), { status: 200 }));
  const response = await (await build()).request("/costs/export.csv");
  return { response, body: await response.text() };
}

/** Every successful CSV case: 200, text/csv, attachment, and exact rows. */
function expectCsvSuccess(response: Response, body: string, rows: string[]): void {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/csv");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="tanren-costs.csv"');
  expect(body).toBe([CSV_HEADER, ...rows].join("\n"));
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

describe("costs fail-closed product states", () => {
  it("renders a true empty ledger only for a valid empty terminal response", async () => {
    mockCosts(
      () => new Response(JSON.stringify({ orgId: ORG.id, costs: [], runs: [], nextCursor: null }), { status: 200 }),
    );
    const response = await (await build()).request("/costs");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("No cost records yet");
    expect(html).not.toContain('data-cost-state="unavailable"');
  });

  it.each([
    ["auth", 403, JSON.stringify({ error: "denied" }), 403],
    ["upstream", 500, JSON.stringify({ error: "broken" }), 503],
    ["malformed", 200, JSON.stringify({ costs: [], runs: [] }), 502],
  ])("renders %s failure as unavailable, not empty or zero", async (_label, upstream, body, expected) => {
    mockCosts(() => new Response(body, { status: upstream }));
    const response = await (await build()).request("/costs");
    const html = await response.text();
    expect(response.status).toBe(expected);
    expect(html).toContain('data-cost-state="unavailable"');
    expect(html).toContain("No empty ledger or $0 total has been inferred");
    expect(html).not.toContain("No cost records yet");
    expect(html).not.toContain('href="/costs/export.csv"');
  });

  it("renders a network failure as unavailable", async () => {
    mockCosts(() => Promise.reject(new Error("offline")));
    const response = await (await build()).request("/costs");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("the orchestrator could not be reached");
  });

  it("renders all-unknown money as unknown, while known zero remains distinct in history", async () => {
    mockCosts((url) => {
      if (url.includes("/costs")) {
        return new Response(JSON.stringify({ orgId: ORG.id, costs: [UNKNOWN_COST], runs: [RUN], nextCursor: null }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const app = await build();
    const costs = await (await app.request("/costs?range=all")).text();
    expect(costs).toContain("real spend · billed · unknown");
    expect(costs).toContain('<span class="total-amount">unknown</span>');
    expect(costs).toContain(`${SUBSCRIPTION_HINT} · —`);
    expect(costs).not.toContain('<span class="seg-label">');
    expect(costs).not.toContain("$0.00");

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const common = commonResponse(url);
      if (common !== undefined) return common;
      if (/\/runs(?:\?|$)/u.test(url)) {
        return new Response(JSON.stringify({ items: [RUN, { ...RUN, runId: "run_zero", costTotalUsd: "0" }] }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const history = await (await app.request("/history")).text();
    expect(history).toContain("unknown");
    expect(history).toContain("$0.00");
  });

  it("renders partial coverage as a known subtotal, not all-unknown or a bare fully-known total", async () => {
    mockCosts(
      () =>
        new Response(
          JSON.stringify({ orgId: ORG.id, costs: [UNKNOWN_COST, PRICED_COST], runs: [RUN], nextCursor: null }),
          { status: 200 },
        ),
    );
    const response = await (await build()).request("/costs?range=all");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<span class="total-eyebrow">real spend · billed · partial known subtotal · 1 run</span>');
    expect(html).toContain('<span class="total-amount">$0.04 known</span>');
    expect(html).not.toContain('<span class="total-amount">unknown</span>');
    expect(html).not.toContain('data-cost-state="unavailable"');
    expect(html).not.toContain("No cost records yet");
  });

  it("renders a fully known zero as $0.00, not unknown or partial", async () => {
    mockCosts(
      () =>
        new Response(
          JSON.stringify({
            orgId: ORG.id,
            costs: [KNOWN_ZERO_COST],
            runs: [{ ...RUN, costTotalUsd: "0" }],
            nextCursor: null,
          }),
          { status: 200 },
        ),
    );
    const response = await (await build()).request("/costs?range=all");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<span class="total-eyebrow">real spend · billed · 1 run</span>');
    expect(html).toContain('<span class="total-amount">$0.00</span>');
    expect(html).toContain(`${PER_TOKEN_HINT} · —`);
    expect(html).not.toContain('<span class="seg-label">');
    expect(html).not.toContain('<span class="total-amount">unknown</span>');
    expect(html).not.toContain("partial known subtotal");
  });

  it("renders model and segment shares for a fully known positive selected axis", async () => {
    mockCosts(() => new Response(orgCostsBody([PRICED_COST], [RUN]), { status: 200 }));
    const response = await (await build()).request("/costs?range=all");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<span class="seg-label">100%</span>');
    expect(html).toContain(`${PER_TOKEN_HINT} · 100%`);
    expect(html).toContain('<span class="num hi">$0.04</span><span class="num">100%</span>');
  });

  it("suppresses real model shares when a priced unattributed source contributes to the total", async () => {
    const modeled = { ...PRICED_COST, costUsd: "1.00" };
    mockCosts(() => new Response(orgCostsBody([PRICED_UNATTRIBUTED_REAL_COST, modeled], [RUN]), { status: 200 }));
    const response = await (await build()).request("/costs?range=all");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<span class="total-amount">$2.00</span>');
    expect(html).toContain('<span class="total-scope">across 2 cost sources</span>');
    expect(html).toContain('<div class="cost-stacked"></div>');
    expect(html).toContain(`${PER_TOKEN_HINT} · —`);
    expect(html).not.toContain(`${PER_TOKEN_HINT} · 50%`);
    expect(html).toContain("rogue-real · gpt-5 · edge");
    expect(html).toContain("unattributed · unrecognized ref · provider response · real charge");
    expect(html.match(/<span class="num hi">\$1\.00<\/span><span class="num">50%<\/span>/gu)).toHaveLength(2);
  });

  it("suppresses equivalent model shares when priced unattributed notional contributes to the total", async () => {
    const records = [SUBSCRIPTION_NOTIONAL_COST, PRICED_UNATTRIBUTED_NOTIONAL_COST];
    mockCosts(() => new Response(orgCostsBody(records, [RUN]), { status: 200 }));
    const response = await (await build()).request("/costs?range=all");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("equivalent · api-priced estimate · 1 run");
    expect(html).toContain('<span class="total-amount">$2.00</span>');
    expect(html).toContain('<span class="total-scope">across 2 cost sources</span>');
    expect(html).toContain('<div class="cost-stacked"></div>');
    expect(html).toContain('<div class="v">$1.00 equiv</div>');
    expect(html).toContain(`${SUBSCRIPTION_HINT} · —`);
    expect(html).not.toContain(`${SUBSCRIPTION_HINT} · 50%`);
    expect(html).toContain("rogue-notional · gpt-5 · edge");
    expect(html).toContain("unattributed · unrecognized ref · no priced basis · tokens only");
  });

  it("renders a partial nonzero provider row with known subtotal, partial qualifier, and dash share", async () => {
    // One provider key, mixed priced ($0.04) + unpriced — row.realCoverage is
    // partial. Product HTML must show the known subtotal + an unambiguous
    // partial qualifier, never "no $ basis", and never a fabricated share %
    // (global coverage is also partial ⇒ share is "—").
    mockCosts(() => new Response(orgCostsBody(PARTIAL_NONZERO_COSTS, [RUN]), { status: 200 }));
    const response = await (await build()).request("/costs?range=all");
    const html = await response.text();
    expect(response.status).toBe(200);
    // Exact product HTML: amount cell + immediately following dash share cell.
    expect(html).toContain('<span class="num hi">$0.04 known · partial</span><span class="num">—</span>');
    expect(html).toContain(`${PER_TOKEN_HINT} · —`);
    expect(html).not.toContain('<span class="seg-label">');
    expect(html).not.toContain("no $ basis");
    // Reject a bare fully-known amount and any fabricated share percentage on
    // this partial row (scoped to the amount/share pair — page CSS has "100%").
    expect(html).not.toMatch(/class="num hi">\$0\.04<\/span>/u);
    expect(html).not.toMatch(/class="num hi">\$0\.04 known · partial<\/span><span class="num">\d+(?:\.\d+)?%<\/span>/u);
  });

  it("renders a partial known-zero provider row with $0.00 known · partial and dash share", async () => {
    // Regression: a zero known subtotal must stay partial (not "no $ basis" /
    // unknown) and still blank the share — same honesty as the CSV export.
    mockCosts(() => new Response(orgCostsBody(PARTIAL_KNOWN_ZERO_COSTS, [RUN]), { status: 200 }));
    const response = await (await build()).request("/costs?range=all");
    const html = await response.text();
    expect(response.status).toBe(200);
    // Exact product HTML: $0.00 known subtotal + partial qualifier + dash share.
    expect(html).toContain('<span class="num hi">$0.00 known · partial</span><span class="num">—</span>');
    expect(html).toContain(`${PER_TOKEN_HINT} · —`);
    expect(html).not.toContain('<span class="seg-label">');
    expect(html).not.toContain("no $ basis");
    // Must not collapse partial-zero into a bare fully-known $0.00 amount cell,
    // nor invent a share percentage for an incompletely-known row.
    expect(html).not.toMatch(/class="num hi">\$0\.00<\/span>/u);
    expect(html).not.toMatch(/class="num hi">\$0\.00 known · partial<\/span><span class="num">\d+(?:\.\d+)?%<\/span>/u);
  });

  it("keeps delimiter-containing provider tuples distinct in HTML and CSV", async () => {
    mockCosts(() => new Response(orgCostsBody(DELIMITER_DISTINCT_COSTS, [RUN]), { status: 200 }));
    const htmlResponse = await (await build()).request("/costs?range=all");
    const html = await htmlResponse.text();
    expect(htmlResponse.status).toBe(200);
    expect(html.match(/<div class="cost-table-row">/gu)).toHaveLength(2);
    expect(html).toContain("codex|gpt · 5 · openai");
    expect(html).toContain("codex · gpt|5 · openai");

    const { response, body } = await fetchCsv(DELIMITER_DISTINCT_COSTS);
    expectCsvSuccess(response, body, [
      "codex,gpt|5,openai,per_token,ccusage,1,6,known,0.020000,unknown,,0.6667",
      "codex|gpt,5,openai,per_token,ccusage,1,6,known,0.010000,unknown,,0.3333",
    ]);
  });

  it.each([403, 500])("returns non-CSV error response for upstream HTTP %i", async (status) => {
    mockCosts(() => new Response(JSON.stringify({ error: "failed" }), { status }));
    const response = await (await build()).request("/costs/export.csv");
    expect(response.status).toBe(status === 403 ? 403 : 503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.text()).toContain("costs_");
  });

  it("exports honest unknown coverage and neutralizes spreadsheet formulas", async () => {
    const { response, body } = await fetchCsv([UNKNOWN_COST]);
    // All-unknown ⇒ blank value on BOTH axes (never a fabricated 0); state is
    // derived from explicit coverage. The leading "=" in cli is neutralized so a
    // spreadsheet app cannot evaluate it as a formula.
    expectCsvSuccess(response, body, ["'=danger,gpt,openai,subscription,unknown,1,6,unknown,,unknown,,"]);
    expect(body).toContain("'=danger");
    // A blank unknown value is distinct from a priced zero — never `0.000000`.
    expect(body).not.toContain("0.000000");
  });

  it("exports only the header for a valid empty ledger", async () => {
    const { response, body } = await fetchCsv([], []);
    // A genuinely empty (strict-decoded, keyset-terminal) ledger yields the
    // header alone — no fabricated data row, zero, or unknown state.
    expectCsvSuccess(response, body, []);
    expect(body).toBe(CSV_HEADER);
  });

  it("exports a partial nonzero row as partial with the known subtotal and no share", async () => {
    const { response, body } = await fetchCsv(PARTIAL_NONZERO_COSTS);
    // Partial ⇒ the known subtotal ($0.04) is emitted; only the all-unknown axis
    // (notional here) stays blank. Honest share: global coverage is partial ⇒ no
    // share value (the trailing field is empty), even with a known subtotal.
    expectCsvSuccess(response, body, ["codex,gpt-5,openai,per_token,ccusage,1,12,partial,0.040000,unknown,,"]);
    expect(body).not.toMatch(/,0\.040000,unknown,,0\.\d{4}$/u);
  });

  it("exports a partial known-zero as partial with 0.000000, never unknown", async () => {
    const { response, body } = await fetchCsv(PARTIAL_KNOWN_ZERO_COSTS);
    // The regression: a zero known subtotal must NOT downgrade a partial row to
    // `unknown`, and the value is the explicit `0.000000` (not blank). State is
    // read from explicit coverage, never inferred from `knownUsd > 0`.
    expectCsvSuccess(response, body, ["codex,gpt-5,openai,per_token,ccusage,1,12,partial,0.000000,unknown,,"]);
    // The buggy output was `12,unknown,,unknown,,` (cost_state unknown, blank
    // value) — pin the fixed partial state + explicit zero value.
    expect(body).toContain(",12,partial,0.000000,");
    expect(body).not.toContain(",12,unknown,");
  });

  it("exports a fully known zero as known with 0.000000 and a blank share", async () => {
    const { response, body } = await fetchCsv([KNOWN_ZERO_TOKEN_COST], [{ ...RUN, costTotalUsd: "0" }]);
    // Fully known (every record priced) ⇒ `known` with the explicit `0.000000`.
    // Share is blank: both global and row real coverage are fully known, but the
    // global real total is $0 — a share of a zero denominator is undefined, so
    // the field is blanked rather than reporting a misleading 100%.
    expectCsvSuccess(response, body, ["codex,gpt-5,openai,per_token,ccusage,1,6,known,0.000000,unknown,,"]);
  });
});
