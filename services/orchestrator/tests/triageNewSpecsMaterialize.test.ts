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
  nativeQueueConfig,
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
    const { ctx, pool, events, secrets, allocator, ssh } = await setup(nativeQueueConfig());
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
    // Minimal pool stub — Codex round-3 #4 the dedupe read runs under org scope
    // (a `runWithOrgScope` client) BEFORE `acceptProposals`, and returns zero rows
    // (no prior routed spec on this trail) so materialization proceeds. The
    // provenance path then reads `spec_metadata` off the raw pool before UPDATEing.
    const stubPool = {
      query: async () => ({ rows: [{ metadata: {} }], rowCount: 1 }),
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("SET")) {
            return { rows: [], rowCount: 0 };
          }
          // The dedupe SELECT — no rows means "no prior routed spec, proceed".
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
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

/** Build a pool stub whose SELECT returns `existingRows` for the dedupe read, and answers
 * other queries (`spec_metadata` read + `SET/BEGIN/COMMIT`) with neutral defaults. Tracks
 * the SELECT-query arg list so a test can assert the canonicalization applied (sorted
 * `source_finding_ids`). */
function buildDedupePool(existingRows: Array<{ spec_id: string }>) {
  const selectArgs: Array<ReadonlyArray<unknown>> = [];
  const pool = {
    query: async () => ({ rows: [{ metadata: {} }], rowCount: 1 }),
    connect: async () => ({
      query: async (sql: string, args?: ReadonlyArray<unknown>) => {
        if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("SET")) {
          return { rows: [], rowCount: 0 };
        }
        selectArgs.push(args ?? []);
        return { rows: existingRows, rowCount: existingRows.length };
      },
      release: () => {},
    }),
  } as unknown as pg.Pool;
  return { pool, selectArgs };
}

function stubWriterForCreate(createSpecCalls: Array<{ input: unknown; actorOrgId: string | null }>): RunStateWriter {
  return {
    createSpec: async ({ input, actor }: { input: unknown; actor: { orgId: string | null } }) => {
      createSpecCalls.push({ input, actorOrgId: actor.orgId });
      return {
        specId: `spec_new_${createSpecCalls.length}`,
        projectId: "project_x",
        title: (input as { title: string }).title,
        description: (input as { description: string }).description,
        acceptanceCriteria: [] as string[],
        priority: "tbd" as const,
        dependsOn: [] as string[],
        status: "open" as const,
      };
    },
    setSpecMetadata: async (_input: { orgId: string; specId: string; metadataJson: string }) => {},
  } as unknown as RunStateWriter;
}

// Codex round-3 #4 — the re-drive dedupe TEETH. `materializedNewSpecIds` in
// `plannerRun.ts` is per-run in-memory; a re-drive after a halt/fix/rebuild starts
// with an empty tracker. Without this dedupe, the SAME triage-routed finding on
// the SAME parent spec would materialize a fresh duplicate spec on every run. The
// dedupe queries by the persisted provenance trail before calling `acceptProposals`.
describe("Codex round-3 #4 — cross-run dedupe via persisted provenance trail", () => {
  it("skips acceptProposals when a spec with the same (project, parent, sourceFindingIds) already exists", async () => {
    // Simulate a re-drive: the prior run already materialized this routed spec, so
    // the dedupe SELECT finds a row. The materializer MUST NOT call `createSpec` again.
    const createSpecCalls: Array<{ input: unknown; actorOrgId: string | null }> = [];
    const { pool } = buildDedupePool([{ spec_id: "spec_prior_routed" }]);
    const materializer = buildTriageNewSpecsMaterializer({
      pool,
      runStateWriter: stubWriterForCreate(createSpecCalls),
      resolveActor: triageMaterializerSystemActor,
    });

    await materializer({
      runId: "run_redrive",
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

    expect(createSpecCalls).toHaveLength(0);
  });

  it("proceeds cleanly on the first-time materialize when no matching prior spec exists", async () => {
    // Fresh trail — the dedupe SELECT returns no rows, so acceptProposals runs
    // normally. This pins that the dedupe is not a silent no-op on the clean path.
    const createSpecCalls: Array<{ input: unknown; actorOrgId: string | null }> = [];
    const { pool } = buildDedupePool([]);
    const materializer = buildTriageNewSpecsMaterializer({
      pool,
      runStateWriter: stubWriterForCreate(createSpecCalls),
      resolveActor: triageMaterializerSystemActor,
    });

    await materializer({
      runId: "run_first",
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

    expect(createSpecCalls).toHaveLength(1);
    expect(createSpecCalls[0]!.input).toMatchObject({ title: "Configure the deploy target" });
  });

  it("canonicalizes sourceFindingIds by sorting before querying + writing", async () => {
    // The routed spec's findingIds arrive UNSORTED. The dedupe SELECT + the
    // downstream createSpec MUST both key off the CANONICAL (sorted) form so the
    // `text[]` comparison + the partial unique index are stable across re-drives.
    const createSpecCalls: Array<{ input: unknown; actorOrgId: string | null }> = [];
    const { pool, selectArgs } = buildDedupePool([]);
    const materializer = buildTriageNewSpecsMaterializer({
      pool,
      runStateWriter: stubWriterForCreate(createSpecCalls),
      resolveActor: triageMaterializerSystemActor,
    });

    await materializer({
      runId: "run_first",
      parentSpecId: "spec_parent",
      projectId: "project_x",
      orgId: "org_test",
      newSpecs: [
        {
          id: "wi-multi",
          title: "Multi-finding routed spec",
          body: "Body.",
          severity: "P1",
          // Unsorted on purpose — the materializer canonicalizes before write/read.
          findingIds: ["z-finding", "a-finding", "m-finding"],
        },
      ],
    });

    // Assert the dedupe SELECT queried with sorted findingIds.
    expect(selectArgs).toHaveLength(1);
    expect(selectArgs[0]![2]).toEqual(["a-finding", "m-finding", "z-finding"]);
    // Assert the createSpec input carries the sorted findingIds through provenance.
    expect(createSpecCalls).toHaveLength(1);
    expect(createSpecCalls[0]!.input).toMatchObject({
      triageProvenance: {
        sourceFindingIds: ["a-finding", "m-finding", "z-finding"],
      },
    });
  });

  it("different sourceFindingIds on the same parent DO create separate specs (dedupe is provenance-keyed, not parent-keyed)", async () => {
    // Two routed specs off the SAME parent but distinct finding-id sets must both
    // materialize. The dedupe key is `(project, parent, source_finding_ids)`, so a
    // second finding set does not collide.
    const createSpecCalls: Array<{ input: unknown; actorOrgId: string | null }> = [];
    // No prior match for either finding set.
    const { pool } = buildDedupePool([]);
    const materializer = buildTriageNewSpecsMaterializer({
      pool,
      runStateWriter: stubWriterForCreate(createSpecCalls),
      resolveActor: triageMaterializerSystemActor,
    });

    await materializer({
      runId: "run_first",
      parentSpecId: "spec_parent",
      projectId: "project_x",
      orgId: "org_test",
      newSpecs: [
        {
          id: "wi-a",
          title: "Routed A",
          body: "A body",
          severity: "P1",
          findingIds: ["finding-a"],
        },
        {
          id: "wi-b",
          title: "Routed B",
          body: "B body",
          severity: "P2",
          findingIds: ["finding-b"],
        },
      ],
    });

    expect(createSpecCalls).toHaveLength(2);
    expect(createSpecCalls[0]!.input).toMatchObject({ title: "Routed A" });
    expect(createSpecCalls[1]!.input).toMatchObject({ title: "Routed B" });
  });
});
