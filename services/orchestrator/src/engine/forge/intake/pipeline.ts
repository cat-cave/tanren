// P1d autonomous intake — the shared push→triage→route pipeline
// (autonomy-engine.md §1d). One raw `IngestedItem` (from a webhook receiver or a
// poll) → real-LLM triage → either an autonomous DAG insert (auto_routable) or a
// candidate-inbox row for operator review (needs_call / dedupe_close). This is
// the SAME engine the manual `ingest` route runs; the only addition is that an
// `auto_routable` candidate is committed into the DAG immediately (no click).
//
// The triage answerer + the auto-route deps are injected, so the webhook receiver
// and the poller share one pipeline and tests drive it with a fake answerer.

import { systemActor } from "../../state/actor.js";
import { DiscoveryStore, type ExistingSpecSummary } from "../../repositories/discovery.js";
import {
  autoRouteCandidate,
  InboxStore,
  type AutoRouteDeps,
  type Candidate,
  type IngestedItem,
  type InboxEngineDeps,
  type InboxSource,
  type TriageAnswerer,
} from "../inbox/index.js";
import { TriageAnswererUnconfiguredError } from "../inbox/index.js";

type QueryClient = { query: InboxEngineDeps["pool"]["query"] };

async function loadExistingSpecs(client: QueryClient, projectId: string | null): Promise<ExistingSpecSummary[]> {
  if (projectId === null) return [];
  return DiscoveryStore.listExistingSpecs(client, projectId, systemActor);
}

export interface IntakePipelineDeps {
  pool: InboxEngineDeps["pool"];
  // The triage answerer — REQUIRED. Production resolves a real provider answerer
  // from the source's project `forge` routing; tests inject a fake. No fallback (§8a).
  answerer: TriageAnswerer;
  // The autonomous DAG-insert deps (system actor resolver). REQUIRED — intake is
  // autonomous by definition: an `auto_routable` candidate is committed, never parked.
  autoRoute: AutoRouteDeps;
}

export type IntakeOutcome =
  | { kind: "auto_routed"; candidate: Candidate; specId: string }
  | { kind: "inboxed"; candidate: Candidate };

/**
 * Triage one ingested item against the source's live DAG and route it: an
 * `auto_routable` verdict carrying a `routableSpec` is committed into the DAG
 * (returns `auto_routed` with the new spec id); everything else is upserted as a
 * candidate for operator review (`inboxed`). Idempotent in the store on
 * (source, externalId), so a re-delivered webhook or an overlapping poll never
 * double-inserts.
 */
export async function intakeItem(
  deps: IntakePipelineDeps,
  source: InboxSource,
  item: IngestedItem,
): Promise<IntakeOutcome> {
  const existingSpecs = await loadExistingSpecs(deps.pool as QueryClient, source.projectId);
  const triage = await deps.answerer.triage({
    candidate: {
      title: item.title,
      body: item.body,
      severity: item.severity,
      sourceKind: source.kind,
      projectId: item.projectId,
    },
    source,
    existingSpecs,
  });
  const status = triage.verdict === "auto_routable" ? "auto_routed" : "triaged";
  const candidate = await InboxStore.upsertCandidate(deps.pool, source, item, triage, status);

  // Autonomous DAG insert: an auto-routable candidate with a routable spec is
  // committed now (no operator). A candidate the source could not place (no
  // project) cannot be auto-routed, so it falls through to the inbox.
  if (status === "auto_routed" && triage.routableSpec !== null && candidate.projectId !== null) {
    const { candidate: routed, specId } = await autoRouteCandidate(
      { pool: deps.pool },
      candidate,
      triage.routableSpec,
      deps.autoRoute,
    );
    return { kind: "auto_routed", candidate: routed, specId };
  }
  return { kind: "inboxed", candidate };
}

export { TriageAnswererUnconfiguredError };
