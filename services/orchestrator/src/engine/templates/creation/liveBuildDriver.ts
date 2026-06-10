// Template-creation STEP 3 — the LIVE build-driver seam impl (templating-system.md §2.3).
//
// `RunLoopTemplateBuildDriver` is the REAL `TemplateBuildDriver`: it drives the
// derived template-build project (authored in step 2 + materialized by
// `deriveProductGraph` — the project is created ALREADY AUTONOMOUS, native_queue +
// auto review) to a converged conforming repo through the EXISTING run machinery,
// then hands the validation step (step 4) the live runner handle.
//
// REUSE, never reinvent the loop: the derived project's DAG is driven by the SAME
// `DagWalker` + parallel run worker every project uses — the build driver does NOT
// re-implement spec execution. It only (a) KICKS the walker for the project + POLLS
// the project's DAG snapshot until it CONVERGES (every spec merged, none blocked),
// then (b) resolves the converged repo + commit and allocates a runner / clones at
// that sha / bootstraps — the SAME allocate→clone→bootstrap→resolve-gate path the
// live benchmark accept seam (engine/benchmark/liveAccept.ts) uses. The resulting
// `BuiltTemplate` is exactly what the validation harness consumes.
//
// FAIL LOUD, never silent: a project that does NOT converge within the deadline, a
// project that STRANDS (a spec terminally blocked / needs_attention), or a
// converged project with no resolvable repo/commit all throw `TemplateBuildFailedError`
// — the creation flow aborts WITHOUT publishing. Sub-seams (the walker, the
// snapshot read, the clone/bootstrap, the sleep clock) are injected so the wiring
// is unit-testable without a live runner; the production defaults wire the real
// infra in `createTemplateFlow`.

