import { describe, expect, it } from "vitest";
import { CostRecorder, CostUnattributableError } from "../src/engine/costs/index.js";
import { FakeEventStore } from "../src/engine/eventStore.js";

interface InsertedRow {
  table: string;
  columns: string[];
  params: ReadonlyArray<unknown>;
}

// Recording pool that captures cost_records inserts + responds to the
// rolling-30-day SELECT used by denominator refinement. Each test seeds the
// SELECT response explicitly.
class FakeCostPool {
  readonly inserts: InsertedRow[] = [];
  readonly denominatorUpserts: Array<{ authRef: string; observed: number }> = [];
  private rollingTokensByRef = new Map<string, number>();
  private denominators = new Map<string, number>();

  setRollingTokens(authRef: string, tokens: number): void {
    this.rollingTokensByRef.set(authRef, tokens);
  }

  setDenominator(authRef: string, observed: number): void {
    this.denominators.set(authRef, observed);
  }

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: ReadonlyArray<Record<string, unknown>>; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("INSERT INTO cost_records")) {
      this.inserts.push({ table: "cost_records", columns: [], params });
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT observed_max_monthly_tokens")) {
      const value = this.denominators.get(String(params[0]));
      if (value === undefined) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ observed_max_monthly_tokens: value }], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT COALESCE(SUM(input_tokens")) {
      const ref = String(params[0]);
      const total = this.rollingTokensByRef.get(ref) ?? 0;
      return { rows: [{ total: String(total) }], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO subscription_window_denominators")) {
      this.denominatorUpserts.push({ authRef: String(params[0]), observed: Number(params[1]) });
      this.denominators.set(String(params[0]), Number(params[1]));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

const context = {
  runId: "run_test",
  taskId: "task_test",
  specId: "spec_test",
  projectId: "project_test"
};

describe("CostRecorder", () => {
  it("persists a provider_direct cost row when given an API-key ref", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    const result = await recorder.record(
      {
        ...context,
        cli: "codex",
        model: "gpt-test",
        authRef: "credential/openai-api/prod"
      },
      { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 },
      { foo: "bar" }
    );
    expect(result.costSource).toBe("provider_direct");
    expect(result.pricingMode).toBe("per_token");
    expect(pool.inserts).toHaveLength(1);
    const insertParams = pool.inserts[0]?.params ?? [];
    expect(insertParams[11]).toBe("provider_direct");
    expect(events.events.map((event) => event.eventType)).toEqual(["cost.resolved"]);
  });

  it("persists a codexbar row and refines the subscription-window denominator", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    pool.setRollingTokens("credential/codex/dev", 4_000_000);
    const result = await recorder.record(
      { ...context, cli: "codex", model: "gpt-codex", authRef: "credential/codex/dev" },
      { inputTokens: 1_000, outputTokens: 500, cachedTokens: 0 },
      { stream: "test" }
    );
    expect(result.costSource).toBe("codexbar");
    expect(result.pricingMode).toBe("subscription_window");
    expect(pool.denominatorUpserts).toHaveLength(1);
    expect(pool.denominatorUpserts[0]).toEqual({ authRef: "credential/codex/dev", observed: 4_000_000 });
    expect(result.observedMaxMonthlyTokens).toBe(4_000_000);
  });

  it("refines the denominator to at least the current row's tokens when no history exists", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    await recorder.record(
      { ...context, cli: "codex", model: "gpt-codex", authRef: "credential/codex/fresh" },
      { inputTokens: 200, outputTokens: 100, cachedTokens: 0 },
      {}
    );
    expect(pool.denominatorUpserts).toEqual([{ authRef: "credential/codex/fresh", observed: 300 }]);
  });

  it("persists opportunity_computed when given a self-hosted ref + runtime", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    const result = await recorder.record(
      { ...context, cli: "fake", model: "qwen", authRef: "credential/self-hosted/qwen", runtimeSeconds: 60 },
      { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      {}
    );
    expect(result.costSource).toBe("opportunity_computed");
    expect(result.pricingMode).toBe("opportunity_cost");
    expect(pool.denominatorUpserts).toEqual([]);
  });

  it("throws CostUnattributableError and emits cost.unattributable when the ref is unknown", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    await expect(
      recorder.record(
        { ...context, cli: "codex", model: "gpt", authRef: "vault/secret/dev/legacy" },
        { inputTokens: 12, outputTokens: 8, cachedTokens: 0 },
        {}
      )
    ).rejects.toThrow(CostUnattributableError);
    expect(events.events.map((event) => event.eventType)).toEqual(["cost.unattributable"]);
    expect(pool.inserts).toEqual([]);
  });

  it("never writes a placeholder cost_source to cost_records", async () => {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events);
    await recorder.record(
      { ...context, cli: "codex", model: "gpt-codex", authRef: "credential/codex/dev" },
      { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      {}
    );
    const serialized = pool.inserts.flatMap((insert) => insert.params.map((param) => (typeof param === "string" ? param : JSON.stringify(param))));
    expect(serialized.join("\n")).not.toContain(`${"legacy"}_${"unknown"}`);
    expect(serialized.join("\n")).not.toContain("unknown_source");
  });
});
