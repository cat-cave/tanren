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
const FROZEN =
  '{"routing":{"write":{"chain":[{"cli":"codex","model":"x","authRef":"credential/codex/org/x"}]}},"escapeHatches":{},"ciTiers":{"tiers":{"fast":[{"name":"lint","run":"pnpm lint"}],"slow":[{"name":"test","run":"pnpm test"}]},"when":{"fast":["per_iteration"],"slow":["pre_merge"]}},"governance":"strict","mergeIntegration":"not_configured"}';

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
