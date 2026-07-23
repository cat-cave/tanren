// P8b — unit tests for the e2e harness/manifest verdict logic.
//
// These run under `just fast-check` (they are pure, no live stack/creds). They
// pin the gate's TEETH: the manifest is well-formed, and the artifact-assertion
// logic actually fails when a real artifact is missing/fake. The credentialed
// cases themselves (cases/**/*.e2e.ts) run only under `just e2e`.

import { describe, expect, it } from "vitest";
import { assertArtifact, type ArtifactEvidence } from "./artifacts.js";
import { collectProblems } from "./harness.js";
import { activeCases, caseById, e2eManifest, validateManifest, type E2eCase } from "./manifest.js";

function realRunEvidence(): ArtifactEvidence {
  return {
    run: {
      runId: "run_e2e_real",
      status: "done",
      outcome: "ok",
      prUrl: "https://github.com/cat-cave/tanren-fixture-easy/pull/7",
      costRecords: [
        { taskKind: "write", basis: "provider_response", billingMode: "per_token" },
        { taskKind: "check", basis: "unknown", billingMode: "subscription" },
        { taskKind: "audit", basis: "unknown", billingMode: "subscription" },
      ],
      doraDeploymentCount: 3,
    },
    pr: { merged: true, mergeCommitSha: "abc123def456", baseBranch: "main" },
    file: { path: "src/feature.ts", presentOnBase: true },
  };
}

describe("e2e manifest", () => {
  it("is well-formed (no duplicate ids, every case asserts on a real artifact)", () => {
    expect(validateManifest(e2eManifest)).toEqual([]);
  });

  it("ships the three tier proofs as the active cases", () => {
    const active = activeCases();
    expect(active.map((item) => item.id)).toEqual(["tier-proof-easy", "tier-proof-medium", "tier-proof-hard"]);
    for (const item of active) {
      expect(item.tier).toBeDefined();
      expect(item.artifacts.map((a) => a.kind)).toContain("merged_pr");
    }
  });

  it("declares the per-capability cases as planned placeholders", () => {
    const planned = e2eManifest.filter((item) => item.status === "planned");
    expect(planned.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "real-llm-ideation-dag",
        "walker-drives-multi-spec-dag",
        "intent-preserving-conflict",
        "issue-ingest-to-merged-spec",
      ]),
    );
    // The runtime behavior is no longer planned: it is a hermetic regression pin (audit §6.8), driven
    // in-process by services/orchestrator/tests/runtimeBehaviorE2eDriver.ts.
    expect(planned.map((item) => item.id)).not.toContain("runtime-behavior");
  });

  it("registers runtime behavior as a hermetic case (no longer planned; not a live tier proof)", () => {
    const runtimeBehavior = caseById("runtime-behavior");
    expect(runtimeBehavior?.status).toBe("hermetic");
    // A hermetic case carries no acceptance tier (it is in-process, not fixture-driven)
    // and is NOT one of the live active cases the credentialed gate runs.
    expect(runtimeBehavior?.tier).toBeUndefined();
    expect(activeCases().map((item) => item.id)).not.toContain("runtime-behavior");
    // It still declares a real proof surface (merged PRs + DORA + cost rows).
    expect(runtimeBehavior?.artifacts.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["merged_pr", "dora_projection", "cost_records"]),
    );
  });

  it("rejects a malformed manifest (duplicate id, no artifacts, wrong-status tier)", () => {
    const broken: E2eCase[] = [
      {
        id: "dup",
        capability: "x",
        status: "active",
        tier: "easy",
        surfaces: ["http_api"],
        artifacts: [{ kind: "merged_pr", describe: "x" }],
      },
      { id: "dup", capability: "x", status: "planned", surfaces: [], artifacts: [] },
    ];
    const problems = validateManifest(broken);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("duplicate case id: dup"),
        expect.stringContaining("at least one operator surface"),
        expect.stringContaining("at least one real persisted artifact"),
      ]),
    );
  });

  it("looks a case up by id", () => {
    expect(caseById("runtime-behavior")?.capability).toContain("runtime behavior");
    expect(caseById("does-not-exist")).toBeUndefined();
  });
});

describe("e2e artifact assertions (the gate's teeth)", () => {
  it("passes every declared artifact when the run is genuinely real", () => {
    const easy = caseById("tier-proof-easy");
    expect(easy).toBeDefined();
    expect(collectProblems(easy as E2eCase, realRunEvidence())).toEqual([]);
  });

  it("fails merged_pr when the PR is not actually merged on GitHub", () => {
    const evidence: ArtifactEvidence = {
      ...realRunEvidence(),
      pr: { merged: false, mergeCommitSha: null, baseBranch: "main" },
    };
    expect(assertArtifact("merged_pr", evidence)).toMatch(/not actually merged/u);
  });

  it("fails merged_pr when the persisted pr_url is missing/malformed", () => {
    const base = realRunEvidence();
    const evidence: ArtifactEvidence = { ...base, run: { ...base.run, prUrl: null } };
    expect(assertArtifact("merged_pr", evidence)).toMatch(/PR URL/u);
  });

  it("fails implemented_file when the file is not present on the base branch", () => {
    const base = realRunEvidence();
    const evidence: ArtifactEvidence = { ...base, file: { path: "src/feature.ts", presentOnBase: false } };
    expect(assertArtifact("implemented_file", evidence)).toMatch(/not present on the base branch/u);
  });

  it("fails cost_records when no real cost rows were persisted", () => {
    const base = realRunEvidence();
    const evidence: ArtifactEvidence = { ...base, run: { ...base.run, costRecords: [] } };
    expect(assertArtifact("cost_records", evidence)).toMatch(/no cost_records/u);
  });

  it("fails cost_records when a row is missing its billing_mode", () => {
    const base = realRunEvidence();
    const evidence: ArtifactEvidence = {
      ...base,
      run: { ...base.run, costRecords: [{ taskKind: "write", basis: "unknown", billingMode: "" }] },
    };
    expect(assertArtifact("cost_records", evidence)).toMatch(/billing_mode/u);
  });

  it("fails dora_projection when the merge did not accumulate into DORA", () => {
    const base = realRunEvidence();
    const evidence: ArtifactEvidence = { ...base, run: { ...base.run, doraDeploymentCount: 0 } };
    expect(assertArtifact("dora_projection", evidence)).toMatch(/DORA/u);
  });

  it("refuses an unwired capability artifact rather than passing it silently", () => {
    expect(assertArtifact("dag_spec", realRunEvidence())).toMatch(/no reader yet/u);
    expect(assertArtifact("ingested_issue", realRunEvidence())).toMatch(/no reader yet/u);
  });
});
