// plannerRunGate — the run loop's production CI-gate callback + its best-effort native
// JUnit ingest. Extracted from plannerRunAdapters.ts to keep that file under the 500-line
// architecture cap (the jj conflict cutover added the live-jj resolve branch there). The
// gate callback resolves the project CI config lazily, runs a guarded deps-ensure before
// EVERY gate (greenfield/brownfield mode), runs the mapped tiers over SSH, and ingests the
// per-test JUnit grain in-process. `buildDefaultGate` is re-exported from
// plannerRunAdapters so plannerRun.ts keeps its single import surface.

import type { CiWhen } from "../ci/index.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import {
  advisoryStepNamesForPosture,
  type GateOutcome,
  ingestGateJunit,
  resolveBootstrapCommand,
  resolveGateConfig,
  runGateForWhen,
} from "./gate/index.js";
import {
  DEFAULT_BOOTSTRAP_COMMAND,
  ensureWorkspaceDepsInstalled,
  resolveWorkspaceHeadSha,
} from "../workspace/index.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";

// Builds the production gate callback. The CI config is resolved lazily on the
// first gate call (the workspace is bootstrapped by then) and cached for the
// rest of the run, so a malformed .tanren/ci.yml surfaces at the first gate
// rather than crashing the workflow before the loop starts. Each call runs the
// tiers mapped to `when` over SSH and emits gate.* through the run's store.
//
// GREENFIELD DEPS-ENSURE: before EVERY gate the callback runs a guarded
// `ensureWorkspaceDepsInstalled` (install whenever a manifest exists).
// prepareRunWorkspace bootstraps ONCE right after clone, before the writer — but a
// greenfield clone HEAD ships no manifest, so that cold bootstrap skips install;
// the writer THEN authors `package.json`, and without this the first
// per-iteration gate would run `pnpm lint` against an uninstalled tree
// (`turbo: not found` / `vitest: not found`). The install command is resolved
// LAZILY (cached alongside the config) so a writer-authored `.tanren/ci.yml`
// `bootstrap.run` is honored.
//
// INSTALL MODE (greenfield vs brownfield): when NO explicit install command is set
// (no `input.bootstrapCommand`, no `.tanren/ci.yml` `bootstrap.run`), the DEFAULT
// is chosen by `context.greenfield`. A greenfield run (Tanren authored the repo
// live) uses the NON-FROZEN deps-ensure default so a writer-added devDep installs
// even without a perfectly-regenerated lockfile. A brownfield run keeps the
// FROZEN, lockfile-safe `DEFAULT_BOOTSTRAP_COMMAND` (`pnpm install
// --frozen-lockfile` / `npm ci`) so an existing committed lockfile is NEVER
// silently mutated / upgraded — main's safe default, restored.
//
// NO `installed` LATCH (the P0 fix): the ensure is re-run before EVERY gate and
// its result is NOT cached. The greenfield manifest MUTATES between writer
// iterations — a writer can add a devDep (e.g. `vitest`) AFTER an earlier
// iteration's partial install already created node_modules, and a one-shot
// "installed once → skip forever" latch would then never install that new devDep,
// so the gate would die on `vitest: not found`. ensureWorkspaceDepsInstalled now
// installs whenever a manifest exists (pnpm/npm is the idempotency authority — a
// redundant install is a cheap no-op), so re-running it each gate is correct and
// safe. Brownfield → each re-install is the FROZEN command, a cheap, lockfile-safe
// no-op when deps already agree, behavior-equivalent to main.
export function buildDefaultGate(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  eventStore: EventStore,
): (gate: { when: CiWhen; taskId?: string }) => Promise<GateOutcome> {
  const context = input.context;
  let configPromise: ReturnType<typeof resolveGateConfig> | undefined;
  // The lazily-resolved EXPLICIT install command, cached alongside configPromise.
  // An explicit input.bootstrapCommand wins; otherwise the writer-authored
  // .tanren/ci.yml `bootstrap.run` is picked up. Undefined here ⇒ no explicit
  // command, and the per-gate DEFAULT is chosen by `context.greenfield`
  // (greenfield ⇒ non-frozen DEPS_ENSURE_DEFAULT_COMMAND; brownfield ⇒ frozen
  // DEFAULT_BOOTSTRAP_COMMAND) — see the install-mode block below.
  let installCommandPromise: Promise<string | undefined> | undefined;
  // The advisory (warn-but-don't-block) step names for the run's governance
  // posture: `lenient` ⇒ {lint, typecheck} are advisory; every other posture ⇒
  // empty set (strict default — every step blocks, behavior unchanged).
  const advisoryStepNames = advisoryStepNamesForPosture(context.governancePosture);
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    await eventStore.append({
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      taskId,
      eventType,
      payload,
    });
  };
  return async ({ when, taskId }) => {
    if (configPromise === undefined) {
      configPromise = resolveGateConfig({
        ssh: input.ssh,
        target,
        workspacePath,
        timeoutMs: input.timeoutMs,
      });
    }
    if (installCommandPromise === undefined) {
      // Resolve the EXPLICIT install command, if any: an `input.bootstrapCommand`
      // override wins; otherwise the repo's `.tanren/ci.yml` `bootstrap.run`
      // (undefined when the repo ships no `bootstrap:` key). The greenfield-vs-
      // brownfield DEFAULT (applied below only when this is undefined) is NOT
      // baked in here, so an explicit command always wins verbatim in both cases.
      installCommandPromise =
        input.bootstrapCommand === undefined
          ? resolveBootstrapCommand({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs })
          : Promise.resolve(input.bootstrapCommand);
    }
    // Install deps before the gate runs, EVERY gate (no latch). The install is
    // idempotent (pnpm/npm reconciles an already-installed tree as a cheap no-op),
    // and re-running it each gate is what catches a writer-added devDep authored
    // AFTER an earlier iteration's install — a one-shot latch would skip it and the
    // gate would die on `vitest: not found`. A real install failure throws
    // WorkspaceDepsInstallError and halts the run loudly (no silent skip).
    //
    // INSTALL MODE (no explicit command): a GREENFIELD run leaves `command`
    // undefined → ensureWorkspaceDepsInstalled uses its NON-FROZEN
    // DEPS_ENSURE_DEFAULT_COMMAND (a writer-added devDep installs even without a
    // perfectly-regenerated lockfile). A BROWNFIELD run uses the FROZEN,
    // lockfile-safe DEFAULT_BOOTSTRAP_COMMAND (`pnpm install --frozen-lockfile` /
    // `npm ci`) so an existing committed lockfile is NEVER silently mutated /
    // upgraded — restoring main's safe brownfield default. An explicit command
    // (resolved above) overrides this in either case.
    const resolvedInstallCommand = await installCommandPromise;
    const installCommand =
      resolvedInstallCommand ?? (input.context.greenfield === true ? undefined : DEFAULT_BOOTSTRAP_COMMAND);
    await ensureWorkspaceDepsInstalled({
      ssh: input.ssh,
      target,
      workspacePath,
      ...(installCommand === undefined ? {} : { command: installCommand }),
      ...(input.appEnv === undefined ? {} : { appEnv: input.appEnv }),
      timeoutMs: input.timeoutMs,
    });
    const config = await configPromise;
    // Anchor the native verdict on the commit the gate is about to verify (the
    // workspace HEAD). "" on a fake-SSH unit path ⇒ runGateForWhen emits no verdict.
    const headSha = await resolveWorkspaceHeadSha({
      ssh: input.ssh,
      target,
      workspacePath,
      timeoutMs: input.timeoutMs,
    });
    const outcome = await runGateForWhen({
      ssh: input.ssh,
      target,
      workspacePath,
      config,
      when,
      timeoutMs: input.timeoutMs,
      appendEvent,
      taskId,
      advisoryStepNames,
      // AUDIT-EVIDENCE BASELINE: the governance policy version, threaded so the
      // gate.verdict roll-up records which policy revision the gate was judged under.
      ...(input.context.policyVersion === undefined ? {} : { policyVersion: input.context.policyVersion }),
      ...(headSha === "" ? {} : { headSha }),
      // Plane B: the project's dev+test app env, so the building agent's gate
      // commands run with it. Never logged/emitted. Distinct from Tanren creds.
      ...(input.appEnv === undefined ? {} : { appEnv: input.appEnv }),
    });
    // NATIVE PER-TEST INGEST: read the runner's JUnit report (if the gate's test step
    // emitted one) + persist the per-test rows IN-PROCESS — the CI-intelligence grain,
    // straight from the runner, no webhook. Best-effort: it never affects the verdict.
    await ingestGateJunitBestEffort(input, target, workspacePath, headSha, outcome.passed);
    return outcome;
  };
}

/**
 * Ingest the gate's JUnit report in-process, best-effort. Skipped when there is no
 * head-sha anchor (fake-SSH unit path) or no org (a legacy/unscoped run — the
 * `ci_test_results` row is org-stamped). The run already runs under the org's ambient
 * scope, so `input.pool` self-scopes the INSERT. A read/parse error is logged + swallowed
 * (the per-test grain is an enrichment, never a gate-blocker), so it can NEVER fail the run.
 */
async function ingestGateJunitBestEffort(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  headSha: string,
  gatePassed: boolean,
): Promise<void> {
  const orgId = input.context.orgId;
  if (headSha === "" || orgId === undefined || orgId === null) {
    return;
  }
  try {
    await ingestGateJunit({
      ssh: input.ssh,
      target,
      workspacePath,
      client: input.pool,
      runId: input.context.runId,
      projectId: input.context.projectId,
      orgId,
      headSha,
      timeoutMs: input.timeoutMs,
      gatePassed,
    });
  } catch (error) {
    console.error(`[gate] native JUnit ingest failed for run ${input.context.runId} (non-blocking):`, error);
  }
}
