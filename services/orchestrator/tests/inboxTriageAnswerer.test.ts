// Deterministic triage answerer behavior tests (mutation ratchet).
//
// Pins the observable verdict/dedupe/match/placement/variant the deterministic
// `TriageAnswerer` produces for each branch of its grounded heuristic: the
// auto-route system path, the token-overlap dedupe-vs-in-flight-vs-fresh ladder
// (including the >=2 overlap threshold and the stop-word filter), and the
// severity->discoveryVariant mapping. The sibling candidateInbox.test.ts touches
// the headline branches; this file pins the boundaries the mutants exploit.

import { describe, expect, it } from "vitest";
import { createDeterministicTriageAnswerer } from "../src/engine/forge/inbox/index.js";
import type { InboxSource, TriageAnswererContext } from "../src/engine/forge/inbox/index.js";

const issuesSource: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "",
  config: {},
  enabled: true,
  autoRoute: false,
};

const answerer = createDeterministicTriageAnswerer();

function ctx(
  over: Partial<TriageAnswererContext> & { candidate?: Partial<TriageAnswererContext["candidate"]> },
): TriageAnswererContext {
  return {
    candidate: {
      title: "csv export reports dashboard",
      body: "",
      severity: "info",
      sourceKind: "issues",
      projectId: "project_a",
      ...over.candidate,
    },
    source: over.source ?? issuesSource,
    existingSpecs: over.existingSpecs ?? [],
  };
}

describe("triage answerer — system / auto-route path", () => {
  it("auto-routes when the source kind is system, regardless of autoRoute flag", async () => {
    const t = await answerer.triage(ctx({ source: { ...issuesSource, kind: "system", autoRoute: false } }));
    expect(t.verdict).toBe("auto_routable");
    expect(t.placement).toBe("auto → project_a · queued");
    expect(t.dedupe).toBe("no match · audit finding");
    expect(t.match).toContain("audit-spec-able");
  });

  it("auto-routes when the source kind is scheduled_audit", async () => {
    const t = await answerer.triage(ctx({ source: { ...issuesSource, kind: "scheduled_audit" } }));
    expect(t.verdict).toBe("auto_routable");
  });

  it("auto-routes when autoRoute is set even on a non-system kind", async () => {
    const t = await answerer.triage(ctx({ source: { ...issuesSource, kind: "issues", autoRoute: true } }));
    expect(t.verdict).toBe("auto_routable");
  });

  it("uses the literal 'project' fallback in the auto placement when there is no project id", async () => {
    const t = await answerer.triage(
      ctx({ source: { ...issuesSource, kind: "system" }, candidate: { projectId: null } }),
    );
    expect(t.placement).toBe("auto → project · queued");
  });

  it("auto-route variant follows severity: fail->bug, else feature", async () => {
    const bug = await answerer.triage(
      ctx({ source: { ...issuesSource, kind: "system" }, candidate: { severity: "fail" } }),
    );
    expect(bug.discoveryVariant).toBe("bug");
    const feat = await answerer.triage(
      ctx({ source: { ...issuesSource, kind: "system" }, candidate: { severity: "warn" } }),
    );
    expect(feat.discoveryVariant).toBe("feature");
  });
});

