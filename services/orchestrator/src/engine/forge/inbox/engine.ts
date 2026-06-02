// P3-0022 candidate-inbox engine. Composes the existing foundations:
//
//   ingestSource(deps, source)
//     Pulls raw items from the source's CONNECTOR, triages each (over the
//     injectable answerer), and upserts candidates. A system source (autoRoute)
//     skips manual triage — its candidates land `auto_routed`; external sources'
//     candidates land `triaged`, awaiting an operator call.
//
//   acceptCandidate(deps, input)
//     The accept→discovery hand-off. It reuses the P3-0014 discovery engine's
//     `acceptProposals` to create the spec(s) + stamp provenance, then resolves
//     the candidate to `accepted` with the created spec-id. This deliberately
//     composes discovery rather than re-implementing spec creation.
//
//   foldCandidate / dismissCandidate / closeDuplicateCandidate
//     The other three hi-fi resolutions, each a status transition on the store.
//
// The triage answerer + the connectors are injected, so tests drive the whole
// flow with fakes and no provider/GitHub network — see candidateInbox.test.ts.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { systemActor } from "../../state/actor.js";
import { DiscoveryStore, type ExistingSpecSummary } from "../../repositories/discovery.js";
import { acceptProposals, type DiscoveryInsight, type PlacementKind, type ProposedSpec } from "../discovery/index.js";
import { getCandidate, resolveCandidate, upsertCandidate } from "./store.js";
import type {
  Candidate,
  CandidateTriage,
  InboxSource,
  SourceConnector,
  TriageAnswerer,
  TriageRoutableSpec,
} from "./types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface InboxEngineDeps {
  pool: pg.Pool;
  // Connectors keyed by source kind. The route wires the GitHub Issues
  // connector; tests inject fakes. A source with no connector is skipped.
  connectors: ReadonlyMap<string, SourceConnector>;
  // The triage answerer — REQUIRED for ingestion. Production resolves a real
  // provider answerer from the project's `forge` routing (the model reaches a
  // real verdict); tests inject a fake. There is NO production fallback to a
  // deterministic verdict (§8a). Only `ingestSource` consults it; the resolution
  // transitions (fold/dismiss/…) don't, so it is optional on the shared deps.
  answerer?: TriageAnswerer;
}

/** Thrown when `ingestSource` runs without a model triage answerer wired (§8a). */
export class TriageAnswererUnconfiguredError extends Error {
  constructor() {
    super("candidate triage requires a provider answerer; none was wired");
    this.name = "TriageAnswererUnconfiguredError";
  }
}

async function loadExistingSpecs(client: QueryClient, projectId: string | null): Promise<ExistingSpecSummary[]> {
  if (projectId === null) return [];
  return DiscoveryStore.listExistingSpecs(client, projectId, systemActor);
}

export interface IngestResult {
  candidates: Candidate[];
}

