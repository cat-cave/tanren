// Build the LIVE `MergeAuthorityBundle` (tanren-owns-the-engine.md §5) the merge
// stage authorizes a land against. This is the gather-and-map site: it composes the
// `CodeHost` (the ff-only CAS land) from the run's shared GitHub HTTP client + token, resolves the
// project's `auditPosture` + budget scope, and packages the gate/review/findings/demo/
// HITL signals the run loop already holds. Anything the live path could not resolve is
// passed in its ABSENT (blocking) form — the fail-closed boundary in
// `mergeAuthorityInputs` never invents a passing value.
//
// WHY here (not in the dispatcher): the bundle needs the real `pg.Pool` (for the
// org-scoped durable finalize) + the token plumbing — both owned by the call site (the
// run loop / the coordinator drive). The dispatcher stays pool-agnostic: it is handed
// the `finalizerFor` closure + the built `CodeHost`, and resolves only mergeability +
// conflict state itself.

import type pg from "pg";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { buildLandFinalizer } from "./mergeAuthorityLandFinalizer.js";
import { resolveLandTimeSignals, resolveLandTimeFindings } from "./landSignals.js";
import { PgBudgetGate } from "../dag/budgetGate.js";
import { GitHubCodeHost } from "../providers/githubCodeHost.js";
import { resolveVcsToken } from "../credentials/vcsCredentials.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { CodeHost } from "../contracts/codeHost.js";
import type { AuditPosture } from "../contracts/auditPosture.js";
import type { Finding } from "../contracts/findings.js";
import type { GateOutcome } from "../workflow/gate/index.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";
import type { ProjectBudgetState } from "../contracts/dagWalker.js";
import type { ResolvedVcsToken } from "../contracts/codeHostTypes.js";
import type { RawBudgetScope, RawDemoVerification, RawHitlSignoff } from "./mergeAuthorityInputs.js";
import type { MergeAuthorityBundle, MergeForRunInput } from "../workflow/reviewMerge/mergeDispatchTypes.js";
import type { ReviewMergeRunContext } from "../workflow/reviewMerge/context.js";

/** Everything the call site holds to build the bundle for one run's land. */
export interface BuildMergeAuthorityBundleInput {
  /** The real pool the durable finalize opens its org-scoped transaction on. */
  pool: pg.Pool;
  /** The shared (timed) GitHub HTTP client the land `CodeHost` is built over. */
  githubHttp: GitHubHttpClient;
  /** Resolve the active GitHub token (the SAME closure the merge probe resolves with). */
  resolveToken: () => Promise<ResolvedVcsToken>;
  orgId: string;
  /** The project config jsonb (→ auditPosture). */
  projectConfigRaw: unknown;
  /** The project config version (the policy identity stamped on the node's proof key). */
  policyVersion: number;
  /** The native gate outcome the run loop produced (absent → blocks). */
  gateOutcome: GateOutcome | undefined;
  /** The sha the latest `pre_merge` gate verdict was FOR (the TOCTOU commit-binding). */
  gatedHeadSha: string | undefined;
  /**
   * The REAL audit findings the auditor emitted on the run's latest `auditor.verdict`
   * (read fresh at land time; §4). `decideFromFindings(findings, auditPosture)` in the
   * authority is the LIVE audit gate. A MISSING/unreadable audit record is passed as a
   * single synthetic P0 (`auditMissingFinding`) so the land BLOCKS under any posture —
   * the fail-closed boundary is resolved by the reader, never by an empty list here.
   */
  findings: ReadonlyArray<Finding>;
  /** The review poll's verdict (only `approved` clears; absent → unread → blocks). */
  reviewVerdict: ReviewVerdict | undefined;
  /**
   * The project's resolved budget state (the SAME `PgBudgetGate.resolveBudget` the
   * walker gates on). `failClosed` (unparseable/unpriced) → unresolvable (BLOCKS); a
   * genuinely-absent ceiling → `not_required` (the walker enforced it upstream); a
   * configured ceiling carries its real spend for the exhausted check.
   */
  budgetState: ProjectBudgetState;
  /**
   * The demo-verification verdict at land time. The in-loop merge precedes the
   * post-deploy demo stage, so a project with no pre-merge demo passes `not_required`
   * (an explicit configured absence). A failed/absent pre-merge demo passes
   * `unverified` (blocks). NEVER synthesize `verified`.
   */
  demo: RawDemoVerification;
  /** The HITL signoff (explicit; `not_required` when no HITL stage is configured). */
  hitlSignoff: RawHitlSignoff;
}

/**
 * Resolve the project's `auditPosture` from its config (the DORA knob; the balanced
 * default when unset). A parse failure THROWS — a merge must never authorize against
 * an unknown posture (fail-closed config).
 */
function resolveAuditPosture(projectConfigRaw: unknown): AuditPosture {
  return migrateProjectConfig(projectConfigRaw).auditPosture;
}

/**
 * Map the walker's resolved {@link ProjectBudgetState} → {@link RawBudgetScope}. A
 * `failClosed` reason (UNPARSEABLE config / UN-PRICED real spend — the §5-P1 cases) →
 * `failClosedReason` (→ unresolvable → BLOCKS; never silently unlimited). A
 * genuinely-absent ceiling (`undefined`, no failClosed) → `not_required` (the walker
 * already gated it upstream). A configured ceiling carries its real spend.
 */
