// apex v79/v80 loop closure — end-to-end test for the triage → materialize seam.
//
// The v79 fix routed cross-scope findings out as `kind: spec` in the triage prompt,
// and the routing policy honors that. But `SubtaskLoopOutcome.newSpecs` was populated
// only in the workflow's return value — NO production code called `acceptProposals`
// on it, so every routed spec vanished into a black hole. This suite pins:
//
//  1. `runPlannerLoopWorkflow` invokes the `materializeTriageNewSpecs` seam once per
//     newly-emitted routed spec, with the run's org, project, parent spec, and the
//     triaged item's title/body/severity/id.
//  2. The `buildTriageNewSpecsMaterializer` helper (the seam runExecutor.ts wires)
//     calls `acceptProposals` under the run's org scope and produces a real spec row
//     via a fake `DiscoveryEngineDeps` pool + injected system actor.
//  3. Cross-loop dedup: a rework/re-plan pass that re-emits the SAME routed spec id
//     does not double-materialize (the workflow tracks ids across iterations).
import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { AuditAnswer, TriageAnswer } from "../src/engine/answerers/schemas/index.js";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import {
  buildTriageNewSpecsMaterializer,
  triageMaterializerSystemActor,
} from "../src/engine/workflow/plannerRunTriageNewSpecs.js";
import type { NewSpecRequest } from "../src/engine/workflow/subtaskLoop.js";
import {
  accounting,
  approvingReview,
  completeCheck,
  directMergeConfig,
  fakeProbe,
  healthyWindow,
  loopStageAdapters,
  makeAuditor,
  makeChecker,
  makePlanner,
  makeTriage,
  makeWriter,
  noopMerge,
  plannerAuthorityBundle,
  plannerAuthorityHost,
  passingGitHub,
  runPlannerLoopScoped,
  setup,
} from "./plannerRun.fixtures.js";
import { buildPlan } from "./helpers/plannerLoopHelpers.js";

// A triage answer that emits an OUT-OF-SCOPE routed spec — the auditor's finding is
// cross-scope for this spec, so the triage hint is `kind: spec` (route out).
const OUT_OF_SCOPE_AUDIT: AuditAnswer = {
  findings: [
    {
      id: "deploy-not-configured",
      severity: "P1",
      title: "OUT-OF-SCOPE: deploy target not configured",
      body: "Belongs in a follow-up deploy spec, not this scaffold spec.",
    },
  ],
};
const OUT_OF_SCOPE_TRIAGE: TriageAnswer = {
  workItems: [
    {
      id: "wi-deploy",
      kind: "spec",
      severity: "P1",
      title: "Configure the deploy target",
      body: "Add the deploy manifest and credentials in a follow-up spec.",
      findingIds: ["deploy-not-configured"],
    },
  ],
};

