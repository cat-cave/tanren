// The production default factory for the intent-preserving conflict resolver
// (autonomy-engine.md §2b). `buildDefaultConflictResolver` assembles the real
// resolver from the run's already-resolved context — the same shape the run loop
// already has at the merge stage (the runner target, the workspace, the
// gate/checker/auditor it built, the project routing, the run's spec intent) —
// and returns the `ConflictResolverHook` the merge dispatcher's `resolveConflict`
// slot receives in PLACE OF `noopConflictResolver`. This is the §8a stub removal:
// the production default is now the REAL resolver, resolved from the project's
// routing table like every other Answerer.

import type { CheckAnswer, AuditAnswer, ConflictAnswer } from "../../../answerers/schemas/index.js";
import type { RunnerHandle } from "../../../contracts/allocator.js";
import type { RunStateWriter } from "../../../contracts/runStateWriter.js";
import type { CommandSubstrate } from "../../../contracts/commandSubstrate.js";
import type { WorkspaceConflictApplier } from "../../../contracts/conflictResolution.js";
import type { QueryClient } from "../../../data/orgScopedDb.js";
import type { EventStore } from "../../../eventStore.js";
import { buildConflictResolverAdapter } from "../../../providers/adapterSelector.js";
import type { AnswererAdapter } from "../../../providers/types.js";
import type { RoutingTable } from "../../../config/shared.js";
import type { SecretStore } from "../../../contracts/secretStore.js";
import type { SpecMode } from "../../../state/spec.js";
import type { ConflictResolverHook } from "../mergeDispatchTypes.js";
import type { GateOutcome } from "../../gate/index.js";
import type { CiWhen } from "../../../ci/index.js";
import { AnswererBackedConflictInvoker } from "./answerer.js";
import { PgConflictProvenanceReader } from "./provenance.js";
import { PgProductVisionReader } from "./productVision.js";
import { RunPathResolvedTreeReGate } from "./reGate.js";
import { SpecStatusReplanRouter } from "./replanRouter.js";
import { SpecStatusGateReworkRouter } from "./gateReworkRouter.js";
import { buildPriorGateReworkReader, buildPriorReplanReader, buildReplanEnqueuer } from "./replanEnqueuerPg.js";
import { buildIntentPreservingConflictResolver, type EntityMergeFirstPassHook } from "./resolver.js";

export interface DefaultConflictResolverDeps {
  pool: QueryClient;
  /**
   * REQUIRED (audit D-R3.2 sweep): the writer is the single way to write under the
   * de-privileged data plane. PR #714 made the writer-undefined fallback unreachable
   * in production.
   */
  runStateWriter: RunStateWriter;
  eventStore: EventStore;
  ssh: CommandSubstrate;
  secrets: SecretStore;
  target: RunnerHandle;
  workspacePath: string;
  baseSha: string;
  runId: string;
  // The run's spec + project + org + intent (the MERGING spec).
  projectId: string;
  /** REQUIRED tenant key (v68 fix). The resolver's eventStore.append + the routers'
   * spec writes all stamp this directly rather than re-derive via a SELECT-join. */
  orgId: string;
  specId: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  /**
   * The merging spec's writer-prompt MODE (task #86). Threaded through to the re-gate's
   * checker + auditor so the seeded-mode tail block is emitted on `specialize_seed`
   * specs (the same agreement the in-loop checker/auditor honor). Absent ⇒ legacy
   * byte-shape.
   */
  specMode?: SpecMode;
  /**
   * The PR number for the gate-rework routing event (the observable
   * `merge.regate.gate_rework_routed`). The base-shift dependent has no real PR handle
   * (the rebase is over a runner-local workspace) — it defaults to 0, like the resolver's
   * own `prNumber: 0` for that path. The in-loop `direct_merge` path passes the real number.
   */
  prNumber?: number;
  endpointBaseUrl?: string;
  // The project routing (the conflict Answerer rides the `audit` chain head) and
  // the run's already-built checker/auditor adapters (the re-gate reuses them).
  routing: RoutingTable;
  checker: AnswererAdapter<CheckAnswer>;
  auditor: AnswererAdapter<AuditAnswer>;
  runGate: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  // present when this run is a change-percolation re-execution — reframes the
  // resolver into upstream-change mode (the ancestor's change flows INTO this spec).
  upstreamChange?: { ancestorSpecId: string; changeSummary: string };
  /**
   * The workspace mechanism the resolver gathers/applies/publishes the conflict over —
   * the jj `JjWorkspaceConflictApplier` the two live wiring sites build (the in-loop
   * `direct_merge` resolver + the drive-pass resolver), each over a freshly-provisioned
   * live jj workspace. `rebaseOnto` RECORDS the conflict (fail-closed); the resolver's
   * classify-then-escalate / re-gate / replan logic above it is mechanism-agnostic.
   */
  applier: WorkspaceConflictApplier;
  /**
   * §3.2 the deterministic entity-merge FIRST-PASS (optional). The base-shift conflict
   * path (`baseShiftLiveResolve.ts`) builds it over the SAME live jj workspace — it reads
   * the three conflict terms marker-free and runs `sem` for the entity-level diff. Absent
   * ⇒ the resolver runs the agent on every conflict, exactly as before §3.2.
   */
  entityFirstPass?: EntityMergeFirstPassHook;
}