function rawBudgetFrom(state: ProjectBudgetState): RawBudgetScope {
  if (state.failClosed !== undefined) {
    return { ceilingUsd: undefined, spentUsd: state.spentUsd, failClosedReason: `budget ${state.failClosed}` };
  }
  return { ceilingUsd: state.ceilingUsd, spentUsd: state.spentUsd };
}

/**
 * Build the minimal `CodeHost` the `MergeAuthority` lands through, over the SAME
 * GitHub HTTP client the run already holds (no second http client threaded into the
 * merge path). A future backend constructs its own host here.
 */
function codeHostFor(githubHttp: GitHubHttpClient, resolveToken: () => Promise<ResolvedVcsToken>): CodeHost {
  return new GitHubCodeHost(githubHttp, async () => {
    const r = await resolveToken();
    return { token: r.token, ...(r.refresh !== undefined && { refresh: r.refresh }) };
  });
}

export function buildMergeAuthorityBundle(input: BuildMergeAuthorityBundleInput): MergeAuthorityBundle {
  return {
    codeHost: codeHostFor(input.githubHttp, input.resolveToken),
    orgId: input.orgId,
    finalizerFor: (context) => buildLandFinalizer(input.pool, context),
    gateConfigHash: "",
    policyVersion: String(input.policyVersion),
    gateOutcome: input.gateOutcome,
    gatedHeadSha: input.gatedHeadSha,
    findings: input.findings,
    auditPosture: resolveAuditPosture(input.projectConfigRaw),
    reviewVerdict: input.reviewVerdict,
    budget: rawBudgetFrom(input.budgetState),
    demo: input.demo,
    hitlSignoff: input.hitlSignoff,
  };
}

/**
 * §5 cutover: build the bundle for ONE live merge-stage land pass, gathering from the
 * `mergeForRun` input + the loaded run context. Resolves the token (the SAME
 * credential context the merge probe uses), the project config raw (→ auditPosture),
 * and the budget state (the SAME `PgBudgetGate` the walker gates on — fail-closed on
 * unparseable/unpriced).
 *
 * FRESH LAND-TIME SIGNALS (§5): the gate verdict, review verdict, AND audit findings
 * are RE-READ from the DURABLE event record HERE, at LAND time — NOT the values
 * captured before `mergeForRun`. This bundle is built LAZILY inside `driveLand`, AFTER
 * any conflict resolver ran (a resolver can RE-GATE + RE-AUDIT), so the latest
 * `pre_merge` gate verdict + the latest review verdict + the latest `auditor.verdict`
 * findings reflect the POST-resolution state. A stale/now-failing gate, a review that
 * flipped to `changes_requested`, or a re-audit that surfaced a P0/P1 finding during
 * resolution therefore BLOCKS — the SAME freshness the native DRIVE pass already
 * applies. Both paths build from land-time signals; neither authorizes against
 * pre-conflict state.
 *
 * THE AUDIT GATE (§4): `findings` are read via `resolveLandTimeFindings` — the REAL
 * auditor findings, decided by `decideFromFindings` against the project `auditPosture`
 * inside the authority. FAIL-CLOSED: a missing/unreadable audit record resolves to a
 * synthetic P0 (blocks under any posture), never a silent pass.
 *
 * The pool is the worker pool (a real `pg.Pool` in production — the durable finalize +
 * the land-signal read open their org-scoped transactions on it); a caller without a
 * real pool injects a pre-built `input.mergeAuthority` instead, so this is not reached.
 */
export async function buildBundleForMergeStage(
  input: MergeForRunInput,
  context: ReviewMergeRunContext,
): Promise<MergeAuthorityBundle> {
  const pool = input.pool as pg.Pool;
  const meta = await pool.query<{ project_config: unknown; org_id: string }>(
    `SELECT p.config AS project_config, r.org_id
       FROM runs r JOIN projects p ON p.project_id = r.project_id
      WHERE r.run_id = $1`,
    [context.runId],
  );
  const row = meta.rows[0];
  if (row === undefined || row.org_id === null) {
    throw new Error(`merge authority bundle: run ${context.runId} has no resolvable project/org`);
  }
  const budgetState = await new PgBudgetGate(pool).resolveBudget(context.projectId);
  // Re-read the gate + review verdicts FRESH at land time (post-resolution), so a
  // conflict-resolved retry never authorizes against the pre-conflict gate/review.
  const landSignals = await resolveLandTimeSignals(pool, row.org_id, context.runId);
  // The REAL audit findings (§4) — the live audit gate at merge time. Fail-closed: a
  // missing/unreadable audit record resolves to a synthetic P0 (blocks any posture).
  const findings = await resolveLandTimeFindings(pool, row.org_id, context.runId);
  return buildMergeAuthorityBundle({
    pool,
    githubHttp: input.githubHttp,
    resolveToken: () =>
      resolveVcsToken(input.githubHttp, {
        secrets: input.secrets,
        installation: context.installation,
        staticRef: context.staticCredentialRef,
        minter: input.githubAppMinter,
      }),
    orgId: row.org_id,
    projectConfigRaw: row.project_config,
    policyVersion: context.policyVersion,
    gateOutcome: landSignals.gateOutcome,
    gatedHeadSha: landSignals.gatedHeadSha,
    findings,
    reviewVerdict: landSignals.reviewVerdict,
    budgetState,
    // The in-loop / drive land precedes the post-deploy demo stage — an explicit
    // configured absence, NOT a skipped check (a future pre-merge demo threads here).
    demo: "not_required",
    // No HITL stage on the autonomous tiers (the human decision is the `human` review
    // tier, carried via the review verdict). Explicit `not_required`, never omitted.
    hitlSignoff: "not_required",
  });
}
