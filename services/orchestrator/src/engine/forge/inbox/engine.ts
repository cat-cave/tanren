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
import { acceptProposals, type DiscoveryInsight, type PlacementKind } from "../discovery/index.js";
import { createDeterministicTriageAnswerer } from "./defaultAnswerer.js";
import {
  getCandidate,
  resolveCandidate,
  upsertCandidate
} from "./store.js";
import type {
  Candidate,
  CandidateTriage,
  InboxSource,
  SourceConnector,
  TriageAnswerer
} from "./types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface InboxEngineDeps {
  pool: pg.Pool;
  // Connectors keyed by source kind. The route wires the GitHub Issues
  // connector; tests inject fakes. A source with no connector is skipped.
  connectors: ReadonlyMap<string, SourceConnector>;
  // Injectable triage answerer; defaults to the deterministic grounded one.
  answerer?: TriageAnswerer;
}

async function loadExistingSpecs(
  client: QueryClient,
  projectId: string | null
): Promise<Array<{ specId: string; title: string; status: string }>> {
  if (projectId === null) return [];
  const result = await client.query<{ spec_id: string; title: string; status: string }>(
    "SELECT spec_id, title, status FROM specs WHERE project_id = $1 ORDER BY title",
    [projectId]
  );
  return result.rows.map((r) => ({ specId: r.spec_id, title: r.title, status: r.status }));
}

export interface IngestResult {
  candidates: Candidate[];
}

// Pull → triage → persist for a single source.
export async function ingestSource(deps: InboxEngineDeps, source: InboxSource): Promise<IngestResult> {
  if (!source.enabled) return { candidates: [] };
  const connector = deps.connectors.get(source.kind);
  if (connector === undefined) return { candidates: [] };

  const answerer = deps.answerer ?? createDeterministicTriageAnswerer();
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
        projectId: item.projectId
      },
      source,
      existingSpecs
    });
    // System sources whose triage is auto-routable promote straight through.
    const status = triage.verdict === "auto_routable" ? "auto_routed" : "triaged";
    out.push(await upsertCandidate(deps.pool, source, item, triage, status));
  }
  return { candidates: out };
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
    body: `${candidate.title}\n\n${candidate.body}`.slice(0, 8000) || candidate.title
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
  input: AcceptCandidateInput
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
      actor: { ...input.actor, orgId: input.orgId }
    }
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
  status: Candidate["status"]
): Promise<Candidate> {
  const resolved = await resolveCandidate(deps.pool, candidateId, status, null);
  if (resolved === undefined) throw new CandidateNotFoundError(candidateId);
  return resolved;
}
