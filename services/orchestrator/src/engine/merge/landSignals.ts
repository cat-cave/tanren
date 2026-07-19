// Re-read the LAND-TIME gate + review signals from the DURABLE event record
// (tanren-owns-the-engine.md §5) — the SINGLE source both land paths (the in-loop
// direct_merge AND the native_queue coordinator DRIVE) build the `MergeAuthority`
// bundle from. The bundle is built LAZILY inside `driveLand`/`landViaAuthority`, AFTER
// any conflict resolver ran (a resolver can take real time + RE-GATE), so reading the
// LATEST `pre_merge` `gate.verdict` + the latest review verdict HERE reflects the
// post-resolution state — never the pre-conflict values captured before `mergeForRun`.
//
// FAIL-CLOSED (§5): a NOT-FOUND / unreadable verdict resolves to `undefined`, which
// the authority's input mapping turns into its blocking enum (gate `unknown` / review
// `unread`). A stale/now-failing gate or a review that flipped to `changes_requested`
// during resolution therefore BLOCKS — neither path can authorize against stale state.
//
// COMMIT-BOUND (the deepest §5 invariant — closing the gate↔land TOCTOU): the gate
// verdict is anchored to a SPECIFIC commit (`payload.headSha` — the sha the gate
// actually passed FOR). This reader returns that `gatedHeadSha` so the authority can
// require it EQUALS the head being landed. A head-advance AFTER the gate but BEFORE the
// land (eager base-shifts / a concurrent rebase / any push) makes `gatedHeadSha !=
// landedHeadSha` → BLOCK: a verdict is "fresh in time" yet NOT for the commit being
// landed. The land authorizes ONLY when a PASSED `pre_merge` gate exists FOR EXACTLY the
// commit being landed; a head-advance forces a fresh re-gate on the new head.
//
// REVIEW COMMIT-BOUND (gv-2): the same reader returns `reviewedHeadSha` from the
// latest terminal `review.approved` / `review.changes_requested` forge receipt
// (`payload.headSha`) when present. Strict simulated review always binds that
// field; human/auto paths omit it. Land authorization must NOT merely trust
// event existence — when a receipt head is present it must equal the head being
// landed, or the land fails closed (re-review / re-gate the advanced head).
//
// The read is ORG-SCOPED (RLS) — the caller passes the org the run belongs to. The
// `gate.verdict` roll-up is the headSha-anchored native gate verdict
// (`workflow/gate/runGateForWhen.ts`); the review verdict is the latest
// `review.approved`/`review.auto_approved`/`review.changes_requested` event.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type { GateOutcome } from "../workflow/gate/index.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";
import type { Finding } from "../contracts/findings.js";
import { AuditFinding, normalizeFinding } from "../answerers/schemas/index.js";
import { ReviewApprovedPayload } from "../events/schemas/reviewForgeReceipt.js";
import {
  noRequiredReviewGate,
  reviewRulesFromCompiledPolicy,
  ReviewPrincipal as ReviewPrincipalSchema,
  type GovernanceReviewGate,
  type ReviewApprovalEvidence,
  type ReviewPrincipal,
} from "../governance/reviewRules.js";

const ApprovedReceiptEvidence = z
  .object({
    forgeReviewId: z.string().min(1),
    forgeReviewState: z.literal("approved"),
    forgeReviewUrl: z.string().min(1),
    headSha: z.string().regex(/^[0-9a-f]{40}$/iu),
  })
  .passthrough();

