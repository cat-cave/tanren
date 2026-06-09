// plannerRunGate — the run loop's production CI-gate callback + its best-effort native
// JUnit ingest. Extracted from plannerRunAdapters.ts to keep that file under the 500-line
// architecture cap (the jj conflict cutover added the live-jj resolve branch there). The
// gate callback resolves the project CI config lazily, runs a guarded deps-ensure before
// EVERY gate (greenfield/brownfield mode), runs the mapped tiers over SSH, and ingests the
// per-test JUnit grain in-process. `buildDefaultGate` is re-exported from
// plannerRunAdapters so plannerRun.ts keeps its single import surface.

import { type CiWhen, JUNIT_REPORT_PATH } from "../ci/index.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import {
  advisoryStepNamesForPosture,
  type GateOutcome,
  ingestGateJunit,
  invalidCiConfigGateOutcome,
  isInvalidCiConfigError,
  resolveBootstrapCommand,
  resolveGateConfig,
  runGateForWhen,
} from "./gate/index.js";
import type { CiConfigV1, CiConfigValidationError, CiYamlParseError } from "../ci/index.js";
import {
  DEFAULT_BOOTSTRAP_COMMAND,
  ensureWorkspaceDepsInstalled,
  resolveWorkspaceHeadSha,
} from "../workspace/index.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";

// Builds the production gate callback. The CI config is resolved lazily on the
// first gate call (the workspace is bootstrapped by then) and cached for the
// rest of the run. A malformed `.tanren/ci.yml` (built-repo data) is a fail-closed,
// RUN-SCOPED gate FAILURE — surfaced at the first gate as a `{ passed: false }`
// outcome (→ `gateFindings` P0: "the repo's `.tanren/ci.yml` is invalid") rather
// than an unhandled throw that crashes the worker (the v25-apex crash class). Each
// call runs the tiers mapped to `when` over SSH and emits gate.* through the run's store.
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

// A full 40-hex git object id (the only shape the verdict anchor may bind to).
const FULL_SHA = /^[0-9a-f]{40}$/u;

/**
 * Resolve the commit the gate.verdict is anchored on — FAIL-CLOSED at the gate
 * boundary (no-silent-fallback doctrine). COMMIT-BINDING (§5):
 *
 *   - A NON-EMPTY override must be a full 40-hex sha. A garbage/truncated override is
 *     a corrupt read — THROW, never anchor the verdict (and the forge status) on a
 *     bogus commit. (Holds for every `when`.)
 *   - `pre_merge` EXPECTS a pushed PR-head override. A missing/empty override there
 *     would silently fall back to the workspace HEAD — the exact wrong-commit binding
 *     the fix prevents (the workspace HEAD is the writer tip, NOT the pushed PR head).
 *     So `pre_merge` + (absent/empty override) THROWS the moment the workspace HEAD is
 *     a real sha. The ONLY tolerated case is the fake-SSH unit path, where the
 *     workspace HEAD itself resolves to "" ⇒ no override is needed and no verdict is
 *     emitted (runGateForWhen skips a "" anchor).
 *   - per_iteration / pre_audit legitimately have no override ⇒ the workspace HEAD IS
 *     the gated commit; bind to it (a "" fake-SSH head ⇒ no verdict).
 */
async function resolveVerdictAnchorSha(
  when: CiWhen,
  headShaOverride: string | undefined,
  resolveWorkspaceHead: () => Promise<string>,
): Promise<string> {
  if (headShaOverride !== undefined && headShaOverride !== "") {
    if (!FULL_SHA.test(headShaOverride)) {
      throw new Error(`gate verdict head-sha override is not a 40-hex sha: ${headShaOverride}`);
    }
    return headShaOverride;
  }
  const workspaceHead = await resolveWorkspaceHead();
  // pre_merge with no valid override + a REAL workspace HEAD: the silent wrong-commit
  // binding. Fail closed — the merge gate MUST anchor on the pushed PR head, never the
  // writer tip. (A "" head is the fake-SSH unit path ⇒ no verdict, tolerated.)
  if (when === "pre_merge" && workspaceHead !== "") {
    throw new Error(
      "pre_merge gate requires a pushed PR-head sha override; refusing to silently bind the verdict to the workspace HEAD",
    );
  }
  return workspaceHead;
}