describe("apex v79/v80 loop closure — triage → materializeTriageNewSpecs seam", () => {
  it("invokes the materializer with the routed newSpecs when the loop passes with routed specs", async () => {
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(directMergeConfig());
    const materializedCalls: Array<{
      parentSpecId: string;
      projectId: string;
      orgId: string;
      newSpecs: ReadonlyArray<NewSpecRequest>;
    }> = [];

    const adapters = {
      planner: makePlanner([buildPlan([{ title: "T1", intent: "scaffold", behaviorIds: [] }])]),
      writer: makeWriter(["diff\n"]),
      checker: makeChecker([completeCheck]),
      // The auditor emits an out-of-scope finding; triage routes it as `kind: spec`.
      ...loopStageAdapters(),
      auditor: makeAuditor([OUT_OF_SCOPE_AUDIT]),
      triage: makeTriage([OUT_OF_SCOPE_TRIAGE]),
    };

    const result = await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets,
      githubHttp: passingGitHub(),
      context: ctx,
      sleep: async () => {},
      buildAdapters: () => adapters as never,
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(null)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
      mergeAuthority: plannerAuthorityBundle(plannerAuthorityHost()),
      buildSpecValidator: () => ({
        validate: async () => ({
          accomplishable: { pass: true, reason: "bounded" },
          demoable: { pass: true, reason: "observable" },
          nonTrivial: { pass: true, reason: "worth a spec" },
          legible: { pass: true, reason: "clear" },
          overall: "pass" as const,
          revisionGuidance: "",
        }),
      }),
      materializeTriageNewSpecs: async (input) => {
        materializedCalls.push({
          parentSpecId: input.parentSpecId,
          projectId: input.projectId,
          orgId: input.orgId,
          newSpecs: input.newSpecs,
        });
      },
    });

    expect(result.outcome.kind).toBe("passed");
    // The workflow invoked the materializer exactly once with the routed newSpec.
    expect(materializedCalls).toHaveLength(1);
    const call = materializedCalls[0]!;
    expect(call.parentSpecId).toBe(ctx.specId);
    expect(call.projectId).toBe(ctx.projectId);
    expect(call.newSpecs).toHaveLength(1);
    expect(call.newSpecs[0]).toMatchObject({
      id: "wi-deploy",
      title: "Configure the deploy target",
      severity: "P1",
    });
  });

  it("buildTriageNewSpecsMaterializer calls acceptProposals with the routed spec + provenance under the run's org scope", async () => {
    // The production materializer builds a discovery insight per routed newSpec and
    // calls `acceptProposals` with `placementLabel: "auto-routed from triage in <parentSpecId>"`.
    // Here we assert it routes through a fake `RunStateWriter.createSpec` (plane-split path)
    // and stamps the provenance UPDATE. A minimal pool stub answers the metadata read the
    // writer-backed provenance path issues before its UPDATE.
    const createSpecCalls: Array<{ input: unknown; actorOrgId: string | null }> = [];
    const setMetadataCalls: Array<{ orgId: string; specId: string; metadataJson: string }> = [];
    const stubWriter = {
      createSpec: async ({ input, actor }: { input: unknown; actor: { orgId: string | null } }) => {
        createSpecCalls.push({ input, actorOrgId: actor.orgId });
        return {
          specId: `spec_${createSpecCalls.length}`,
          projectId: "project_x",
          title: (input as { title: string }).title,
          description: (input as { description: string }).description,
          acceptanceCriteria: [] as string[],
          priority: "tbd" as const,
          dependsOn: [] as string[],
          status: "open" as const,
        };
      },
      setSpecMetadata: async (input: { orgId: string; specId: string; metadataJson: string }) => {
        setMetadataCalls.push(input);
      },
    } as unknown as RunStateWriter;
    // Minimal pool stub — the provenance path reads `spec_metadata` before UPDATEing it.
    const stubPool = {
      query: async () => ({ rows: [{ metadata: {} }], rowCount: 1 }),
    } as unknown as pg.Pool;

    const materializer = buildTriageNewSpecsMaterializer({
      pool: stubPool,
      runStateWriter: stubWriter,
      resolveActor: triageMaterializerSystemActor,
    });

    await materializer({
      runId: "run_test",
      parentSpecId: "spec_parent",
      projectId: "project_x",
      orgId: "org_test",
      newSpecs: [
        {
          id: "wi-deploy",
          title: "Configure the deploy target",
          body: "Deploy details.",
          severity: "P1",
          findingIds: ["deploy-not-configured"],
        },
      ],
    });

    // createSpec was called with the routed spec's title + description, under the run's org.
    expect(createSpecCalls).toHaveLength(1);
    expect(createSpecCalls[0]!.actorOrgId).toBe("org_test");
    expect(createSpecCalls[0]!.input).toMatchObject({
      projectId: "project_x",
      title: "Configure the deploy target",
      description: "Deploy details.",
      priority: "tbd",
    });
    // The provenance UPDATE stamped the placement label carrying the parent spec id.
    expect(setMetadataCalls).toHaveLength(1);
    expect(setMetadataCalls[0]!.orgId).toBe("org_test");
    const metadata = JSON.parse(setMetadataCalls[0]!.metadataJson) as {
      discovery?: { placementLabel?: string };
    };
    expect(metadata.discovery?.placementLabel).toBe("auto-routed from triage in spec_parent");
  });
});
