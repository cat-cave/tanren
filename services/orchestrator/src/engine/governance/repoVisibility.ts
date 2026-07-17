import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../eventStore.js";
import { PgEventStore } from "../eventStore.js";
import {
  RepositoryVisibilityObservationsStore,
  type RepositoryVisibility,
  type RepositoryVisibilityObservation,
} from "../repositories/repositoryVisibilityObservations.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface RepositoryVisibilityReadback {
  readonly observedVisibility: RepositoryVisibility;
  readonly forgeRef: string;
  readonly sha: string;
}

/** The dedicated Reviewer-App read surface; it has no write capabilities. */
export interface ReviewerAppIdentity {
  readRepositoryVisibility(input: { orgId: string; repoUrl: string }): Promise<RepositoryVisibilityReadback>;
}

export interface ObserveRepositoryVisibilityInput extends RepositoryVisibilityReadback {
  readonly orgId: string;
  readonly projectId: string;
}

export type RepositoryVisibilityDecision =
  | {
      readonly status: "allowed";
      readonly expectedVisibility: RepositoryVisibility;
      readonly observation: RepositoryVisibilityObservation;
    }
  | {
      readonly status: "blocked";
      readonly expectedVisibility: RepositoryVisibility;
      readonly observation: RepositoryVisibilityObservation;
    };

export class RepositoryVisibilityProjectNotFoundError extends Error {
  override readonly name = "RepositoryVisibilityProjectNotFoundError";

  constructor(orgId: string, projectId: string) {
    super(`project ${orgId}/${projectId} is not available for repository visibility enforcement`);
  }
}

export class RepositoryVisibilityDeclarationRequiredError extends Error {
  override readonly name = "RepositoryVisibilityDeclarationRequiredError";

  constructor(orgId: string, projectId: string) {
    super(`project ${orgId}/${projectId} has no declared repository visibility; enforcement is fail-closed`);
  }
}

/** The predicate that decides whether a forge readback satisfies project governance. */
export function repositoryVisibilityMatches(
  expectedVisibility: RepositoryVisibility,
  observedVisibility: RepositoryVisibility,
): boolean {
  return expectedVisibility === observedVisibility;
}

/**
 * Persist one immutable readback and append its auditable enforcement events.
 * The caller supplies an already org-scoped client, making the row and all events
 * one transaction when the normal PgEventStore is used.
 */
export async function enforceRepositoryVisibilityOnClient(
  client: QueryClient,
  eventStore: Pick<EventStore, "append">,
  input: ObserveRepositoryVisibilityInput,
): Promise<RepositoryVisibilityDecision> {
  const project = await RepositoryVisibilityObservationsStore.getProject(client, input.orgId, input.projectId);
  if (project === undefined) {
    throw new RepositoryVisibilityProjectNotFoundError(input.orgId, input.projectId);
  }
  if (project.declaredVisibility === null) {
    throw new RepositoryVisibilityDeclarationRequiredError(input.orgId, input.projectId);
  }

  const observation = await RepositoryVisibilityObservationsStore.record(client, input);
  const expectedVisibility = project.declaredVisibility;
  const matches = repositoryVisibilityMatches(expectedVisibility, observation.observedVisibility);

  await eventStore.append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "repository.visibility.observed",
    payload: {
      projectId: input.projectId,
      observationId: observation.observationId,
      observedVisibility: observation.observedVisibility,
      forgeRef: observation.forgeRef,
      sha: observation.sha,
    },
  });
  if (!matches) {
    await eventStore.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "repository.visibility.mismatch",
      payload: {
        projectId: input.projectId,
        observationId: observation.observationId,
        expectedVisibility,
        observedVisibility: observation.observedVisibility,
        forgeRef: observation.forgeRef,
        sha: observation.sha,
      },
    });
  }
  await eventStore.append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "governance.visibility.enforced",
    payload: {
      projectId: input.projectId,
      observationId: observation.observationId,
      visibility: expectedVisibility,
    },
  });

  return matches
    ? { status: "allowed", expectedVisibility, observation }
    : { status: "blocked", expectedVisibility, observation };
}

export class RepositoryVisibilityEnforcer {
  private readonly eventStore: Pick<EventStore, "append">;

  constructor(
    private readonly pool: pg.Pool,
    private readonly reviewerApp: ReviewerAppIdentity,
    eventStore?: Pick<EventStore, "append">,
  ) {
    this.eventStore = eventStore ?? new PgEventStore(pool);
  }

  async observe(input: { orgId: string; projectId: string }): Promise<RepositoryVisibilityDecision> {
    // Resolve the project before the external read so an ungoverned project never
    // causes a forge call. Re-read in the write transaction to close the decision
    // over the current declaration after network latency.
    const project = await runWithOrgScope(this.pool, input.orgId, (client) =>
      RepositoryVisibilityObservationsStore.getProject(client, input.orgId, input.projectId),
    );
    if (project === undefined) {
      throw new RepositoryVisibilityProjectNotFoundError(input.orgId, input.projectId);
    }
    if (project.declaredVisibility === null) {
      throw new RepositoryVisibilityDeclarationRequiredError(input.orgId, input.projectId);
    }
    const readback = await this.reviewerApp.readRepositoryVisibility({ orgId: input.orgId, repoUrl: project.repoUrl });
    return runWithOrgScope(this.pool, input.orgId, (client) =>
      enforceRepositoryVisibilityOnClient(client, this.eventStore, { ...input, ...readback }),
    );
  }
}
