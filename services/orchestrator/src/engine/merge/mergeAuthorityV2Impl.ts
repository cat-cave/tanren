// The REAL `MergeAuthorityV2` impl (SP-4; tanren-owns-the-engine.md §0, §5) — the
// SOLE, host-independent, FAIL-CLOSED land decision + the sole host-land driver. This
// is the CLEAN REPLACEMENT of the deleted V1 `MergeAuthorityImpl`: there is no V1 kept,
// no delegate, no dual-run. It depends ONLY on the frozen contracts — the `CodeHost`
// seam (step-2 idempotent CAS land), the injected {@link LandBindingRevalidator} (the
// TOCTOU re-validation SP-7 implements), and the injected {@link AuthorityLandStore}
// (the durable 4-step protocol: persist decision + effect intent → record receipt).
//
// THE V2 SHAPE: `authorizeLand` takes the frozen `AuthorizeLandInput` and the
// `LandBindingEnvelope` SEPARATELY, re-validates the binding (asserting
// `envelope.subject` deep-equals `input.subject`) immediately before reading the
// fail-closed truth table, and carries the re-validated envelope onto the
// authorization. `land` runs the 4-step protocol over the store + host.
//
// VALIDATED against the FROZEN `mergeAuthorityConformance` truth table.

import { decideFromFindings } from "../contracts/auditPosture.js";
import type { CodeHost } from "../contracts/codeHost.js";
import type {
  AuthorizeLandInput,
  LandAuthorization,
  LandBindingEnvelope,
  LandBindingRevalidation,
  LandBindingRevalidator,
  LandBlockReason,
  LandOutcome,
  LandSubject,
  MergeAuthorityV2,
} from "../contracts/mergeAuthority.js";

/** Deep-equality of two land subjects (the only landable subject is an integration node). */
export function subjectsEqual(a: LandSubject, b: LandSubject): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * The DEFAULT land-binding revalidator (reconciliation rule 2): assert `envelope.subject`
 * deep-equals `input.subject` (the TOCTOU guard the authority MUST apply before
 * authorizing and immediately before host land). SP-7 supplies a richer revalidator (the
 * gate-proof binding is still valid for the EXACT head) that composes this subject check;
 * this concrete default is the minimal correct re-validation the contract requires when no
 * SP-7 revalidator is wired.
 */
export class SubjectEqualityRevalidator implements LandBindingRevalidator {
  async revalidate(input: { subject: LandSubject; envelope: LandBindingEnvelope }): Promise<LandBindingRevalidation> {
    if (!subjectsEqual(input.subject, input.envelope.subject)) {
      return {
        valid: false,
        reason:
          `land binding subject ${JSON.stringify(input.envelope.subject)} does not match the ` +
          `decision subject ${JSON.stringify(input.subject)} — fail closed (raced binding)`,
      };
    }
    return { valid: true };
  }
}

/**
 * The durable 4-step land store (reconciliation rule 3) — the ONE seam the guaranteed
 * transactional land records through. `MergeAuthorityV2.land` runs: authorize →
 * `persistAuthorizedDecision` (step 1: the immutable `authority_decisions` row + the
 * idempotent `authority_effect_intents` row, returning the effect-intent id used as the
 * CAS `idempotencyKey`) → external land via `CodeHost.landAuthorizedIntegration` (step 2)
 * → `recordLandReceipt` (step 3: the `authority_land_receipts` row + the run/spec
 * finalize — `merge.completed` + spec `merged` — in ONE org-scoped transaction, returning
 * the durable `auditId`). A THROW from `recordLandReceipt` — AFTER the external land
 * fired — is exactly the `merge_state_unknown` reconcile signal (step 4), never swallowed
 * into a silent inconsistency.
 */
