// The SELF-VALIDATION DRIVER for entity-anchored Claims (§3.3) — the wiring that
// turns the pure oracle (oracle/claimSelfValidation.ts) into a standing sweep over
// the defect ledger. For each OPEN Claim in a project it:
//   1. PROBES the Claim's anchor entity against the current code, via an injectable
//      producer (the thing that runs `sem` on the runner) — returning a neutral
//      `EntityProbeOutcome` keyed on the Claim's structural-hash identity.
//   2. DECIDES via the pure `validateClaimAgainstEntity` oracle.
//   3. PERSISTS the transition (self_resolved / stays-open) + the verbatim read-out.
//   4. EMITS the observable event (`forge.claim.self_resolved` / `forge.claim.validated`).
//
// TRIGGER (the design fork the doc leaves open — §4 sequences §3.3 but does not pin
// WHEN the oracle re-runs). §2.3 ran the staleness check ON-TRIAGE; §3.3 makes it a
// STANDING Claim. We split the two concerns the doc names: anchoring + consulting
// happen ON-TRIAGE (engine.ts), and re-validation is this SEPARATELY-INVOCABLE
// driver — a project-scoped sweep a scheduler/walker tick or an audit run calls.
// This mirrors the existing scheduled-audit loop (forge/audits) rather than coupling
// re-validation to the merge tick, and keeps the producer (a runner-bound `sem` call)
// off the hot triage path. Noted in the PR body as the chosen fork.
//
// NON-NEGOTIABLE (no-silent-fallback + §1 graceful fallback): a Claim SELF-RESOLVES
// ONLY on the oracle's positive-evidence `removed` verdict. When the producer is
// unavailable/errors/can't-parse, the probe is `unavailable` → the oracle keeps the
// Claim OPEN; the `producer-errored` case is logged LOUDLY (the legitimate-absent
// paths stay quiet). The driver NEVER auto-resolves on missing data.

import { systemActor } from "../../state/actor.js";
import { validateClaimAgainstEntity, type EntityProbeOutcome } from "../../oracle/index.js";
import { EntityClaimStore, type EntityClaim } from "../../repositories/entityClaims.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("claim-self-validation");

// The injectable entity-presence PRODUCER: given a Claim, probe its anchor entity
// against the current code (the runner-bound `sem` call in production; a fake in
// tests). It must NEVER throw to signal "no data" — it returns an `unavailable`
// outcome with a reason, so the absence stays loud-vs-quiet per the doctrine. A
// genuine bug MAY throw; the driver isolates a throw per-Claim (one bad probe never
// halts the sweep) and treats it as `producer-errored` (loud, stays open).
export interface EntityClaimProbe {
  probe(claim: EntityClaim): Promise<EntityProbeOutcome>;
}

// A `pg`-shaped client (the org-scope carrier). The sweep runs each org's Claims on
// its org-scoped client so RLS bounds the rows.
type QueryClient = Parameters<typeof EntityClaimStore.listOpenForProject>[0];

