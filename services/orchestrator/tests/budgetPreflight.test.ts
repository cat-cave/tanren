// BUDGET-SAFETY (M6): the run-setup budget-ceiling reachability preflight. A
// configured DOLLAR ceiling against a subscription/self-hosted credential with no
// usage probe is structurally UNREACHABLE — it must be surfaced LOUDLY (a
// cost.ceiling_unreachable event) and fail the run setup, never silently configured.
import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";
import { assertBudgetCeilingReachable, UnreachableBudgetCeilingError } from "../src/engine/workflow/budgetPreflight.js";

interface Captured {
  eventType: EventName;
  payload: EventPayload<EventName>;
}

function recorder(): { append: AppendEvent; events: Captured[] } {
  const events: Captured[] = [];
  const append: AppendEvent = async (eventType, payload) => {
    events.push({ eventType, payload });
  };
  return { append, events };
}

describe("assertBudgetCeilingReachable (BUDGET-SAFETY M6)", () => {
  it("FAILS LOUD: a ceiling against a subscription credential with NO usage probe is unreachable", async () => {
    const r = recorder();
    await expect(
      assertBudgetCeilingReachable({ ceilingUsd: 50, authRef: "credential/codex/pro", hasUsageProbe: false }, r.append),
    ).rejects.toBeInstanceOf(UnreachableBudgetCeilingError);
    // A loud, secret-free event is emitted BEFORE the throw.
    expect(r.events.map((e) => e.eventType)).toEqual(["cost.ceiling_unreachable"]);
    expect(r.events[0]?.payload).toMatchObject({ refKind: "credential/codex", billingMode: "subscription" });
  });

  it("FAILS LOUD for a self-hosted credential with no usage probe too", async () => {
    const r = recorder();
    await expect(
      assertBudgetCeilingReachable(
        { ceilingUsd: 10, authRef: "credential/self-hosted/qwen", hasUsageProbe: false },
        r.append,
      ),
    ).rejects.toBeInstanceOf(UnreachableBudgetCeilingError);
    expect(r.events[0]?.payload).toMatchObject({ billingMode: "self_hosted" });
  });

  it("is a NO-OP when a usage probe IS wired (the subscription ceiling becomes reachable)", async () => {
    const r = recorder();
    await assertBudgetCeilingReachable(
      { ceilingUsd: 50, authRef: "credential/codex/pro", hasUsageProbe: true },
      r.append,
    );
    expect(r.events).toEqual([]);
  });

  it("is a NO-OP for a per-token credential (it accrues dollars on every call)", async () => {
    const r = recorder();
    await assertBudgetCeilingReachable(
      { ceilingUsd: 50, authRef: "credential/anthropic/prod", hasUsageProbe: false },
      r.append,
    );
    expect(r.events).toEqual([]);
  });

  it("is a NO-OP when no ceiling is configured (unlimited — today's behavior)", async () => {
    const r = recorder();
    await assertBudgetCeilingReachable(
      { ceilingUsd: undefined, authRef: "credential/codex/pro", hasUsageProbe: false },
      r.append,
    );
    expect(r.events).toEqual([]);
  });

  it("NEVER leaks the secret value — only the ref KIND is in the event", async () => {
    const r = recorder();
    await expect(
      assertBudgetCeilingReachable(
        { ceilingUsd: 50, authRef: "credential/self-hosted/super-secret-endpoint", hasUsageProbe: false },
        r.append,
      ),
    ).rejects.toBeInstanceOf(UnreachableBudgetCeilingError);
    expect(JSON.stringify(r.events[0]?.payload)).not.toContain("super-secret-endpoint");
  });
});
