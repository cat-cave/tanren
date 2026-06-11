// §3.3 entity-anchored Claims — the ON-TRIAGE intake helpers (CONSULT + ANCHOR).
// Split out of engine.ts so that file stays under the 500-line architecture cap;
// the engine calls these from `ingestSource`. The self-validation RE-CHECK lives in
// claimSelfValidationDriver.ts (the standing sweep); this is purely the anchor +
// consult the doc places ON-TRIAGE (the durable form of the §2.3 one-shot check).

import type pg from "pg";
import { systemActor } from "../../state/actor.js";
import { EntityClaimStore } from "../../repositories/entityClaims.js";
import { createLogger } from "../../observability/logger.js";
import type { Candidate, CandidateTriage } from "./types.js";

const log = createLogger("intake-claims");

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// The observable ledger-event sink (§3.3). Narrowed to the one event the intake
// path emits — `forge.claim.anchored` — so the engine depends on the verb it
// uses, not the whole `EventStore`. The self-validation driver owns the
// self_resolved/validated events. A project-scoped append (no runId).
export interface ClaimEventSink {
  append(input: {
    projectId: string;
    eventType: "forge.claim.anchored";
    payload: {
      claimId: string;
      orgId: string;
      projectId: string;
      candidateId: string | null;
      entityId: string;
      entityKind: string;
      entityName: string;
    };
  }): Promise<void>;
}

// The Claim-ledger wiring on the inbox deps (optional within the deps; absent ⇒ the
// ledger is inert and ingestion behaves exactly as before — graceful, no Claim).
export interface ClaimLedgerConfig {
  // The observable ledger-event sink (optional within the ledger config — the
  // anchor still persists without it; the event is the only thing skipped).
  events?: ClaimEventSink;
}

// §3.3 CONSULT: does this candidate already carry a SELF-RESOLVED entity Claim? A
// prior triage anchored the candidate to an entity that the self-validation oracle
// later saw removed/refactored — so the candidate is a STALE issue and must not be
// re-routed as live. Org-scoped under RLS by the caller's pool/ambient scope (the
// Claim store reads only this org's rows).
export async function claimAlreadySelfResolved(client: QueryClient, candidateId: string): Promise<boolean> {
  const claims = await EntityClaimStore.listForCandidate(client, candidateId, systemActor);
  return claims.some((claim) => claim.status === "self_resolved");
}

// §3.3 ANCHOR: turn the triage's one-shot entity identity into a DURABLE Claim. When
// the candidate is project-placed AND the triage reported an `entityAnchor`, anchor
// (or idempotently refresh) a Claim keyed on the entity's structural-hash identity,
// then emit the observable `forge.claim.anchored` event. No anchor / no project ⇒
// no Claim (a broad feature request the agent could not anchor stays ledger-less).
export async function anchorClaimForCandidate(
  pool: pg.Pool,
  ledger: ClaimLedgerConfig,
  candidate: Candidate,
  triage: CandidateTriage,
): Promise<void> {
  const anchor = triage.entityAnchor;
  if (anchor === null || candidate.projectId === null) return;

  const claim = await EntityClaimStore.anchor(
    pool,
    {
      orgId: candidate.orgId,
      projectId: candidate.projectId,
      candidateId: candidate.id,
      entityId: anchor.entityId,
      entityKind: anchor.kind,
      entityName: anchor.name,
      entityPath: anchor.path,
    },
    systemActor,
  );
  log.info("anchored a durable entity Claim for candidate", {
    candidateId: candidate.id,
    claimId: claim.id,
    entityId: claim.entityId,
  });
  if (ledger.events !== undefined) {
    await ledger.events.append({
      projectId: claim.projectId,
      eventType: "forge.claim.anchored",
      payload: {
        claimId: claim.id,
        orgId: claim.orgId,
        projectId: claim.projectId,
        candidateId: claim.candidateId,
        entityId: claim.entityId,
        entityKind: claim.entityKind,
        entityName: claim.entityName,
      },
    });
  }
}