import type pg from "pg";
import type { CiConfigV1 } from "../../ci/index.js";
import type { Allocator, RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import type { DagSnapshot, DagWalker } from "../../contracts/dagWalker.js";
import { resolveBootstrapCommand, resolveGateConfig } from "../../workflow/gate/index.js";
import { bootstrapWorkspace, runWorkspaceSshCommand, workspaceRepoPathForRun } from "../../workspace/index.js";
import { quoteSshShellArg } from "../../ssh/command.js";
import type { TemplateAuditor } from "../validationHarness.js";
import { type BuiltTemplate, TemplateBuildFailedError, type TemplateBuildDriver } from "./buildDriver.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("template-build");

// The converged project's repo + commit + runner image — the facts the build
// driver resolves once the DAG drains, so it can allocate + clone the conforming
// tree the harness validates. Injected as a seam so the resolution (a DB read +
// the project's merge events) is testable without a live project.
export interface ConvergedProjectFacts {
  repoRef: string;
  builtSha: string;
  runnerImage: string;
}

// The sub-seams the live driver composes. Each defaults to the real infra in
// `buildRunLoopBuildDriver`; a unit test injects fakes to assert the wiring shape
// (walk → poll convergence → resolve → allocate → clone → bootstrap → handle)
// without a runner or a database.
export interface RunLoopBuildDriverDeps {
  pool: pg.Pool;
  allocator: Allocator;
  ssh: CommandSubstrate;
  identitySecretRef: string;
  // The walker the build driver kicks each poll to ensure the DAG keeps advancing
  // (idempotent — the parallel worker also drives it off the LISTEN/NOTIFY bus).
  walker: DagWalker;
  // Load the project's DAG snapshot (convergence is read off it). The pg-backed
  // read model in production; a fake in tests.
  loadSnapshot: (projectId: string) => Promise<DagSnapshot>;
  // Resolve the converged repo/commit/runner-image once the DAG drained. The
  // production impl reads the project row + the latest merge sha; a fake in tests.
  resolveConverged: (input: { orgId: string; projectId: string }) => Promise<ConvergedProjectFacts | undefined>;
  // The auditor seam over the built template (stage 3 of validation). The
  // production audit-answerer adapter at the call site; a stub in tests.
  auditorFor: (input: { orgId: string; projectId: string }) => TemplateAuditor;
  // Per-SSH-command timeout for the clone/bootstrap/gate-config reads.
  timeoutMs: number;
  // The convergence poll budget + cadence (the DAG drives asynchronously). The
  // driver polls the snapshot until convergence or the deadline.
  convergence: {
    deadlineMs: number;
    pollIntervalMs: number;
  };
  // Injectable sleep (defaults to a real timer) so the poll loop is fast in tests.
  sleep?: (ms: number) => Promise<void>;
  // Injectable clock (defaults to Date.now) so the deadline is deterministic in tests.
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Build the production `TemplateBuildDriver` from the run infra. The returned
// driver drives a derived template-build project to convergence + returns the
// validation handle. `createTemplateFlow` is the single construction site.
export function buildRunLoopBuildDriver(deps: RunLoopBuildDriverDeps): TemplateBuildDriver {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  return {
    async build(input: { orgId: string; projectId: string }): Promise<BuiltTemplate> {
      // 1. DRIVE the DAG to convergence (the worker + the walker advance it; we
      //    kick + poll). Throws TemplateBuildFailedError on a stranded spec or a
      //    convergence timeout — never a silent "built anyway".
      await driveToConvergence(deps, input.projectId, sleep, now);

      // 2. Resolve the converged conforming repo + commit + runner image. A
      //    converged project with no resolvable repo/commit cannot be validated.
      const facts = await deps.resolveConverged(input);
      if (facts === undefined || facts.repoRef === "" || facts.builtSha === "") {
        throw new TemplateBuildFailedError(
          input.projectId,
          "the project converged but its conforming repo / commit could not be resolved",
        );
      }

      // 3. Allocate a runner + clone the conforming tree AT the converged sha +
      //    bootstrap it + resolve its .tanren/ci.yml — the live validation handle. The
      //    handle carries a `release()` closure (the allocator teardown for this
      //    runner); the creation flow calls it in a `finally` after validation, so the
      //    validation runner is never leaked. (The harness's scratch copies live under
      //    the workspace, reaper-protected, and go down with the runner.)
      return assembleBuiltTemplate(deps, input, facts);
    },
  };
}

// Poll the project's DAG until it CONVERGES — every spec `done` (merged) and at
// least one spec exists. A spec in `terminal_blocked` (halted / cancelled /
// needs_attention) STRANDS the build: the template cannot bake the full bar with a
// blocked spec, so we fail LOUD rather than validate a partial template. The walker
// is kicked each poll (idempotent) so the build does not depend solely on the
// ambient subscriber being up.
async function driveToConvergence(
  deps: RunLoopBuildDriverDeps,
  projectId: string,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  const deadline = now() + deps.convergence.deadlineMs;
  for (;;) {
    // Kick the walker (advances any newly-ready spec); idempotent with the worker.
    await deps.walker.walk(projectId);
    const snapshot = await deps.loadSnapshot(projectId);

    const blocked = snapshot.nodes.filter((n) => n.phase === "terminal_blocked");
    if (blocked.length > 0) {
      throw new TemplateBuildFailedError(
        projectId,
        `template build STRANDED — ${String(blocked.length)} spec(s) terminally blocked (halted/cancelled/needs_attention): ${blocked
          .map((n) => n.specId)
          .join(", ")}`,
      );
    }

    const total = snapshot.nodes.length;
    const done = snapshot.nodes.filter((n) => n.phase === "done").length;
    // CONVERGED — every spec merged.
    if (total > 0 && done === total) {
      return;
    }

    if (now() >= deadline) {
      throw new TemplateBuildFailedError(
        projectId,
        `template build did not converge within ${String(deps.convergence.deadlineMs)}ms (${String(done)}/${String(total)} specs merged)`,
      );
    }
    await sleep(deps.convergence.pollIntervalMs);
  }
}

// Allocate a runner, clone the conforming repo at the converged sha, bootstrap it,
// and resolve its gate config + auditor — the `BuiltTemplate` the harness consumes.
async function assembleBuiltTemplate(
  deps: RunLoopBuildDriverDeps,
  input: { orgId: string; projectId: string },
  facts: ConvergedProjectFacts,
): Promise<BuiltTemplate> {
  // A stable synthetic handle for the validation runner (runner/container naming);
  // the build's actual runs already merged — this is a fresh runner for validation.
  // Must match the safe `run_*` workspace-path pattern (sanitize the project id).
  const runId = `run_template_build_${input.projectId.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;
  const workspacePath = workspaceRepoPathForRun(runId);
  const allocation = await deps.allocator.allocate({
    runId,
    projectId: input.projectId,
    runnerImage: facts.runnerImage,
    identitySecretRef: deps.identitySecretRef,
    orgId: input.orgId,
  });
  const target = allocation.target;

  await cloneAtSha(deps.ssh, target, {
    workspacePath,
    repoUrl: facts.repoRef,
    sha: facts.builtSha,
    timeoutMs: deps.timeoutMs,
  });
  const bootstrapCommand = await resolveBootstrapCommand({
    ssh: deps.ssh,
    target,
    workspacePath,
    timeoutMs: deps.timeoutMs,
  });
  await bootstrapWorkspace({
    ssh: deps.ssh,
    target,
    workspacePath,
    ...(bootstrapCommand === undefined ? {} : { command: bootstrapCommand }),
    timeoutMs: deps.timeoutMs,
  });
  const config: CiConfigV1 = await resolveGateConfig({
    ssh: deps.ssh,
    target,
    workspacePath,
    timeoutMs: deps.timeoutMs,
  });

  // Scratch copies for the negative controls live under the workspace (the same
  // reaper-protected tree the run uses), torn down with the runner.
  const scratchRoot = `${workspacePath.replace(/\/+$/u, "")}/.tanren-tmp/nc`;

  return {
    repoRef: facts.repoRef,
    builtSha: facts.builtSha,
    ssh: deps.ssh,
    target,
    workspacePath,
    scratchRoot,
    config,
    auditor: deps.auditorFor(input),
    // RELEASE the validation runner the allocator gave us (the creation flow calls
    // this in a `finally` after validation). Best-effort: a release failure is logged,
    // never thrown — it must not mask the validation outcome, and the allocator's
    // release is idempotent (a double-release / already-released runner is a no-op).
    release: async () => {
      try {
        await deps.allocator.release(allocation.runnerId, "completed");
      } catch (error) {
        log.warn(
          "failed to release validation runner — leak risk",
          {
            runnerId: allocation.runnerId,
            projectId: input.projectId,
          },
          error,
        );
      }
    },
  };
}

// Clone the conforming repo AT the converged commit (the exact sha, not a branch
// tip) into the validation workspace — mirrors the live accept clone (init + fetch
// the sha depth-1, detached checkout) so the harness validates precisely what the
// build converged on.
async function cloneAtSha(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  input: { workspacePath: string; repoUrl: string; sha: string; timeoutMs: number },
): Promise<void> {
  await runWorkspaceSshCommand(ssh, target, {
    label: "clone template validation workspace at converged sha",
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      `rm -rf ${quoteSshShellArg(input.workspacePath)}`,
      `mkdir -p ${quoteSshShellArg(input.workspacePath)}`,
      `cd ${quoteSshShellArg(input.workspacePath)}`,
      "git init -q",
      `git remote add origin ${quoteSshShellArg(input.repoUrl)}`,
      `git fetch --depth 1 -q origin ${quoteSshShellArg(input.sha)}`,
      "git checkout -q FETCH_HEAD",
      "git config user.name 'Tanren Template Build'",
      "git config user.email 'template-build@tanren.invalid'",
    ].join(" && "),
  });
}
