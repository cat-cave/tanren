// plannerRunGate — the run loop's production CI-gate callback + its best-effort native
// JUnit ingest. Extracted from plannerRunAdapters.ts to keep that file under the 500-line
// architecture cap (the jj conflict cutover added the live-jj resolve branch there). The
// gate callback resolves the project CI config lazily, runs a guarded deps-ensure before
// EVERY gate (greenfield/brownfield mode), runs the mapped tiers over SSH, and ingests the
// per-test JUnit grain in-process. `buildDefaultGate` is re-exported from
// plannerRunAdapters so plannerRun.ts keeps its single import surface.

import { type CiWhen, junitReportFor } from "../ci/index.js";
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
import { ensureWorkspaceDepsInstalled, resolveWorkspaceHeadSha } from "../workspace/index.js";
import { type ActiveQuarantine, loadActiveQuarantine, quarantineEnv } from "./ciQuarantine.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("gate");

// Builds the production gate callback. The CI config is resolved lazily on the
// first gate call (the workspace is bootstrapped by then) and cached for the
// rest of the run. A malformed `.tanren/ci.yml` (built-repo data) is a fail-closed,
// RUN-SCOPED gate FAILURE — surfaced at the first gate as a `{ passed: false }`
// outcome (→ `gateFindings` P0: "the repo's `.tanren/ci.yml` is invalid") rather
// than an unhandled throw that crashes the worker (the v25-apex crash class). Each
// call runs the tiers mapped to `when` over SSH and emits gate.* through the run's store.
//
// GREENFIELD DEPS-ENSURE: before EVERY gate the callback runs a guarded
// `ensureWorkspaceDepsInstalled` (bootstrap whenever the project CONTRACT —
// `justfile` / `.tanren/ci.yml` — exists). prepareRunWorkspace bootstraps ONCE right
// after clone, before the writer — but a greenfield clone HEAD ships no contract, so
// that cold bootstrap is a no-op; the writer THEN authors the `justfile` + manifest,
// and without this the first per-iteration gate would run `just tier-1` against an
// unprepared tree. The bootstrap command is resolved LAZILY (cached alongside the
// config) so a writer-authored `.tanren/ci.yml` `bootstrap.run` is honored.
//
// STACK-AGNOSTIC: Tanren names NO tech stack. When NO explicit command is set (no
// `input.bootstrapCommand`, no `.tanren/ci.yml` `bootstrap.run`), the default is the
// stack-agnostic DEFAULT_BOOTSTRAP_COMMAND LOUD-fallback (`just bootstrap` if a
// justfile is present, else a loud failure). The greenfield-vs-frozen install
// concern (`--frozen-lockfile` vs a writer-added dependency) lives INSIDE the
// project's `just bootstrap` recipe, NOT in Tanren — so there is no
// `context.greenfield` branch here.
//
// NO `installed` LATCH (the P0 fix): the ensure is re-run before EVERY gate and
// its result is NOT cached. The greenfield project MUTATES between writer
// iterations — a writer can add a dependency AFTER an earlier iteration's install,
// and a one-shot "installed once → skip forever" latch would then never install it,
// so the gate would die on a missing binary. ensureWorkspaceDepsInstalled re-runs
// the bootstrap whenever the contract exists (the project's `just bootstrap` is the
// idempotency authority — a redundant run is a cheap no-op), so re-running it each
// gate is correct and safe.

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
  // The lazily-resolved EXPLICIT bootstrap command, cached alongside the config.
  // An explicit input.bootstrapCommand wins; otherwise the writer-authored
  // .tanren/ci.yml `bootstrap.run` (conventionally `just bootstrap`) is picked up.
  // Undefined here ⇒ no explicit command, and the per-gate default is the
  // stack-agnostic DEFAULT_BOOTSTRAP_COMMAND LOUD-fallback — see the bootstrap block
  // below.
  let installCommandPromise: Promise<string | undefined> | undefined;
  // The lazily-resolved ACTIVE flaky-quarantine, memoized for the run. Loaded
  // org-scoped off the run's `input.pool` (RLS denies by default — a read off the
  // wrong scope sees ZERO rows). The CI-intelligence ACTUATION (closes the
  // flaky→quarantine→ship loop): the quarantined STEP names are excluded from the
  // verdict (a proven-flaky step's failure no longer red-gates the merge), and the
  // quarantined TEST ids are exported via the stack-agnostic `TANREN_QUARANTINE`
  // env so a justfile/test-runner that honors the documented filter SKIPS them.
  // Re-loaded once per run (the detector clears a row when the flake is fixed — a
  // fresh run picks that up). A load failure is swallowed to an EMPTY quarantine:
  // the gate is the merge authority and must never be bricked by an enrichment read
  // (no-silent-fallback applies to MASKING a failure as a pass, not to failing OPEN
  // on a non-blocking enrichment — an empty quarantine only makes the gate STRICTER).
  let quarantinePromise: Promise<ActiveQuarantine> | undefined;
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
    // Bootstrap before the gate runs, EVERY gate (no latch). The project's `just
    // bootstrap` is idempotent (it reconciles an already-prepared tree as a cheap
    // no-op), and re-running it each gate is what catches a writer-added dependency
    // authored AFTER an earlier iteration's install — a one-shot latch would skip it
    // and the gate would die on a missing binary. A real failure throws
    // WorkspaceDepsInstallError and halts the run loudly (no silent skip).
    //
    // The command is the resolved one (an `input.bootstrapCommand` override or the
    // repo's `.tanren/ci.yml` `bootstrap.run`, conventionally `just bootstrap`), or —
    // when neither is declared — the stack-agnostic DEFAULT_BOOTSTRAP_COMMAND
    // LOUD-fallback (`just bootstrap` if a justfile is present, else a loud failure).
    // Tanren names NO stack and makes NO greenfield-vs-frozen choice: that concern
    // lives inside the project's `just bootstrap` recipe.
    const resolvedInstallCommand = await installCommandPromise;
    await ensureWorkspaceDepsInstalled({
      ssh: input.ssh,
      target,
      workspacePath,
      ...(resolvedInstallCommand === undefined ? {} : { command: resolvedInstallCommand }),
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
    // CI-INTELLIGENCE ACTUATION: resolve the project's ACTIVE quarantine (memoized) +
    // fold it into the gate's app-env (the stack-agnostic `TANREN_QUARANTINE` test
    // filter) + the excluded step names — what CLOSES the flaky→quarantine→ship loop.
    quarantinePromise ??= loadGateQuarantine(input.pool, context.projectId, context.runId);
    const quarantine = await quarantinePromise;
    const gateAppEnv = mergeQuarantineEnv(input.appEnv, quarantine);
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
      // FLAKY-QUARANTINE: a proven-flaky step's failure is excluded from the verdict.
      ...(quarantine.checkNames.size === 0 ? {} : { quarantinedStepNames: quarantine.checkNames }),
      // AUDIT-EVIDENCE BASELINE: the governance policy version, threaded so the
      // gate.verdict roll-up records which policy revision the gate was judged under.
      ...(input.context.policyVersion === undefined ? {} : { policyVersion: input.context.policyVersion }),
      ...(headSha === "" ? {} : { headSha }),
      // Plane B: the project's dev+test app env (+ the `TANREN_QUARANTINE` filter), so
      // the building agent's gate commands run with it. Never logged/emitted.
      ...(gateAppEnv === undefined ? {} : { appEnv: gateAppEnv }),
    });
    // NATIVE PER-TEST INGEST: read the runner's JUnit report (if a tier DECLARED a
    // junitReport path) + persist the per-test rows IN-PROCESS — the CI-intelligence
    // grain, straight from the runner, no webhook. Best-effort: it never affects the
    // verdict. "JUnit expected" is decided from the DECLARED contract field, not a
    // command sniff; a declared-but-absent report emits a durable `ci.junit_missing`.
    await ingestGateJunitBestEffort(input, target, workspacePath, headSha, outcome, config, when, appendEvent, taskId);
    return outcome;
  };
}

