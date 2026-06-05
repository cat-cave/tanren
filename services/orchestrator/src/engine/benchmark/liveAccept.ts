// Live post-merge ACCEPT seam (docs/roadmap/tanren-method-benchmark.md §2.1).
//
// This is the PRODUCTION injection for the BenchmarkRunner's `runAccept` seam.
// The runner (`runner.ts`) only calls it when a trial's run MERGED; this module
// then runs the cell's frozen hidden `accept` tier against the MERGED result —
// allocate a runner (the SAME allocator the run path uses), clone the trial's
// repo AT THE MERGED COMMIT SHA, bootstrap deps (the SAME `bootstrapWorkspace`
// the run path uses), run the accept tier over SSH via the existing
// `runAcceptStep` (which keys off `runGateTier` semantics — exit codes only, no
// agent), release the runner, and return the AcceptResult.
//
// Everything heavy is REUSED, never reimplemented: the `Allocator`, the
// `bootstrapWorkspace` install step, the `runAcceptStep` executor, and the
// `PgEventStore` append path (org-scoped, RLS-enforced). The only benchmark glue
// here is: resolve the trial's repo/spec/project + the MERGED SHA from the run's
// rows/events, drive the clone@mergedSHA, and shape the accept appendEvent seam.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type { CiStep } from "../ci/index.js";
import type { Allocator, RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { PgEventStore } from "../eventStore.js";
import type { EventName, EventPayload } from "../events/index.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { bootstrapWorkspace, runWorkspaceSshCommand, workspaceRepoPathForRun } from "../workspace/index.js";
import { resolveBootstrapCommand } from "../workflow/gate/index.js";
import { runAcceptStep } from "./accept.js";
import type { AcceptResult } from "./entities.js";
import type { TrialAcceptInput } from "./runner.js";

/** What the live accept seam needs from the worker/API boot to run end-to-end. */
export interface LiveAcceptDeps {
  /** Cross-org system pool: bootstrap the run's repo/merge facts, then scope per-op. */
  pool: pg.Pool;
  /** The SAME allocator the run path uses (reused, not a second one). */
  allocator: Allocator;
  /** The SAME SSH substrate the run path drives the runner over. */
  ssh: CommandSubstrate;
  /** The runner identity key ref (mirrors the worker's `identitySecretRef`). */
  identitySecretRef: string;
  /** Per-step SSH timeout for the clone/bootstrap/accept commands. */
  timeoutMs?: number;
}

/** A run's repo/spec/project facts + the merged commit the accept tier runs on. */
const RunAcceptFacts = z.object({
  spec_id: z.string(),
  project_id: z.string(),
  repo_url: z.string(),
  runner_image: z.string(),
});

const DEFAULT_ACCEPT_TIMEOUT_MS = 600_000;

/**
 * Build the production `runAccept` seam injected into the BenchmarkRunner. The
 * returned fn is called by the scheduler ONLY for a trial whose run merged; it
 * allocates → clones@mergedSHA → bootstraps → runs the frozen accept tier →
 * releases → returns the verdict. A merged run with NO resolvable merge sha, or
 * an empty accept tier, yields a FAILED accept (never a silent pass).
 */
export function buildLiveRunAccept(deps: LiveAcceptDeps): (input: TrialAcceptInput) => Promise<AcceptResult | null> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS;
  return async (input) => {
    const { orgId, cell, runId, trialIndex, taskId } = input;

    // 1. Resolve the run's repo/spec/project under org scope (RLS) + the merged
    //    commit the accept tier must run against. The merged sha is the forensic
    //    anchor: the oracle runs on EXACTLY what landed on the default branch.
    const facts = await loadRunAcceptFacts(deps.pool, orgId, runId);
    const mergedSha = await resolveMergedSha(deps.pool, orgId, runId);

    // The accept tier's steps are the cell's frozen `accept` tier (the hidden
    // equivalence oracle). The runAcceptStep executor treats an empty tier as a
    // FAILED accept, so a cell with no accept tier never scores a silent green.
    const steps = acceptStepsFromFrozen(cell.frozenConfig.ciTiers.tiers);
    const acceptTierHash = cell.seedTaskRef.acceptTierHash;
    const workspacePath = workspaceRepoPathForRun(runId);
    const appendEvent = buildAcceptAppendEvent(deps.pool, orgId, {
      runId,
      specId: facts.spec_id,
      projectId: facts.project_id,
    });

    // A merged run with no resolvable merge sha cannot run the oracle against the
    // merged result — that is a FAILED accept, attributed to the missing sha, not
    // a silent pass. We still emit the verdict event so the trial row is honest.
    if (mergedSha === undefined) {
      await appendEvent(
        "benchmark.accept.failed",
        {
          cellId: cell.cell.cellId,
          trialIndex,
          tier: "accept",
          acceptTierHash,
          failedStep: null,
          exitCode: null,
          reason: "trial run merged but no merge sha is recorded; the accept tier cannot run on the merged result",
          steps: [],
        },
        taskId,
      );
      return "failed";
    }

    // 2. Allocate a runner via the SAME allocator the run path uses. Thread the
    //    org so the `runners` row is written under the right tenant scope (the
    //    allocator binds org_id explicitly now — no `runs` subquery).
    const allocation = await deps.allocator.allocate({
      runId,
      projectId: facts.project_id,
      runnerImage: facts.runner_image,
      identitySecretRef: deps.identitySecretRef,
      orgId,
    });
    try {
      // 3. Clone the repo AT THE MERGED SHA (not a branch tip — the exact merged
      //    commit), then 4. bootstrap deps with the SAME install step the run
      //    path uses so the accept tier operates on a built tree.
      await cloneAtMergedSha(deps.ssh, allocation.target, {
        workspacePath,
        repoUrl: facts.repo_url,
        mergedSha,
        timeoutMs,
      });
      const bootstrapCommand = await resolveBootstrapCommand({
        ssh: deps.ssh,
        target: allocation.target,
        workspacePath,
        timeoutMs,
      });
      await bootstrapWorkspace({
        ssh: deps.ssh,
        target: allocation.target,
        workspacePath,
        ...(bootstrapCommand === undefined ? {} : { command: bootstrapCommand }),
        timeoutMs,
      });

      // 5. Run the frozen accept tier over SSH via the existing executor.
      const outcome = await runAcceptStep({
        ssh: deps.ssh,
        target: allocation.target,
        workspacePath,
        steps,
        acceptTierHash,
        cellId: cell.cell.cellId,
        trialIndex,
        timeoutMs,
        appendEvent,
        ...(taskId === undefined ? {} : { taskId }),
      });
      return outcome.result;
    } finally {
      // 6. Always release the runner, mirroring the run path's release-on-finally.
      await deps.allocator.release(allocation.runnerId, "completed");
    }
  };
}