describe("triage answerer — dedupe / in-flight / fresh ladder", () => {
  it("closes as duplicate against a done OR merged spec and captures its id", async () => {
    for (const status of ["done", "merged", "MERGED"]) {
      const t = await answerer.triage(
        ctx({
          candidate: { title: "csv export reports", body: "" },
          existingSpecs: [{ specId: "spec_dup", title: "csv export reports view", status }],
        }),
      );
      expect(t.verdict).toBe("dedupe_close");
      expect(t.duplicateOfSpecId).toBe("spec_dup");
      expect(t.dedupe).toBe("duplicate of spec_dup (csv export reports view) · shipped");
      expect(t.match).toBe("already merged");
      expect(t.placement).toBe("forge recommends closing as done");
    }
  });

  it("folds a match against an in_flight/live/active spec into the live run with no duplicate id", async () => {
    for (const status of ["in_flight", "live", "active"]) {
      const t = await answerer.triage(
        ctx({
          candidate: { title: "orders pagination cursor list", severity: "fail" },
          existingSpecs: [{ specId: "spec_if", title: "orders pagination cursor view", status }],
        }),
      );
      expect(t.verdict).toBe("needs_call");
      expect(t.dedupe).toBe("no match");
      expect(t.match).toBe("touches in-flight spec_if");
      expect(t.placement).toBe("forge suggests folding into the live run");
      expect(t.duplicateOfSpecId).toBeNull();
      // fail severity → bug
      expect(t.discoveryVariant).toBe("bug");
    }
  });

  it("an in-flight match on a non-fail candidate yields the feature discovery variant", async () => {
    const t = await answerer.triage(
      ctx({
        candidate: { title: "orders pagination cursor list", severity: "warn" },
        existingSpecs: [{ specId: "spec_if", title: "orders pagination cursor view", status: "in_flight" }],
      }),
    );
    expect(t.match).toBe("touches in-flight spec_if");
    // non-fail → feature
    expect(t.discoveryVariant).toBe("feature");
  });

  it("requires a token overlap of at least 2 — a single shared non-stop-word does not match", async () => {
    // "export" overlaps; "reports"/"csv"/"dashboard" do not. One overlap < 2.
    const t = await answerer.triage(
      ctx({
        candidate: { title: "csv export", body: "" },
        existingSpecs: [{ specId: "spec_x", title: "export billing invoices", status: "merged" }],
      }),
    );
    // Below threshold → falls through to a fresh needs_call, NOT dedupe_close.
    expect(t.verdict).toBe("needs_call");
    expect(t.dedupe).toBe("no match");
  });

  it("treats a >=2 overlap with a non-terminal status as a partial-overlap fresh candidate", async () => {
    const t = await answerer.triage(
      ctx({
        candidate: { title: "csv export reports", body: "" },
        existingSpecs: [{ specId: "spec_p", title: "csv export reports backlog", status: "backlog" }],
      }),
    );
    expect(t.verdict).toBe("needs_call");
    expect(t.dedupe).toBe("partial overlap with spec_p");
  });

  it("ignores stopwords (e.g. 'the'/'for'/'bug') when scoring overlap", async () => {
    // Only stopwords overlap → no real overlap → fresh, "no match".
    const t = await answerer.triage(
      ctx({
        candidate: { title: "the bug for issue", body: "" },
        existingSpecs: [{ specId: "spec_s", title: "the bug for feature", status: "merged" }],
      }),
    );
    expect(t.verdict).toBe("needs_call");
    expect(t.dedupe).toBe("no match");
  });

  it("a fresh candidate proposes a new spec with a placement-is-your-call note", async () => {
    const t = await answerer.triage(ctx({ candidate: { severity: "info" } }));
    expect(t.verdict).toBe("needs_call");
    expect(t.match).toBe("new behavior");
    expect(t.placement).toContain("placement is your call");
  });

  it("a fresh fail candidate flags hardening and a bug variant", async () => {
    const t = await answerer.triage(ctx({ candidate: { severity: "fail" } }));
    expect(t.match).toBe("new behavior · hardening");
    expect(t.discoveryVariant).toBe("bug");
  });

  it("scores body tokens too, not just the title", async () => {
    // Title shares nothing; body carries the overlapping tokens.
    const t = await answerer.triage(
      ctx({
        candidate: { title: "misc", body: "orders pagination cursor handling" },
        existingSpecs: [{ specId: "spec_b", title: "orders pagination cursor", status: "merged" }],
      }),
    );
    expect(t.verdict).toBe("dedupe_close");
    expect(t.duplicateOfSpecId).toBe("spec_b");
  });
});