export function buildDefaultGate(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  eventStore: EventStore,
): (gate: { when: CiWhen; taskId?: string; headShaOverride?: string }) => Promise<GateOutcome> {
  const context = input.context;
  // The lazily-resolved gate config, memoized as a DISCRIMINATED result so an
  // INVALID `.tanren/ci.yml` (built-repo data) is a RUN-SCOPED gate failure — never
  // a throw that escapes to the worker (the v25-apex crash class). The first gate
  // call resolves + classifies it; `{ ok }` carries the parsed config, `{ invalid }`
  // carries the validation/parse error the gate surfaces as a failed outcome (→ P0
  // finding). A substrate READ failure is NOT classified here — it keeps its loud-
  // throw semantics (a transient hiccup must never be recast as a fixable config
  // finding). Memoized: the result is observed once and reused for the rest of the run.
  let configResult:
    | Promise<{ ok: CiConfigV1 } | { invalid: CiConfigValidationError | CiYamlParseError } | undefined>
    | undefined;
  // The lazily-resolved EXPLICIT install command, cached alongside the config.
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
  return async ({ when, taskId, headShaOverride }) => {
    // Resolve + CLASSIFY the gate config FIRST, observing the promise immediately in a
    // try/catch so an invalid `.tanren/ci.yml` can never become an unobserved rejection
    // that crashes the worker. An INVALID config short-circuits to a fail-closed gate
    // failure (→ P0 finding) before we bother installing deps for a gate we cannot run.
    // A substrate READ failure is re-thrown (its loud run-fail semantics are preserved).
    if (configResult === undefined) {
      configResult = resolveGateConfig({
        ssh: input.ssh,
        target,
        workspacePath,
        timeoutMs: input.timeoutMs,
      })
        .then((ok) => ({ ok }) as { ok: CiConfigV1 })
        .catch((error: unknown) => {
          if (isInvalidCiConfigError(error)) {
            return { invalid: error };
          }
          throw error;
        });
    }
    const resolved = await configResult;
    if (resolved !== undefined && "invalid" in resolved) {
      // Built-repo `.tanren/ci.yml` is broken: a LOUD, run-scoped gate FAILURE
      // carrying the validation issues (→ `gateFindings` P0: "the repo's
      // `.tanren/ci.yml` is invalid"), fail-closed (never a pass). The worker survives.
      return invalidCiConfigGateOutcome(resolved.invalid, when, appendEvent, taskId);
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
    // `resolved` is the `{ ok }` branch here (the `{ invalid }` branch returned above;
    // an `undefined` is impossible since resolveGateConfig always yields a config or
    // throws). Narrow to the parsed config for the tier run.
    const config = (resolved as { ok: CiConfigV1 }).ok;
    // Anchor the native verdict on the commit the gate is about to verify. COMMIT-BINDING
    // (§5): the `pre_merge` gate passes a `headShaOverride` — the PUSHED PR head (the
    // cleaned ref, bootstrap commit dropped) — because the workspace HEAD is left at the
    // writer tip (a DIFFERENT sha) so a review-rework can keep diffing vs its base.
    // Recording the verdict on the override is what lets the authority's `gatedHeadSha ==
    // landing head` hold. The override is validated + FAIL-CLOSED at this boundary (no
    // silent fallback to a wrong commit): see {@link resolveVerdictAnchorSha}.
    const headSha = await resolveVerdictAnchorSha(when, headShaOverride, () =>
      resolveWorkspaceHeadSha({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs }),
    );
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
    await ingestGateJunitBestEffort(input, target, workspacePath, headSha, outcome);
    return outcome;
  };
}

/**
 * Ingest the gate's JUnit report in-process, best-effort. Skipped when there is no
 * head-sha anchor (fake-SSH unit path) or no org (a legacy/unscoped run — the
 * `ci_test_results` row is org-stamped). The run already runs under the org's ambient
 * scope, so `input.pool` self-scopes the INSERT. A read/parse error is logged + swallowed
 * (the per-test grain is an enrichment, never a gate-blocker), so it can NEVER fail the run.
 *
 * NO-SILENT-FALLBACK: the ingest result is DISCRIMINATED. `expectReport` is derived from
 * the EXECUTED tiers — true iff a test step that writes `JUNIT_REPORT_PATH` actually ran.
 * When a junit-writing test step ran but the report is absent/unreadable/empty, the
 * `missing_expected` result is surfaced LOUDLY (a structured `console.error` — the
 * lightest genuinely-visible mechanism, the WS3 `logFinalizeSwallow` precedent): the
 * per-test grain is gone though a test step ran, so flaky-intelligence is blind. This is
 * non-merge-gating — VISIBILITY of a reporter misconfig / runner crash, not a blocker.
 */
async function ingestGateJunitBestEffort(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  headSha: string,
  outcome: GateOutcome,
): Promise<void> {
  const orgId = input.context.orgId;
  if (headSha === "" || orgId === undefined || orgId === null) {
    return;
  }
  // Derive expectReport + the reporting tier from the EXECUTED steps: a step whose
  // `run` references JUNIT_REPORT_PATH is a junit-writing test step that actually ran.
  // The scaffold `fast` tier (lint+typecheck) has none ⇒ expectReport=false ⇒ quiet.
  const reportingTier = outcome.results.find((tier) => tier.steps.some((step) => step.run.includes(JUNIT_REPORT_PATH)));
  const expectReport = reportingTier !== undefined;
  try {
    const result = await ingestGateJunit({
      ssh: input.ssh,
      target,
      workspacePath,
      client: input.pool,
      runId: input.context.runId,
      projectId: input.context.projectId,
      orgId,
      headSha,
      timeoutMs: input.timeoutMs,
      gatePassed: outcome.passed,
      expectReport,
      ...(reportingTier === undefined ? {} : { tier: reportingTier.tier }),
    });
    if (result.kind === "missing_expected") {
      // LOUD: a junit-writing test step ran but produced no usable report — the per-test
      // grain (flaky detection) just went blind. Name the reason + tier + headSha so an
      // operator can tell a reporter misconfig (absent/empty) from a runner/transport
      // hiccup (read_failed). Non-blocking — the gate verdict already stands.
      console.error(
        `[gate] native JUnit report EXPECTED but ${result.reason} for run ${input.context.runId} ` +
          `(tier=${reportingTier?.tier ?? "unknown"}, headSha=${headSha}) — flaky-intelligence has NO per-test ` +
          `grain for this gate (a reporter misconfig or a runner crash after the test step). Non-blocking.`,
      );
    }
  } catch (error) {
    console.error(`[gate] native JUnit ingest failed for run ${input.context.runId} (non-blocking):`, error);
  }
}
