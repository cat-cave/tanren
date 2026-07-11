// Benchmark `tanren experiments|cells ...` CLI commands, driven end-to-end
// against a local stub orchestrator (docs/roadmap/tanren-method-benchmark.md
// §4.2.4). Asserts the request contract (method/path/query/body by value) and
// the OBSERVABLE output — the JSON for CRUD verbs, the rendered table for
// report/compare. No fetch spying / console call-count assertions.

import { afterEach, describe, expect, it, vi } from "vitest";
import { findProductHandler } from "../src/commands/dispatch.js";
import type * as ExperimentsNs from "../src/commands/experiments/index.js";
import { renderCellComparison, renderCellScorecard } from "../src/commands/experiments/render.js";
import { captureStdout } from "./helpers/captureOutput.js";
import { startStubServer, type StubServer } from "./helpers/stubServer.js";

let server: StubServer;
let serverStarted = false;

async function withStub(responseBody: unknown): Promise<typeof ExperimentsNs> {
  server = await startStubServer(responseBody);
  serverStarted = true;
  process.env.TANREN_PUBLIC_BASE_URL = server.url;
  process.env.TANREN_AUTH_FILE = "/nonexistent/tanren-experiments-cli-auth.json";
  vi.resetModules();
  return import("../src/commands/experiments/index.js");
}

afterEach(async () => {
  if (serverStarted) await server.close();
  serverStarted = false;
  delete process.env.TANREN_PUBLIC_BASE_URL;
  delete process.env.TANREN_AUTH_FILE;
});

const SEED = '{"repo":"o/r","sha":"abc12345","acceptTierHash":"h","corpusTier":1}';
// Valid FrozenConfig shape matching server entities (no obsolete escapeHatches).
const FROZEN =
  '{"routing":{"write":{"chain":[{"cli":"codex","model":"x","authRef":"credential/codex/org/x"}]}},"ciTiers":{"tiers":{"fast":[{"name":"lint","run":"pnpm lint"}],"slow":[{"name":"test","run":"pnpm test"}]},"when":{"fast":["per_iteration"],"slow":["pre_merge"]}},"governance":"strict","mergeIntegration":"not_configured"}';

/** Sentinel that must never appear in redacted parse-error messages. */
const SECRET = "tnt_sentinel_SECRET_never_leak_9f3a";

