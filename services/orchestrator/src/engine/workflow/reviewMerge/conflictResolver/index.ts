// The production default factory for the intent-preserving conflict resolver
// (autonomy-engine.md §2b). `buildDefaultConflictResolver` assembles the real
// resolver from the run's already-resolved context — the same shape the run loop
// already has at the merge stage (the runner target, the workspace, the
// gate/checker/auditor it built, the project routing, the run's spec intent) —
// and returns the `ConflictResolverHook` the merge dispatcher's `resolveConflict`
// slot receives in PLACE OF `noopConflictResolver`. This is the §8a stub removal:
// the production default is now the REAL resolver, resolved from the project's
// routing table like every other Answerer.

import type pg from "pg";
import type { CheckAnswer, AuditAnswer, ConflictAnswer } from "../../../answerers/schemas/index.js";
import type { SshTarget } from "../../../contracts/allocator.js";
import type { RunStateWriter } from "../../../contracts/runStateWriter.js";
import type { SshSubstrate } from "../../../contracts/sshSubstrate.js";
import type { EventStore } from "../../../eventStore.js";
import { buildConflictResolverAdapter } from "../../../providers/adapterSelector.js";
import type { AnswererAdapter } from "../../../providers/types.js";
import type { RoutingTable } from "../../../config/shared.js";
import type { SecretStore } from "../../../contracts/secretStore.js";
import type { ConflictResolverHook } from "../mergeDispatchTypes.js";
import type { GateOutcome } from "../../gate/index.js";
import type { CiWhen } from "../../../ci/index.js";
import { AnswererBackedConflictInvoker } from "./answerer.js";
import { PgConflictProvenanceReader } from "./provenance.js";
import { RunPathResolvedTreeReGate } from "./reGate.js";
import { SpecStatusReplanRouter } from "./replanRouter.js";
import { SshWorkspaceConflictApplier } from "./workspaceApplier.js";
import { buildIntentPreservingConflictResolver } from "./resolver.js";

/** A pool or a checked-out (org-scoped) client — the run's already-scoped client. */
type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface DefaultConflictResolverDeps {
  pool: QueryClient;
  runStateWriter?: RunStateWriter;
  eventStore: EventStore;
  ssh: SshSubstrate;
  secrets: SecretStore;
  target: SshTarget;
  workspacePath: string;
  baseSha: string;
  timeoutMs: number;
  runId: string;
  // The run's spec + project + org + intent (the MERGING spec).
  projectId: string;
  orgId?: string;
  specId: string;
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  baseBranch: string;
  headBranch: string;
  endpointBaseUrl?: string;
  // The project routing (the conflict Answerer rides the `audit` chain head) and
  // the run's already-built checker/auditor adapters (the re-gate reuses them).
  routing: RoutingTable;
  checker: AnswererAdapter<CheckAnswer>;
  auditor: AnswererAdapter<AuditAnswer>;
  runGate: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
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
    mergingSpecIntent: {
      specId: deps.specId,
      title: deps.specTitle,
      description: deps.specDescription,
      acceptanceCriteria: deps.acceptanceCriteria,
    },
    eventStore: deps.eventStore,
    provenance: new PgConflictProvenanceReader(deps.pool),
    applier: new SshWorkspaceConflictApplier({
      ssh: deps.ssh,
      target: deps.target,
      workspacePath: deps.workspacePath,
      baseBranch: deps.baseBranch,
      headBranch: deps.headBranch,
      timeoutMs: deps.timeoutMs,
    }),
    answerer: new AnswererBackedConflictInvoker({
      adapter: conflictAdapter,
      timeoutMs: deps.timeoutMs,
      workspace: deps.workspacePath,
    }),
    reGate: new RunPathResolvedTreeReGate({
      ssh: deps.ssh,
      target: deps.target,
      workspacePath: deps.workspacePath,
      timeoutMs: deps.timeoutMs,
      runGate: deps.runGate,
      checker: deps.checker,
      auditor: deps.auditor,
      specTitle: deps.specTitle,
      specDescription: deps.specDescription,
      acceptanceCriteria: deps.acceptanceCriteria,
      baseSha: deps.baseSha,
    }),
    replan: new SpecStatusReplanRouter({
      pool: deps.pool,
      ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
      ...(deps.orgId !== undefined && { orgId: deps.orgId }),
      eventStore: deps.eventStore,
      runId: deps.runId,
      projectId: deps.projectId,
    }),
  });
}

export { buildIntentPreservingConflictResolver } from "./resolver.js";
export type { IntentPreservingResolverDeps } from "./resolver.js";