/** The frozen `accept` tier's steps (the hidden oracle), or [] when the cell defines none. */
function acceptStepsFromFrozen(tiers: Record<string, ReadonlyArray<CiStep>>): ReadonlyArray<CiStep> {
  return tiers["accept"] ?? [];
}

/**
 * Load the run's spec/project/repo facts under org scope (RLS). Throws when the
 * run is not visible under the org (cross-org → zero rows) so a mis-scoped accept
 * fails loudly rather than running on the wrong tenant's repo.
 */
async function loadRunAcceptFacts(
  pool: pg.Pool,
  orgId: string,
  runId: string,
): Promise<z.infer<typeof RunAcceptFacts>> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query(
      `SELECT r.spec_id, r.project_id, p.repo_url, p.runner_image
         FROM runs r
         JOIN projects p ON p.project_id = r.project_id
        WHERE r.run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`accept: run ${runId} not visible under org ${orgId}`);
    }
    return RunAcceptFacts.parse(row);
  });
}

/**
 * Resolve the merged commit sha from the run's merge events. A run that merged
 * via direct_merge emits `merge.completed` with `mergeSha`; a Mergify/webhook
 * merge surfaces `github.pr.merged` with `mergeSha`. We take the most recent
 * event of either kind that carries a sha. Returns undefined when none does.
 */
async function resolveMergedSha(pool: pg.Pool, orgId: string, runId: string): Promise<string | undefined> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ payload: unknown }>(
      `SELECT payload
         FROM events
        WHERE run_id = $1
          AND event_type IN ('merge.completed', 'github.pr.merged')
        ORDER BY ts DESC, id DESC`,
      [runId],
    );
    for (const row of result.rows) {
      const sha = mergeShaOf(row.payload);
      if (sha !== undefined) return sha;
    }
  });
}

function mergeShaOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const sha = (payload as Record<string, unknown>)["mergeSha"];
  return typeof sha === "string" && sha !== "" ? sha : undefined;
}

/**
 * Build the accept step's `appendEvent` seam over the org-scoped `PgEventStore`.
 * The benchmark.accept.* events carry only (cellId, trialIndex, …); the store
 * needs the run/spec/project ids for the row + its org-derived tenant key, so we
 * close over them here. The write runs in a short org-scoped transaction (RLS).
 */
function buildAcceptAppendEvent(
  pool: pg.Pool,
  orgId: string,
  ids: { runId: string; specId: string; projectId: string },
): <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void> {
  return async (eventType, payload, taskId) => {
    await runWithOrgScope(pool, orgId, async (client) => {
      const store = new PgEventStore(client);
      await store.append({
        runId: ids.runId,
        ...(taskId === undefined ? {} : { taskId }),
        specId: ids.specId,
        projectId: ids.projectId,
        eventType,
        payload,
      });
    });
  };
}

/**
 * Clone the repo AT THE MERGED SHA into the runner workspace. Cloning the
 * default branch shallow would miss an already-superseded merge commit, so we
 * init + fetch the exact sha (depth 1) and check it out detached — the oracle
 * runs on precisely the commit that landed, nothing more recent.
 */
async function cloneAtMergedSha(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  input: { workspacePath: string; repoUrl: string; mergedSha: string; timeoutMs: number },
): Promise<void> {
  await runWorkspaceSshCommand(ssh, target, {
    label: "clone accept workspace at merged sha",
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      `rm -rf ${quoteSshShellArg(input.workspacePath)}`,
      `mkdir -p ${quoteSshShellArg(input.workspacePath)}`,
      `cd ${quoteSshShellArg(input.workspacePath)}`,
      "git init -q",
      `git remote add origin ${quoteSshShellArg(input.repoUrl)}`,
      `git fetch --depth 1 -q origin ${quoteSshShellArg(input.mergedSha)}`,
      "git checkout -q FETCH_HEAD",
      "git config user.name 'Tanren Accept'",
      "git config user.email 'accept@tanren.invalid'",
    ].join(" && "),
  });
}