describe("benchmark CLI dispatch", () => {
  it("registers experiments + cells verbs", () => {
    for (const sub of ["create", "list", "get", "run", "report", "compare"]) {
      expect(findProductHandler("experiments", sub)).toBeDefined();
    }
    expect(findProductHandler("cells", "create")).toBeDefined();
    expect(findProductHandler("cells", "list")).toBeDefined();
  });

  it("experiments create POSTs the org-scoped experiments route", async () => {
    const exp = await withStub({ experiment: { experimentId: "experiment_1" } });
    const out = await captureStdout(() =>
      exp.experimentsCreate([
        "--org-id",
        "org_acme",
        "--title",
        "T",
        "--knob",
        "governance",
        "--hypothesis",
        "H",
        "--seed-task-ref",
        SEED,
      ]),
    );
    expect(out.json()).toEqual({ experiment: { experimentId: "experiment_1" } });
    const sent = server.lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/orgs/org_acme/experiments");
    expect(sent.json).toMatchObject({ knob: "governance", seedTaskRef: { repo: "o/r", corpusTier: 1 } });
  });

  it("experiments list GETs the org-scoped route", async () => {
    const exp = await withStub({ experiments: [] });
    await captureStdout(() => exp.experimentsList(["--org-id", "org_acme"]));
    expect(server.lastRequest().path).toBe("/orgs/org_acme/experiments");
    expect(server.lastRequest().method).toBe("GET");
  });

  it("experiments get accepts a positional experiment id", async () => {
    const exp = await withStub({ experiment: { experimentId: "experiment_1" } });
    await captureStdout(() => exp.experimentsGet(["--org-id", "org_acme", "experiment_1"]));
    expect(server.lastRequest().path).toBe("/orgs/org_acme/experiments/experiment_1");
  });

  it("cells create POSTs under the experiment with a parsed trials-target", async () => {
    const exp = await withStub({ cell: { cellId: "cell_1" } });
    await captureStdout(() =>
      exp.cellsCreate([
        "--org-id",
        "org_acme",
        "--experiment-id",
        "experiment_1",
        "--label",
        "control",
        "--frozen-config",
        FROZEN,
        "--trials-target",
        "5",
      ]),
    );
    const sent = server.lastRequest();
    expect(sent.path).toBe("/orgs/org_acme/experiments/experiment_1/cells");
    expect(sent.json).toMatchObject({ label: "control", trialsTarget: 5 });
    expect(sent.json).toMatchObject({
      frozenConfig: {
        governance: "strict",
        mergeIntegration: "not_configured",
        ciTiers: { tiers: { fast: [{ name: "lint", run: "pnpm lint" }] } },
      },
    });
  });

  it("experiments run targets the cell run route when --cell-id is given", async () => {
    const exp = await withStub({ result: {} });
    await captureStdout(() => exp.experimentsRun(["--org-id", "org_acme", "--cell-id", "cell_1"]));
    const sent = server.lastRequest();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/orgs/org_acme/cells/cell_1/run");
  });

  it("experiments run targets the experiment run route by default", async () => {
    const exp = await withStub({ result: {} });
    await captureStdout(() => exp.experimentsRun(["--org-id", "org_acme", "--experiment-id", "experiment_1"]));
    expect(server.lastRequest().path).toBe("/orgs/org_acme/experiments/experiment_1/run");
  });

  it("experiments report renders the cell scorecard table (and --json prints raw)", async () => {
    const scorecardBody = {
      scorecard: {
        cellId: "cell_1",
        trials: 3,
        mergeSuccessRate: 1,
        acceptGreenRate: null,
        metrics: { leadTimeSeconds: { point: 200, lower: 100, upper: 300, sample: 3, tooWideToCall: false } },
      },
    };
    const exp = await withStub(scorecardBody);
    const table = await captureStdout(() => exp.experimentsReport(["--org-id", "org_acme", "--cell-id", "cell_1"]));
    expect(server.lastRequest().path).toBe("/orgs/org_acme/cells/cell_1/scorecard");
    expect(table.stdout).toContain("leadTimeSeconds");
    expect(table.stdout).toContain("trials=3");

    const json = await captureStdout(() =>
      exp.experimentsReport(["--org-id", "org_acme", "--cell-id", "cell_1", "--json"]),
    );
    expect(json.json()).toEqual(scorecardBody);
  });

  it("experiments compare renders the verdict table", async () => {
    const body = {
      cellA: "cell_a",
      cellB: "cell_b",
      comparison: {
        nA: 3,
        nB: 3,
        metrics: {
          leadTimeSeconds: {
            diffOfMedians: -500,
            medianA: 110,
            medianB: 610,
            pValue: 0.04,
            effectSize: -0.8,
            lowerIsBetter: true,
            verdict: "winner_a",
          },
        },
      },
    };
    const exp = await withStub(body);
    const out = await captureStdout(() =>
      exp.experimentsCompare([
        "--org-id",
        "org_acme",
        "--experiment-id",
        "experiment_1",
        "--cell-a",
        "cell_a",
        "--cell-b",
        "cell_b",
      ]),
    );
    const sent = server.lastRequest();
    expect(sent.path).toBe("/orgs/org_acme/experiments/experiment_1/compare");
    expect(sent.query).toMatchObject({ cellA: "cell_a", cellB: "cell_b" });
    expect(out.stdout).toContain("A wins");
    expect(out.stdout).toContain("leadTimeSeconds");
  });
});

describe("benchmark render helpers", () => {
  it("renderCellScorecard flags a too-wide CI", () => {
    const out = renderCellScorecard({
      cellId: "cell_1",
      trials: 2,
      mergeSuccessRate: 0.5,
      acceptGreenRate: null,
      metrics: { costUsd: { point: 10, lower: 1, upper: 40, sample: 2, tooWideToCall: true } },
    });
    expect(out).toContain("too-wide");
    expect(out).toContain("cell_1");
  });

  it("renderCellComparison labels each verdict", () => {
    const out = renderCellComparison(
      {
        nA: 2,
        nB: 2,
        metrics: {
          costUsd: {
            diffOfMedians: 1,
            medianA: 5,
            medianB: 4,
            pValue: 0.5,
            effectSize: 0.1,
            lowerIsBetter: true,
            verdict: "no_call",
          },
        },
      },
      "cell_a",
      "cell_b",
    );
    expect(out).toContain("no call");
    expect(out).toContain("A=cell_a");
  });
});