export interface AuthorityLandStore {
  persistAuthorizedDecision(input: {
    authorization: LandAuthorization;
  }): Promise<{ effectIntentId: string; completed?: { mainSha: string; auditId: string } }>;
  recordLandReceipt(input: {
    authorization: LandAuthorization;
    effectIntentId: string;
    mainSha: string;
  }): Promise<{ auditId: string }>;
}

/**
 * The real fail-closed `MergeAuthorityV2`. Constructed with the `CodeHost` it lands
 * through, the {@link LandBindingRevalidator} it re-validates the binding with before
 * authorization and host land, and the {@link AuthorityLandStore} that records the 4-step
 * protocol. No hidden state: the CAS base + target ride ON the {@link LandBindingEnvelope}.
 */
export class MergeAuthorityV2Impl implements MergeAuthorityV2 {
  constructor(
    private readonly host: CodeHost,
    private readonly revalidator: LandBindingRevalidator,
    private readonly store: AuthorityLandStore,
  ) {}

  /**
   * The FAIL-CLOSED truth table. Re-validates the binding (subject deep-equal + SP-7
   * gate-proof) FIRST — a raced binding blocks before any signal is read. Then EVERY
   * guaranteed input must be in its pass state to authorize; ANY uncertain/failing input
   * blocks (naming it in `reasons`); a genuine human decision (HITL `pending`, a
   * `changes_requested` review) routes to `needs_attention`. The re-validated envelope is
   * carried onto the authorization so `land` has the concrete target with no hidden state.
   */
  async authorizeLand(input: AuthorizeLandInput, envelope: LandBindingEnvelope): Promise<LandAuthorization> {
    const reasons: LandBlockReason[] = [];
    let needsAttention = false;

    // TOCTOU: re-validate the binding immediately before reading the truth table.
    const revalidation = await this.revalidator.revalidate({ subject: input.subject, envelope });
    if (!revalidation.valid) {
      reasons.push({
        input: "binding",
        detail: revalidation.reason ?? "land binding re-validation failed — fail closed",
      });
    }

    // gate verdict — only `passed` clears; `unknown` NEVER reads as passing.
    if (input.gateVerdict !== "passed") {
      reasons.push({
        input: "gateVerdict",
        detail: `gate verdict is '${input.gateVerdict}' — fail closed (only 'passed' clears)`,
      });
    }

    // mergeability — only `clean` clears; `unknown`/`blocked` fail closed on uncertainty.
    if (input.mergeability !== "clean") {
      reasons.push({
        input: "mergeability",
        detail: `mergeability is '${input.mergeability}' — fail closed (only 'clean' clears)`,
      });
    }

    // review verdict — only `approved` clears; `changes_requested` is a HUMAN signal.
    if (input.reviewVerdict !== "approved") {
      reasons.push({
        input: "reviewVerdict",
        detail: `review verdict is '${input.reviewVerdict}' — fail closed (only 'approved' clears)`,
      });
      if (input.reviewVerdict === "changes_requested") needsAttention = true;
    }

    // conflicts — must be `resolved` before land.
    if (input.conflicts !== "resolved") {
      reasons.push({
        input: "conflicts",
        detail: "conflicts unresolved — fail closed (must be resolved before land)",
      });
    }

    // budget — `unresolvable` fails closed (a failed/unknown resolution is NEVER
    // unlimited); a `resolved` scope blocks only when exhausted; `not_required` clears.
    if (input.budget.kind === "unresolvable") {
      reasons.push({
        input: "budget",
        detail: `budget scope unresolvable (${input.budget.reason}) — fail closed (never unlimited)`,
      });
    } else if (input.budget.kind === "resolved" && input.budget.spentUsd >= input.budget.ceilingUsd) {
      reasons.push({
        input: "budget",
        detail: `budget exhausted (spent ${input.budget.spentUsd} >= ceiling ${input.budget.ceilingUsd})`,
      });
    }

    // demo — only `verified`/`not_required` clear; `unverified` fails closed.
    if (input.demo === "unverified") {
      reasons.push({
        input: "demo",
        detail: "demo unverified — fail closed (a failed/absent demo never clears)",
      });
    }

    // HITL — REQUIRED + explicit: only `not_required`/`approved` clear; `pending` holds.
    if (input.hitlSignoff !== "not_required" && input.hitlSignoff !== "approved") {
      reasons.push({ input: "hitlSignoff", detail: "HITL signoff pending — needs a human decision" });
      needsAttention = true;
    }

    // findings vs posture — the REAL pure policy decides the block (the DORA knob).
    const postureDecision = decideFromFindings(input.findings, input.auditPosture);
    if (postureDecision.block) {
      reasons.push({
        input: "findings",
        detail: "findings exceed auditPosture.blockReviewAt — blocked by policy",
      });
    }

    const decision = reasons.length === 0 ? "authorized" : needsAttention ? "needs_attention" : "blocked";
    return { decision, subject: input.subject, envelope, reasons };
  }