export function buildDefaultConflictResolver(deps: DefaultConflictResolverDeps): ConflictResolverHook {
  const conflictAdapter: AnswererAdapter<ConflictAnswer> = buildConflictResolverAdapter(
    {
      secrets: deps.secrets,
      ssh: deps.ssh,
      target: deps.target,
      runId: deps.runId,
      ...(deps.endpointBaseUrl !== undefined && { endpointBaseUrl: deps.endpointBaseUrl }),
    },
    deps.routing,
  );

  return buildIntentPreservingConflictResolver({
    projectId: deps.projectId,
    orgId: deps.orgId,
    mergingSpecIntent: {
      specId: deps.specId,
      title: deps.specTitle,
      description: deps.specDescription,
      acceptanceCriteria: deps.acceptanceCriteria,
    },
    eventStore: deps.eventStore,
    provenance: new PgConflictProvenanceReader(deps.pool),
    // The product-vision reader rides the run's already org-scoped client (the
    // same `deps.pool` the provenance reader uses) + the resolved org. It loads
    // the personas / persona-behaviors / design-DNA the Answerer frames the
    // resolution against AND judges a genuine product-intent clash on — uniform
    // across BOTH merge paths (this in-loop `direct_merge` path + the drive path,
    // which calls this same factory). A run with no resolved org or an empty
    // product yields an empty vision the prompt omits (a real empty state).
    productVision: new PgProductVisionReader({
      client: deps.pool,
      orgId: deps.orgId,
    }),
    // The workspace mechanism: the jj applier the live wiring sites build.
    applier: deps.applier,
    // §3.2 the deterministic entity-merge first-pass (optional; the base-shift path builds it).
    ...(deps.entityFirstPass !== undefined && { entityFirstPass: deps.entityFirstPass }),
    answerer: new AnswererBackedConflictInvoker({
      adapter: conflictAdapter,
      workspace: deps.workspacePath,
    }),
    reGate: new RunPathResolvedTreeReGate({
      workspacePath: deps.workspacePath,
      runGate: deps.runGate,
      checker: deps.checker,
      auditor: deps.auditor,
      specTitle: deps.specTitle,
      specDescription: deps.specDescription,
      acceptanceCriteria: deps.acceptanceCriteria,
      baseSha: deps.baseSha,
      // Task #86: thread the spec mode so the re-gate's checker/auditor see the seeded-
      // mode tail block on `specialize_seed` specs.
      ...(deps.specMode !== undefined && { specMode: deps.specMode }),
    }),
    // v35 NEVER-STALL: the replan router ENQUEUES a fresh re-plan run + emits the
    // observable `recovery.replan_queued` (carrying the replanRunId) + is BOUNDED by the
    // prior-replan count — so a routed replan ACTUALLY RUNS, never strands the spec
    // `in_flight` with no live run. Uniform across BOTH replan routes (this drive/in-loop
    // path + the base-shift coordinator's `recordReplanContext`).
    replan: new SpecStatusReplanRouter({
      orgId: deps.orgId,
      runId: deps.runId,
      projectId: deps.projectId,
      // The enqueuer is writer-only (no pool). The prior-replan reader accepts
      // QueryClient and resolves a real Pool via the system pool / isPool narrow
      // — no `as pg.Pool` cast at the workflow seam.
      enqueuer: buildReplanEnqueuer(deps.pool, deps.runStateWriter),
      priorReplans: buildPriorReplanReader(deps.pool),
    }),
    // v35 RE-GATE GATE-FAIL → WRITER REWORK: a re-gate that fails a deterministic GATE TIER
    // on a CLEANLY-rebased-or-resolved tree (no merge conflict) is the WRITER's to fix on the
    // new base — route it to rework carrying the gate error as steering (the SAME
    // never-discard re-author the batch-gate path uses), NEVER `merge.conflict.irreconcilable`
    // / escalate. Escalation is owned by the convergence detector (a fixed point, no count).
    // Uniform across BOTH merge paths (this in-loop `direct_merge` path + the base-shift path,
    // which calls this same factory).
    gateRework: new SpecStatusGateReworkRouter({
      orgId: deps.orgId,
      runId: deps.runId,
      projectId: deps.projectId,
      prNumber: deps.prNumber ?? 0,
      enqueuer: buildReplanEnqueuer(deps.pool, deps.runStateWriter),
      priorReworks: buildPriorGateReworkReader(deps.pool),
    }),
    ...(deps.upstreamChange !== undefined && { upstreamChange: deps.upstreamChange }),
  });
}

export { buildIntentPreservingConflictResolver } from "./resolver.js";
export type { IntentPreservingResolverDeps } from "./resolver.js";
export type { ConflictResolverHook } from "../mergeDispatchTypes.js";
export { atReplanFixedPoint, conflictSignatureOf } from "./replanRouter.js";