describe("experiment / cell input validation (CX-016)", () => {
  it("parseSeedTaskRef accepts a valid shape and rejects non-objects / bad tiers / unknown fields", async () => {
    const exp = await import("../src/commands/experiments/index.js");
    expect(exp.parseSeedTaskRef(SEED)).toEqual({
      repo: "o/r",
      sha: "abc12345",
      acceptTierHash: "h",
      corpusTier: 1,
    });
    expect(() => exp.parseSeedTaskRef("[]")).toThrow(/must be a JSON object/u);
    expect(() => exp.parseSeedTaskRef("null")).toThrow(/must be a JSON object/u);
    expect(() => exp.parseSeedTaskRef("not-json")).toThrow(/not valid JSON/u);
    expect(() => exp.parseSeedTaskRef('{"repo":"o/r","sha":"x","acceptTierHash":"h","corpusTier":9}')).toThrow(
      /corpusTier/u,
    );
    expect(() => exp.parseSeedTaskRef('{"repo":"","sha":"x","acceptTierHash":"h","corpusTier":0}')).toThrow(/repo/u);
    // Strict: typo'd / unknown field is rejected (server SeedTaskRef is .strict()).
    expect(() =>
      exp.parseSeedTaskRef('{"repo":"o/r","sha":"x","acceptTierHash":"h","corpusTier":1,"repos":"typo"}'),
    ).toThrow(/unknown field/u);
    expect(() =>
      exp.parseSeedTaskRef('{"repo":"o/r","sha":"x","acceptTierHash":"h","corpusTier":1,"extra":true}'),
    ).toThrow(/unknown field/u);
  });

  it("parseSeedTaskRef redacts secrets from invalid-JSON errors", async () => {
    const exp = await import("../src/commands/experiments/index.js");
    // Truncated JSON containing a sentinel secret.
    const bad = `{"repo":"${SECRET}","sha":`;
    let message = "";
    try {
      exp.parseSeedTaskRef(bad);
      message = "expected throw";
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not valid JSON/u);
    expect(message).not.toContain(SECRET);
  });

  it("parseFrozenConfig accepts a valid shape and rejects incomplete / unknown / bad enums", async () => {
    const exp = await import("../src/commands/experiments/index.js");
    const ok = exp.parseFrozenConfig(FROZEN);
    expect(ok).toMatchObject({
      governance: "strict",
      mergeIntegration: "not_configured",
      ciTiers: {
        tiers: {
          fast: [{ name: "lint", run: "pnpm lint" }],
          slow: [{ name: "test", run: "pnpm test" }],
        },
      },
    });

    // Non-objects
    expect(() => exp.parseFrozenConfig("[]")).toThrow(/must be a JSON object/u);
    expect(() => exp.parseFrozenConfig('"string"')).toThrow(/must be a JSON object/u);
    expect(() => exp.parseFrozenConfig("null")).toThrow(/must be a JSON object/u);

    // Empty object is NOT enough — required fields
    expect(() => exp.parseFrozenConfig("{}")).toThrow(/must include field/u);

    // Obsolete escapeHatches (and any unknown top-level key) rejected
    expect(() => exp.parseFrozenConfig(FROZEN.slice(0, -1) + ',"escapeHatches":{}}')).toThrow(/unknown field/u);

    // Bad governance / mergeIntegration enums
    expect(() => exp.parseFrozenConfig(FROZEN.replace('"governance":"strict"', '"governance":"nope"'))).toThrow(
      /governance/u,
    );
    expect(() =>
      exp.parseFrozenConfig(FROZEN.replace('"mergeIntegration":"not_configured"', '"mergeIntegration":"mergify"')),
    ).toThrow(/mergeIntegration/u);

    // Missing nested tiers.fast
    expect(() =>
      exp.parseFrozenConfig(
        '{"routing":{},"ciTiers":{"tiers":{"slow":[{"name":"t","run":"x"}]},"when":{"slow":["pre_merge"]}},"governance":"strict","mergeIntegration":"not_configured"}',
      ),
    ).toThrow(/fast/u);
  });

  it("parseFrozenConfig redacts secrets from invalid-JSON errors", async () => {
    const exp = await import("../src/commands/experiments/index.js");
    const bad = `{"token":"${SECRET}"`;
    let message = "";
    try {
      exp.parseFrozenConfig(bad);
      message = "expected throw";
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not valid JSON/u);
    expect(message).not.toContain(SECRET);
  });

  it("parseTrialsTarget enforces integer >= 1 (no artificial upper bound)", async () => {
    const exp = await import("../src/commands/experiments/index.js");
    expect(exp.parseTrialsTarget("5")).toBe(5);
    expect(exp.parseTrialsTarget("1")).toBe(1);
    // Server accepts every integer >= 1 — large targets must pass.
    expect(exp.parseTrialsTarget("10001")).toBe(10001);
    expect(exp.parseTrialsTarget("1000000")).toBe(1_000_000);
    expect(() => exp.parseTrialsTarget("0")).toThrow(/>= 1|trials-target/u);
    expect(() => exp.parseTrialsTarget("-1")).toThrow(/>= 1|trials-target/u);
    expect(() => exp.parseTrialsTarget("1.5")).toThrow(/integer/u);
    expect(() => exp.parseTrialsTarget("nope")).toThrow(/integer/u);
  });

  it("experiments create fails before the network on bad seed-task-ref", async () => {
    const exp = await withStub({ experiment: { experimentId: "experiment_1" } });
    await expect(
      exp.experimentsCreate([
        "--org-id",
        "org_acme",
        "--title",
        "T",
        "--knob",
        "governance",
        "--hypothesis",
        "H",
        "--seed-task-ref",
        "[]",
      ]),
    ).rejects.toThrow(/must be a JSON object/u);
    // No request should have been issued.
    expect(() => server.lastRequest()).toThrow(/no requests/u);
  });

  it("experiments create fails before the network on typo'd seed-task-ref field", async () => {
    const exp = await withStub({ experiment: { experimentId: "experiment_1" } });
    await expect(
      exp.experimentsCreate([
        "--org-id",
        "org_acme",
        "--title",
        "T",
        "--knob",
        "governance",
        "--hypothesis",
        "H",
        "--seed-task-ref",
        '{"repo":"o/r","sha":"x","acceptTierHash":"h","corpusTier":1,"repos":"typo"}',
      ]),
    ).rejects.toThrow(/unknown field/u);
    expect(() => server.lastRequest()).toThrow(/no requests/u);
  });

  it("cells create fails before the network on bad trials-target", async () => {
    const exp = await withStub({ cell: { cellId: "cell_1" } });
    await expect(
      exp.cellsCreate([
        "--org-id",
        "org_acme",
        "--experiment-id",
        "experiment_1",
        "--label",
        "control",
        "--frozen-config",
        FROZEN,
        "--trials-target",
        "0",
      ]),
    ).rejects.toThrow(/trials-target/u);
    expect(() => server.lastRequest()).toThrow(/no requests/u);
  });

  it("cells create fails before the network on incomplete frozen-config", async () => {
    const exp = await withStub({ cell: { cellId: "cell_1" } });
    await expect(
      exp.cellsCreate([
        "--org-id",
        "org_acme",
        "--experiment-id",
        "experiment_1",
        "--label",
        "control",
        "--frozen-config",
        "{}",
        "--trials-target",
        "5",
      ]),
    ).rejects.toThrow(/frozen-config/u);
    expect(() => server.lastRequest()).toThrow(/no requests/u);
  });

  it("cells create accepts large trials-target matching server contract", async () => {
    const exp = await withStub({ cell: { cellId: "cell_1" } });
    await captureStdout(() =>
      exp.cellsCreate([
        "--org-id",
        "org_acme",
        "--experiment-id",
        "experiment_1",
        "--label",
        "control",
        "--frozen-config",
        FROZEN,
        "--trials-target",
        "10001",
      ]),
    );
    expect(server.lastRequest().json).toMatchObject({ trialsTarget: 10001 });
  });
});
