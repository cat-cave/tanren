import { isDeepStrictEqual } from "node:util";
import type { CasByteStore, Digest } from "../contracts/cas.js";
import { parseDigest } from "../contracts/cas.js";
import type { QueryClient } from "../data/orgScopedDb.js";
import { EventRegistry } from "../events/index.js";
import type { AffectedSelectionV1 } from "../runtimeVerification/affectedSelection.js";
import {
  AFFECTED_SELECTION_FACT_MEDIA_TYPE,
  affectedSelectionEventPayload,
  decodeAffectedSelectionFact,
  selectionFromFact,
  type AffectedSelectionFactV1,
} from "../runtimeVerification/affectedSelectionFacts.js";
import type { BehaviorCoverageScope } from "./behaviorCoverageEdges.js";

interface SelectionEventRow {
  readonly payload: unknown;
}

interface LatestSelectionEventRow extends SelectionEventRow {
  readonly analysis_id: string;
}

export class AffectedSelectionFactNotFoundError extends Error {
  public override readonly name = "AffectedSelectionFactNotFoundError";
}

export class AffectedSelectionEventMismatchError extends Error {
  public override readonly name = "AffectedSelectionEventMismatchError";
}

export interface PersistedAffectedSelection {
  readonly fact: AffectedSelectionFactV1;
  readonly selection: AffectedSelectionV1;
}

export interface AffectedSelectionFactRepository {
  read(
    client: QueryClient,
    cas: CasByteStore,
    scope: BehaviorCoverageScope,
    analysisId: Digest,
  ): Promise<PersistedAffectedSelection>;
  readLatest(
    client: QueryClient,
    cas: CasByteStore,
    scope: BehaviorCoverageScope,
  ): Promise<PersistedAffectedSelection | undefined>;
}

async function readEvent(
  client: QueryClient,
  scope: BehaviorCoverageScope,
  analysisId: Digest,
): Promise<SelectionEventRow> {
  const result = await client.query<SelectionEventRow>(
    `SELECT payload
       FROM events
      WHERE org_id = $1
        AND project_id = $2
        AND event_type = 'behavior.coverage.selection_analyzed'
        AND payload->>'analysisId' = $3
      ORDER BY id DESC
      LIMIT 1`,
    [scope.orgId, scope.projectId, analysisId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AffectedSelectionFactNotFoundError(
      `affected selection ${analysisId} is unavailable in ${scope.orgId}/${scope.projectId}`,
    );
  }
  return row;
}

async function readSelection(
  client: QueryClient,
  cas: CasByteStore,
  scope: BehaviorCoverageScope,
  analysisId: Digest,
  knownEvent?: SelectionEventRow,
): Promise<PersistedAffectedSelection> {
  const event = knownEvent ?? (await readEvent(client, scope, analysisId));
  const artifact = await cas.get(scope.orgId, analysisId);
  if (artifact.mediaType !== AFFECTED_SELECTION_FACT_MEDIA_TYPE) {
    throw new AffectedSelectionEventMismatchError("selection event points at a non-selection CAS artifact");
  }
  const fact = decodeAffectedSelectionFact(artifact.bytes);
  if (fact.orgId !== scope.orgId || fact.projectId !== scope.projectId) {
    throw new AffectedSelectionEventMismatchError("selection CAS fact scope does not match the authorized event scope");
  }
  const selection = selectionFromFact(fact, analysisId);
  const parsedEvent = EventRegistry["behavior.coverage.selection_analyzed"].safeParse(event.payload);
  if (!parsedEvent.success || !isDeepStrictEqual(parsedEvent.data, affectedSelectionEventPayload(selection))) {
    throw new AffectedSelectionEventMismatchError("selection event payload does not match its immutable CAS fact");
  }
  return { fact, selection };
}

export const AffectedSelectionFactsStore: AffectedSelectionFactRepository = {
  read: readSelection,

  async readLatest(client, cas, scope): Promise<PersistedAffectedSelection | undefined> {
    const result = await client.query<LatestSelectionEventRow>(
      `SELECT payload, payload->>'analysisId' AS analysis_id
         FROM events
        WHERE org_id = $1
          AND project_id = $2
          AND event_type = 'behavior.coverage.selection_analyzed'
        ORDER BY id DESC
        LIMIT 1`,
      [scope.orgId, scope.projectId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return readSelection(client, cas, scope, parseDigest(row.analysis_id), row);
  },
};