// Pull → triage → persist for a single source. When `autoRouteDeps` is wired,
// an `auto_routable` candidate carrying a `routableSpec` is INSERTED INTO THE DAG
// (autonomy-engine.md §1d) before it is returned — the autonomous-intake path;
// without it the candidate rests `auto_routed`/`triaged` for the operator.
export async function ingestSource(
  deps: InboxEngineDeps,
  source: InboxSource,
  autoRouteDeps?: AutoRouteDeps,
): Promise<IngestResult> {
  if (!source.enabled) return { candidates: [] };
  const connector = deps.connectors.get(source.kind);
  if (connector === undefined) return { candidates: [] };

  if (deps.answerer === undefined) {
    throw new TriageAnswererUnconfiguredError();
  }
  const answerer = deps.answerer;
  const items = await connector.fetch(source);
  const existingSpecs = await loadExistingSpecs(deps.pool, source.projectId);

  const out: Candidate[] = [];
  for (const item of items) {
    const triage: CandidateTriage = await answerer.triage({
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
    // System sources whose triage is auto-routable promote straight through.
    const status = triage.verdict === "auto_routable" ? "auto_routed" : "triaged";
    let candidate = await upsertCandidate(deps.pool, source, item, triage, status);
    // Autonomous DAG insert: when intake is autonomous and the model produced a
    // routable spec, commit it now (no operator) and resolve the candidate.
    if (autoRouteDeps !== undefined && status === "auto_routed" && triage.routableSpec !== null) {
      candidate = (await autoRouteCandidate(deps, candidate, triage.routableSpec, autoRouteDeps)).candidate;
    }
    out.push(candidate);
  }
  return { candidates: out };
}

/**
 * What the autonomous-intake path needs to COMMIT an auto-routable candidate's
 * spec into the DAG without an operator (autonomy-engine.md §1d). The walker, the
 * webhook receiver, and the poller all carry this so an `auto_routable` candidate
 * becomes a real spec — under RLS, org-scoped — instead of waiting for a click.
 */
export interface AutoRouteDeps {
  /** Resolve a system actor carrying the candidate's org so the spec write is RLS-scoped. */
  resolveActor: (orgId: string) => ActorContext;
}

export interface AutoRouteResult {
  candidate: Candidate;
  specId: string;
}

/**
 * Commit an auto-routable candidate's `routableSpec` into the DAG, reusing the
 * SAME discovery accept path (`acceptProposals`) as the operator click — so the
 * spec carries provenance + its dependency edges + priority (P1b), and the
 * DagWalker picks it up on the next tick. Resolves the candidate to `accepted`.
 */
export async function autoRouteCandidate(
  deps: Pick<InboxEngineDeps, "pool">,
  candidate: Candidate,
  routableSpec: TriageRoutableSpec,
  autoRouteDeps: AutoRouteDeps,
): Promise<AutoRouteResult> {
  if (candidate.projectId === null) throw new CandidateNotPlaceableError(candidate.id);
  const proposal: ProposedSpec = {
    proposalId: `auto_${candidate.id}`,
    title: routableSpec.title,
    description: routableSpec.description,
    acceptanceCriteria: routableSpec.acceptanceCriteria,
    dependsOn: routableSpec.dependsOn,
    priority: routableSpec.priority,
    estLabel: "",
  };
  const { accepted } = await acceptProposals(
    { pool: deps.pool },
    {
      projectId: candidate.projectId,
      insight: insightFor(candidate),
      proposals: [proposal],
      // A new ingested unit of work slots onto the backlog by default; the
      // model's `dependsOn` (carried onto the spec) determines real DAG order.
      placementKind: "slot_after",
      placementLabel: "auto-routed from intake",
      actor: autoRouteDeps.resolveActor(candidate.orgId),
    },
  );
  const specId = accepted[0]?.spec.specId ?? null;
  const resolved = await resolveCandidate(deps.pool, candidate.id, "accepted", specId);
  return { candidate: resolved ?? candidate, specId: specId ?? "" };
}

// Build a discovery insight from a candidate so the accept hand-off reuses the
// P3-0014 discovery accept path verbatim.
function insightFor(candidate: Candidate): DiscoveryInsight {
  const variant = candidate.triage?.discoveryVariant ?? "feature";
  return {
    variant,
    source: candidate.sourceName || candidate.sourceKind,
    sourceLabel: "candidate inbox",
    who: candidate.sourceName || candidate.sourceKind,
    when: "from inbox",
    glyph: variant === "bug" ? "×" : "◍",
    body: `${candidate.title}\n\n${candidate.body}`.slice(0, 8000) || candidate.title,
  };
}

export interface AcceptCandidateInput {
  candidateId: string;
  orgId: string;
  // The discovery proposals to commit (typically built from the candidate by
  // the surface or a follow-on classify). At least one is required.
  proposals: Parameters<typeof acceptProposals>[1]["proposals"];
  placementKind: PlacementKind;
  placementLabel: string;
  actor: ActorContext;
}

export class CandidateNotFoundError extends Error {
  constructor(candidateId: string) {
    super(`candidate not found: ${candidateId}`);
  }
}

export class CandidateNotPlaceableError extends Error {
  constructor(candidateId: string) {
    super(`candidate has no project to place into: ${candidateId}`);
  }
}

export interface AcceptCandidateResult {
  candidate: Candidate;
  specId: string;
}

// Accept → discovery: create the spec via the P3-0014 accept path, then resolve
// the candidate to `accepted` carrying the new spec-id.
export async function acceptCandidate(
  deps: InboxEngineDeps,
  input: AcceptCandidateInput,
): Promise<AcceptCandidateResult> {
  const candidate = await getCandidate(deps.pool, input.candidateId);
  if (candidate === undefined) throw new CandidateNotFoundError(input.candidateId);
  if (candidate.projectId === null) throw new CandidateNotPlaceableError(input.candidateId);

  const { accepted } = await acceptProposals(
    { pool: deps.pool },
    {
      projectId: candidate.projectId,
      insight: insightFor(candidate),
      proposals: input.proposals,
      placementKind: input.placementKind,
      placementLabel: input.placementLabel,
      actor: { ...input.actor, orgId: input.orgId },
    },
  );
  const specId = accepted[0]?.spec.specId ?? null;
  const resolved = await resolveCandidate(deps.pool, input.candidateId, "accepted", specId);
  return { candidate: resolved ?? candidate, specId: specId ?? "" };
}

// The remaining three resolutions are status transitions on the store.
export async function foldCandidate(deps: InboxEngineDeps, candidateId: string): Promise<Candidate> {
  return requireResolved(deps, candidateId, "folded");
}

export async function dismissCandidate(deps: InboxEngineDeps, candidateId: string): Promise<Candidate> {
  return requireResolved(deps, candidateId, "dismissed");
}

export async function closeDuplicateCandidate(deps: InboxEngineDeps, candidateId: string): Promise<Candidate> {
  return requireResolved(deps, candidateId, "closed_duplicate");
}

async function requireResolved(
  deps: InboxEngineDeps,
  candidateId: string,
  status: Candidate["status"],
): Promise<Candidate> {
  const resolved = await resolveCandidate(deps.pool, candidateId, status, null);
  if (resolved === undefined) throw new CandidateNotFoundError(candidateId);
  return resolved;
}