/**
 * Load the project's ACTIVE flaky-quarantine for the gate (the CI-intelligence read).
 * Org-scoped off the run's `pool` (RLS denies by default — a read off the wrong scope
 * sees ZERO rows). FAILS OPEN to an EMPTY quarantine on a load error: the gate is the
 * merge authority and must never be bricked by an enrichment read, and an empty
 * quarantine only makes the gate STRICTER (no-silent-fallback applies to MASKING a
 * failure as a pass, not to failing OPEN on a non-blocking enrichment).
 */
async function loadGateQuarantine(
  pool: RunPlannerLoopInput["pool"],
  projectId: string,
  runId: string,
): Promise<ActiveQuarantine> {
  try {
    return await loadActiveQuarantine(pool, projectId);
  } catch (error) {
    console.error(`[gate] active-quarantine load failed for run ${runId} (gate stays strict):`, error);
    return { checkNames: new Set<string>(), testIds: [] };
  }
}

/**
 * Fold the active quarantine's `TANREN_QUARANTINE` test filter into the gate's app-env.
 * Returns `undefined` (no env) when there is neither a project app-env nor a quarantine
 * filter, so the common case leaves the gate command unchanged. The quarantine entry
 * wins on a key clash (a project would never name a var `TANREN_QUARANTINE`).
 */