/** The fresh land-time signals, as the durable record reflects them right now. */
export interface LandTimeSignals {
  /** A synthesized passed `GateOutcome` for the latest passed `pre_merge` gate, else
   * `undefined` (a failed gate OR no recorded verdict) — which the authority blocks on. */
  gateOutcome: GateOutcome | undefined;
  /**
   * The sha the latest `pre_merge` gate verdict was FOR (`payload.headSha`), or
   * `undefined` when no verdict is recorded. The authority requires this EQUALS the
   * head being landed — binding the verdict to the exact commit (the gate↔land TOCTOU
   * guard). Present even for a FAILED gate (so the mismatch reason can name the sha),
   * but a failed gate already blocks via `gateOutcome === undefined`.
   */
  gatedHeadSha: string | undefined;
  /** The latest review verdict, or `undefined` (no recorded verdict) — which blocks. */
  reviewVerdict: ReviewVerdict | undefined;
  /**
   * The sha the latest terminal `review.approved` / `review.changes_requested`
   * forge receipt was FOR (`payload.headSha`), or `undefined` when the event is
   * absent / has no forge receipt (human/auto paths). When present, the land
   * authority requires this EQUALS the head being landed — the review↔land
   * TOCTOU guard (gv-2). Event existence alone never authorizes a drifted head.
   */
  reviewedHeadSha: string | undefined;
}

/** Re-read all durable review approvals that can satisfy a governance rule. */
export async function resolveLandTimeReviewEvidence(
  pool: pg.Pool,
  orgId: string,
  runId: string,
): Promise<GovernanceReviewGate["evidence"]> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ payload: unknown }>(
      `SELECT payload FROM events
        WHERE run_id = $1 AND event_type = 'review.approved'
        ORDER BY ts DESC, id DESC`,
      [runId],
    );
    const approvals: ReviewApprovalEvidence[] = [];
    for (const row of result.rows) {
      const parsed = ReviewApprovedPayload.safeParse(row.payload);
      if (!parsed.success) {
        return { kind: "unresolved", reason: "a durable review approval has an unreadable payload" };
      }
      const principal = parseReviewPrincipal(parsed.data);
      if (principal === "invalid") {
        return { kind: "unresolved", reason: "a durable review approval has an invalid reviewer principal" };
      }
      const forgeReviewHeadSha = approvedReceiptHead(parsed.data);
      approvals.push({
        ...(parsed.data.reviewer === undefined ? {} : { reviewer: parsed.data.reviewer }),
        ...(principal === undefined ? {} : { principal }),
        ...(forgeReviewHeadSha === undefined ? {} : { forgeReviewHeadSha }),
      });
    }
    return { kind: "observed", approvals };
  });
}

/** Compile immutable review rules and combine them with fresh durable evidence. */
export async function resolveLandTimeReviewGate(
  pool: pg.Pool,
  orgId: string,
  runId: string,
  compiledPolicy: unknown,
): Promise<GovernanceReviewGate> {
  return {
    rules: reviewRulesFromCompiledPolicy(compiledPolicy),
    evidence: await resolveLandTimeReviewEvidence(pool, orgId, runId),
  };
}

export { noRequiredReviewGate };
export type { GovernanceReviewGate };

export type ExactReviewReceiptHeadGuard =
  | { kind: "matched" }
  | { kind: "not_required" }
  | {
      kind: "blocked";
      reasonCode: "receipt_missing" | "receipt_head_invalid" | "receipt_head_mismatch";
      reason: string;
    };

/** Shared sequential/MQ-2 guard: simulated approval requires one complete exact-head receipt. */
export function evaluateExactReviewReceiptHead(input: {
  reviewVerdict: ReviewVerdict | undefined;
  reviewedHeadSha: string | undefined;
  landingHeadSha: string;
  receiptRequired: boolean;
}): ExactReviewReceiptHeadGuard {
  if (input.reviewVerdict !== "approved") return { kind: "not_required" };
  if (input.reviewedHeadSha === undefined) {
    return input.receiptRequired
      ? {
          kind: "blocked",
          reasonCode: "receipt_missing",
          reason: "simulated review approval has no complete provider forge receipt",
        }
      : { kind: "not_required" };
  }
  if (!/^[0-9a-f]{40}$/iu.test(input.reviewedHeadSha)) {
    return {
      kind: "blocked",
      reasonCode: "receipt_head_invalid",
      reason: `forge review receipt head '${input.reviewedHeadSha}' is not an exact 40-hex commit sha`,
    };
  }
  if (input.reviewedHeadSha.toLowerCase() !== input.landingHeadSha.toLowerCase()) {
    return {
      kind: "blocked",
      reasonCode: "receipt_head_mismatch",
      reason:
        `forge review receipt is for a different commit than the one being landed ` +
        `(reviewed '${input.reviewedHeadSha}' != landing '${input.landingHeadSha}')`,
    };
  }
  return { kind: "matched" };
}

