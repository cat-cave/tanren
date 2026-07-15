// gv-4: decode + visible UI proof for the stack-retarget safety surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeStackRetargetView, type StackRetargetView } from "../src/api/stackRetarget.js";
import { build, mockOrchestrator, RUN_ID } from "./runDetail.render.fixtures.js";

function sampleView(overrides: Partial<StackRetargetView> = {}): StackRetargetView {
  return {
    missionNodeId: "gv-4",
    runId: "run_1",
    projectId: "proj_1",
    orgId: "org_acme",
    speculative: true,
    defaultBranch: "main",
    members: [
      {
        specId: "spec_a",
        runId: "run_a",
        branch: "tanren/run_a",
        headSha: "a".repeat(40),
        merged: true,
      },
      {
        specId: "spec_b",
        runId: "run_b",
        branch: "tanren/run_b",
        headSha: "b".repeat(40),
        merged: false,
      },
    ],
    mergedSpecIds: ["spec_a"],
    unmergedAncestors: ["spec_b"],
    toBase: "tanren/run_b",
    remainingStack: [
      {
        specId: "spec_b",
        runId: "run_b",
        branch: "tanren/run_b",
        headSha: "b".repeat(40),
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decodeStackRetargetView", () => {
  it("accepts a strict gv-4 body", () => {
    const decoded = decodeStackRetargetView(sampleView());
    expect(decoded?.toBase).toBe("tanren/run_b");
    expect(decoded?.missionNodeId).toBe("gv-4");
  });

  it("rejects wrong mission node", () => {
    expect(decodeStackRetargetView({ ...sampleView(), missionNodeId: "mq-1" })).toBeUndefined();
  });

  it("rejects missing toBase", () => {
    const bad = { ...sampleView() } as Record<string, unknown>;
    delete bad.toBase;
    expect(decodeStackRetargetView(bad)).toBeUndefined();
  });
});

describe("StackRetargetPanel on run detail (visible UI)", () => {
  it("renders walk target + merged/unmerged members from the production route", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request(`/runs/${RUN_ID}`)).text();
    expect(html).toContain('data-gv4="panel"');
    expect(html).toContain("stack retarget (gv-4)");
    expect(html).toContain('data-gv4="to-base"');
    expect(html).toContain("tanren/run_b");
    expect(html).toContain('data-gv4-merged="true"');
    expect(html).toContain('data-gv4-merged="false"');
    expect(html).toContain("held on 1 unmerged ancestor");
    // Walk target must not be a merged transitive ancestor when an unmerged tip remains.
    expect(html).not.toMatch(/data-gv4="to-base"[^>]*>\s*tanren\/run_a\s*</u);
  });
});