function mergeQuarantineEnv(
  appEnv: Record<string, string> | undefined,
  quarantine: ActiveQuarantine,
): Record<string, string> | undefined {
  const quarantineAppEnv = quarantineEnv(quarantine);
  if (appEnv === undefined && Object.keys(quarantineAppEnv).length === 0) return undefined;
  return { ...appEnv, ...quarantineAppEnv };
}

/**
 * Ingest the gate's JUnit report in-process, best-effort. Skipped when there is no
 * head-sha anchor (fake-SSH unit path) or no org (a legacy/unscoped run — the
 * `ci_test_results` row is org-stamped). The run already runs under the org's ambient
 * scope, so `input.pool` self-scopes the INSERT. A read/parse error is logged + swallowed
 * (the per-test grain is an enrichment, never a gate-blocker), so it can NEVER fail the run.
 *
 * NO-SILENT-FALLBACK: the ingest result is DISCRIMINATED. "JUnit expected" is decided
 * from the EXPLICIT CI-config contract — a tier mapped to this lifecycle point DECLARED a
 * `junitReport` path (`junitReportFor`), NOT a command-string sniff (a writer's
 * `just tier-2` never mentions the path). No declaration ⇒ a clean QUIET skip. When a
 * tier DID declare a report but the runner produced none (absent/unreadable/empty), the
 * `missing_expected` result is surfaced LOUDLY AND DURABLY: a persisted `ci.junit_missing`
 * event (the durable signal) PLUS a structured `log.error` breadcrumb. The per-test grain is gone though a test
 * tier ran, so flaky-intelligence is blind — a reporter misconfig / a runner crash after
 * the step. Non-merge-gating (the verdict already stands) — VISIBILITY, not a blocker.
 */
async function ingestGateJunitBestEffort(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  headSha: string,
  outcome: GateOutcome,
  config: CiConfigV1,
  when: CiWhen,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  taskId: string | undefined,
): Promise<void> {
  const orgId = input.context.orgId;
  if (headSha === "" || orgId === undefined || orgId === null) {
    return;
  }
  // Decide "JUnit expected" from the DECLARED contract field, not a command sniff: the
  // first tier mapped to `when` that DECLARES a `junitReport` path names the tier + the
  // path to read back. The scaffold `fast` tier (lint+typecheck) declares none ⇒
  // expectReport=false ⇒ a clean QUIET skip.
  const declared = junitReportFor(config, when);
  const expectReport = declared !== undefined;
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
      ...(declared === undefined ? {} : { tier: declared.tier, reportPath: declared.path }),
    });
    if (result.kind === "missing_expected") {
      // LOUD + DURABLE: a tier DECLARED a junit report but the runner produced none — the
      // per-test grain (flaky detection) just went blind. Persist `ci.junit_missing`
      // (reason + tier + path + headSha) so the blindness is on the durable LEDGER (the
      // event is the durable signal), and ALSO a structured `log.error` so it surfaces as
      // an operator BREADCRUMB in the run output. The event is advisory — non-blocking,
      // the gate verdict already stands.
      await appendEvent(
        "ci.junit_missing",
        {
          headSha,
          tier: declared?.tier ?? "unknown",
          reportPath: declared?.path ?? "unknown",
          reason: result.reason,
        },
        taskId,
      );
      log.error(
        "native JUnit report EXPECTED but missing — flaky-intelligence has NO per-test grain for this gate " +
          "(a reporter misconfig or a runner crash after the test step). Non-blocking.",
        {
          runId: input.context.runId,
          reason: result.reason,
          tier: declared?.tier ?? "unknown",
          reportPath: declared?.path ?? "unknown",
          headSha,
        },
      );
    }
  } catch (error) {
    log.error("native JUnit ingest failed (non-blocking)", { runId: input.context.runId }, error);
  }
}