/**
 * Re-read the LATEST `pre_merge` gate verdict + review verdict for a run, org-scoped,
 * at LAND TIME. ONLY a recorded PASSED gate clears (anything else — failed, or absent
 * — stays `undefined` → the authority's gate input is `unknown`, which BLOCKS). The
 * review verdict maps `approved`/`auto_approved` → `approved`, `changes_requested` →
 * `changes_requested`, absent → `undefined` (→ `unread`, BLOCKS). This is what makes a
 * conflict-resolved retry judge on FRESH state: a re-gate that now fails, or a review
 * that flipped to changes_requested during resolution, is reflected here.
 */
export async function resolveLandTimeSignals(pool: pg.Pool, orgId: string, runId: string): Promise<LandTimeSignals> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const gate = await client.query<{ payload: { passed?: boolean; headSha?: string } }>(
      `SELECT payload FROM events
        WHERE run_id = $1 AND event_type = 'gate.verdict' AND payload->>'when' = 'pre_merge'
        ORDER BY ts DESC, id DESC LIMIT 1`,
      [runId],
    );
    const gatePassed = gate.rows[0]?.payload?.passed;
    const gatedHeadShaRaw = gate.rows[0]?.payload?.headSha;
    const review = await client.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM events
        WHERE run_id = $1 AND event_type IN ('review.approved','review.auto_approved','review.changes_requested')
        ORDER BY ts DESC, id DESC LIMIT 1`,
      [runId],
    );
    const reviewType = review.rows[0]?.event_type;
    const reviewPayload = review.rows[0]?.payload;
    const reviewVerdict: ReviewVerdict | undefined =
      reviewType === "review.approved" || reviewType === "review.auto_approved"
        ? "approved"
        : reviewType === "review.changes_requested"
          ? "changes_requested"
          : undefined;
    // Only a recorded PASSED pre_merge gate clears; anything else (failed / absent)
    // stays undefined → the authority blocks (gate `unknown`). The post-rebase re-gate
    // emits a fresh `pre_merge` gate.verdict, so the LATEST read reflects the re-gate.
    const gateOutcome: GateOutcome | undefined = gatePassed === true ? { passed: true, results: [] } : undefined;
    // The sha the verdict was for (anchors the verdict to a commit — the TOCTOU guard).
    const gatedHeadSha = typeof gatedHeadShaRaw === "string" && gatedHeadShaRaw !== "" ? gatedHeadShaRaw : undefined;
    // Forge receipt head from the same terminal review event (gv-2 exact-head bind).
    // `review.auto_approved` has no forge receipt → undefined (human/auto paths).
    const reviewedHeadSha = completeForgeReceiptHead(reviewType, reviewPayload);
    return { gateOutcome, gatedHeadSha, reviewVerdict, reviewedHeadSha };
  });
}

function completeForgeReceiptHead(
  eventType: string | undefined,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (payload === undefined || (eventType !== "review.approved" && eventType !== "review.changes_requested")) {
    return undefined;
  }
  const expectedState = eventType === "review.approved" ? "approved" : "changes_requested";
  const required = [payload["forgeReviewId"], payload["forgeReviewUrl"], payload["reviewer"]];
  if (required.some((value) => typeof value !== "string" || value.trim() === "")) return undefined;
  if (payload["forgeReviewState"] !== expectedState) return undefined;
  const headSha = payload["headSha"];
  return typeof headSha === "string" && headSha !== "" ? headSha : undefined;
}

function parseReviewPrincipal(payload: { reviewerPrincipal?: unknown }): ReviewPrincipal | undefined | "invalid" {
  if (payload.reviewerPrincipal === undefined) return undefined;
  const parsed = ReviewPrincipalSchema.safeParse(payload.reviewerPrincipal);
  return parsed.success ? parsed.data : "invalid";
}

function approvedReceiptHead(payload: unknown): string | undefined {
  const parsed = ApprovedReceiptEvidence.safeParse(payload);
  return parsed.success ? parsed.data.headSha : undefined;
}

// ---- The LAND-TIME audit findings (the live audit gate, tanren-owns-the-engine.md §4) ----

/**
 * The synthetic finding the land path raises when the audit record is MISSING /
 * UNREADABLE at merge time. `decideFromFindings([], posture)` is `block: false` — an
 * EMPTY list never blocks — so a missing audit must NOT collapse to an empty list (that
 * would be a silent pass on an un-audited change). Instead it raises ONE explicit P0
 * finding: P0 is at-or-above EVERY `blockReviewAt`, so the posture BLOCKS the land under
 * any DORA knob (strict OR velocity). This is the §4 + §0 fail-closed boundary for the
 * findings input: "no audit verdict" reads as the most-severe blocker, never as clean.
 */
export function auditMissingFinding(runId: string): Finding {
  return {
    id: `audit-record-missing-${runId}`,
    severity: "P0",
    title: "audit record missing at merge time",
    body:
      `No durable auditor.verdict was recorded for run ${runId} — the change is UN-AUDITED. ` +
      `Fail-closed (§4): a missing audit reads as a P0 blocker, never as audited-clean.`,
  };
}

/**
 * Re-read the LATEST `auditor.verdict` findings for a run, org-scoped, at LAND TIME —
 * the REAL audit gate the `MergeAuthority` decides over via `decideFromFindings` against
 * the project `auditPosture` (§4). The auditor EMITS findings; the posture (not this
 * reader) renders the block/route/fix verdict.
 *
 * FAIL-CLOSED (§0, §4): a MISSING audit record (no `auditor.verdict` event) OR an
 * UNREADABLE payload (the `findings` key absent / malformed) does NOT degrade to an
 * empty list — it returns a single synthetic P0 ({@link auditMissingFinding}) so the
 * land BLOCKS under any posture. Only a verdict that carries an EXPLICIT `findings` list
 * (possibly empty — audited-clean) clears the audit input. A malformed finding entry
 * throws LOUDLY (`AuditFinding.parse`) rather than silently dropping to a pass.
 */
export async function resolveLandTimeFindings(
  pool: pg.Pool,
  orgId: string,
  runId: string,
): Promise<ReadonlyArray<Finding>> {
  const verdict = await runWithOrgScope(pool, orgId, async (client) => {
    const result = await client.query<{ payload: { findings?: unknown } }>(
      `SELECT payload FROM events
        WHERE run_id = $1 AND event_type = 'auditor.verdict'
        ORDER BY ts DESC, id DESC LIMIT 1`,
      [runId],
    );
    return result.rows[0]?.payload;
  });
  // No recorded auditor.verdict at all ⇒ the change is un-audited ⇒ fail-closed P0.
  if (verdict === undefined || verdict === null) {
    return [auditMissingFinding(runId)];
  }
  const rawFindings = verdict.findings;
  // A verdict WITHOUT a findings list is the post-S3 unreadable case (every live verdict
  // now carries findings): treat an absent/non-array list as un-audited ⇒ fail-closed P0.
  if (!Array.isArray(rawFindings)) {
    return [auditMissingFinding(runId)];
  }
  // The findings ARE present (possibly empty = audited-clean). Parse each LOUDLY — a
  // malformed entry throws rather than silently degrading to a passing (empty) gate.
  return rawFindings.map((entry) => normalizeFinding(AuditFinding.parse(entry)));
}