// The observable ledger-event sink for the self-validation transitions. Narrowed to
// the two events the driver emits (the anchor event is the triage path's). A
// project-scoped append (no runId).
export interface ClaimValidationEventSink {
  append(input: {
    projectId: string;
    eventType: "forge.claim.self_resolved" | "forge.claim.validated";
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface SelfValidateProjectInput {
  // The org-scoped client (RLS bounds the rows to this org).
  client: QueryClient;
  projectId: string;
  // The runner-bound entity producer.
  prober: EntityClaimProbe;
  // The observable event sink (optional — absent ⇒ persist-only, still observable
  // via the structured log).
  events?: ClaimValidationEventSink;
  // Max Claims to re-check this pass (the sweep is bounded; the store lists oldest-
  // validated first so the most stale anchors are re-checked first).
  limit?: number;
}

export interface SelfValidateProjectResult {
  checked: number;
  selfResolved: number;
  keptOpen: number;
  // The count whose probe was `unavailable` for the LOUD `producer-errored` reason
  // (vs the quiet legitimate-absent paths) — surfaced so a sweep can alert.
  unexpectedUnavailable: number;
}

// Re-validate a project's OPEN Claims. PURE-orchestration: every side effect (probe,
// persist, emit) goes through an injected seam, so a test drives the whole sweep with
// fakes and no runner/sem. One bad probe is isolated (logged, treated as
// `producer-errored` → stays open) so it never halts the sweep.
export async function selfValidateProjectClaims(input: SelfValidateProjectInput): Promise<SelfValidateProjectResult> {
  const limit = input.limit ?? 100;
  const open = await EntityClaimStore.listOpenForProject(input.client, input.projectId, limit, systemActor);

  const result: SelfValidateProjectResult = { checked: 0, selfResolved: 0, keptOpen: 0, unexpectedUnavailable: 0 };
  for (const claim of open) {
    const probe = await safeProbe(input.prober, claim);
    const verdict = validateClaimAgainstEntity(probe);
    result.checked += 1;

    const lastValidation: Record<string, unknown> = {
      probeStatus: probe.status,
      decidability: verdict.decidability,
      selfResolved: verdict.selfResolved,
      rationale: verdict.rationale,
      ...(verdict.unexpectedUnavailable && { unexpectedUnavailable: true }),
    };

    if (verdict.unexpectedUnavailable) {
      result.unexpectedUnavailable += 1;
      // No-silent-fallback: the producer ERRORED — log LOUDLY. The Claim still stays
      // OPEN (the oracle never resolves on absence); we surface the unexpected failure.
      log.warn(
        "entity producer errored re-validating a Claim; the Claim STAYS OPEN (never auto-resolved on a failure)",
        { claimId: claim.id, projectId: claim.projectId },
        { entityId: claim.entityId, rationale: verdict.rationale },
      );
    }

    if (verdict.selfResolved) {
      result.selfResolved += 1;
      const updated =
        (await EntityClaimStore.recordValidation(
          input.client,
          claim.id,
          { status: "self_resolved", decidability: verdict.decidability, lastValidation, resolved: true },
          systemActor,
        )) ?? claim;
      log.info("Claim SELF-RESOLVED: anchor entity is gone", {
        claimId: claim.id,
        entityId: claim.entityId,
      });
      await input.events?.append({
        projectId: updated.projectId,
        eventType: "forge.claim.self_resolved",
        payload: {
          claimId: updated.id,
          orgId: updated.orgId,
          projectId: updated.projectId,
          entityId: updated.entityId,
          entityName: updated.entityName,
          decidability: verdict.decidability,
          rationale: verdict.rationale,
        },
      });
      continue;
    }

    // Stays OPEN. Persist the read-out (+ re-anchor the display on a rename follow),
    // and emit the validated-kept-open event.
    result.keptOpen += 1;
    const updated =
      (await EntityClaimStore.recordValidation(
        input.client,
        claim.id,
        {
          status: "open",
          decidability: verdict.decidability,
          lastValidation,
          resolved: false,
          ...(verdict.followToName !== undefined && { entityName: verdict.followToName }),
          ...(verdict.followToPath !== undefined && { entityPath: verdict.followToPath }),
        },
        systemActor,
      )) ?? claim;
    await input.events?.append({
      projectId: updated.projectId,
      eventType: "forge.claim.validated",
      payload: {
        claimId: updated.id,
        orgId: updated.orgId,
        projectId: updated.projectId,
        entityId: updated.entityId,
        // `removed` never reaches here (it self-resolves); narrow to the kept-open set.
        probeStatus: probe.status === "removed" ? "present" : probe.status,
        decidability: verdict.decidability,
        unexpectedUnavailable: verdict.unexpectedUnavailable,
        rationale: verdict.rationale,
      },
    });
  }
  return result;
}

// Isolate a producer throw: a genuine bug in ONE probe must never halt the whole
// sweep. A throw is mapped to the loud `producer-errored` unavailable outcome (the
// Claim stays open; the failure is surfaced) — NEVER to a `removed` (that would
// auto-resolve on a failure, the exact anti-pattern the doctrine forbids).
async function safeProbe(prober: EntityClaimProbe, claim: EntityClaim): Promise<EntityProbeOutcome> {
  try {
    return await prober.probe(claim);
  } catch (error) {
    log.warn(
      "entity producer threw while probing a Claim; treating as producer-errored (Claim stays open)",
      { claimId: claim.id, projectId: claim.projectId },
      error,
    );
    return {
      status: "unavailable",
      unavailableReason: "producer-errored",
      rationale: `Entity producer threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