  /**
   * Execute the land TRANSACTIONALLY, ONLY for an `authorized` authorization (throws on
   * a non-authorized one — `land` cannot bypass the decision). The 4-step protocol:
   *   (1) persist the immutable decision + idempotent effect intent,
   *   (2) revalidate the exact binding immediately before external idempotent CAS land
   *       (`CodeHost.landAuthorizedIntegration`),
   *   (3) record the receipt + finalize the run/spec,
   *   (4) a receipt failure AFTER the land returns `merge_state_unknown` for the reconciler.
   * A `LandCasRejectedError` from step 2 (main raced ahead) propagates to the caller —
   * nothing landed, the decision + intent are already persisted for the retry.
   */
  async land(auth: LandAuthorization): Promise<LandOutcome> {
    if (auth.decision !== "authorized") {
      throw new Error(
        `land() refused: authorization is not 'authorized' (decision='${auth.decision}') — land cannot bypass the decision`,
      );
    }

    // Step 1: persist the immutable decision + the idempotent effect intent.
    const persisted = await this.store.persistAuthorizedDecision({ authorization: auth });
    if (persisted.completed !== undefined) {
      return { kind: "landed", mainSha: persisted.completed.mainSha, auditId: persisted.completed.auditId };
    }
    const { effectIntentId } = persisted;

    // Freshness fence between durable step 1 and host step 2: the original evaluation may
    // now be stale (node/proof/member branch can change without moving main), so revalidate
    // immediately before the irreversible CAS.
    // A completed retry returned above deliberately skips this check: its CAS already ran.
    const revalidation = await this.revalidator.revalidate({ subject: auth.subject, envelope: auth.envelope });
    if (!revalidation.valid) {
      return {
        kind: "revalidation_failed",
        reason: revalidation.reason ?? "land-time binding re-validation failed — fail closed",
      };
    }

    // Step 2: the external idempotent CAS land, keyed on the effect intent so a retry of
    // this step is a no-op once main already advanced to the authorized head.
    const landed = await this.host.landAuthorizedIntegration({
      repo: auth.envelope.target.repo,
      intoMain: auth.envelope.target.intoMain,
      authorizedSha: auth.envelope.headSha,
      expectedMainSha: auth.envelope.expectedMainSha,
      idempotencyKey: effectIntentId,
    });

    // Step 3: record the receipt + finalize the run/spec in one durable transaction.
    try {
      const { auditId } = await this.store.recordLandReceipt({
        authorization: auth,
        effectIntentId,
        mainSha: landed.mainSha,
      });
      return { kind: "landed", mainSha: landed.mainSha, auditId };
    } catch (err) {
      // Step 4: the host advanced `main` but the durable receipt failed — NEVER a plain
      // failure: enter the explicit `merge_state_unknown` reconcile state.
      return {
        kind: "merge_state_unknown",
        reason: `durable receipt failed after external land at ${landed.mainSha}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        reconcileToken: `reconcile-${auth.subject.id}-${landed.mainSha}`,
      };
    }
  }
}
