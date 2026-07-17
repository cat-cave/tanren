import { randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type {
  AcquireFixtureLeaseInput,
  FixtureLease,
  FixtureLeaseAdapter,
  ObserveFixtureLeaseExpiryInput,
  ReleaseFixtureLeaseInput,
} from "../../contracts/fixtureLeaseAdapter.js";
import type { EventStore } from "../../eventStore.js";
import { PgEventStore } from "../../eventStore.js";
import { PgFixtureLeaseRepository } from "../../repositories/fixtureLeases.js";

type QueryClient = Pick<pg.PoolClient, "query">;
type OrgScope = <T>(orgId: string, operation: (client: QueryClient) => Promise<T>) => Promise<T>;
type LeaseEventStore = Pick<EventStore, "append">;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface PgFixtureLeaseAdapterDependencies {
  readonly repository?: PgFixtureLeaseRepository;
  readonly eventStore?: LeaseEventStore;
  /** Test seam for the conformance memory DB; production always uses runWithOrgScope. */
  readonly withOrgScope?: OrgScope;
}

function resourceRef(kind: string, leaseId: string): string {
  return `fixture://${kind}/${leaseId}`;
}

function assertDigest(value: string | undefined): void {
  if (value !== undefined && !SHA256_DIGEST.test(value)) {
    throw new TypeError("fixture lease cleanupEvidenceHash must be a sha256 digest");
  }
}

function assertDate(value: Date | undefined, field: string): void {
  if (value !== undefined && !Number.isFinite(value.getTime())) {
    throw new TypeError(`fixture lease ${field} must be a valid Date`);
  }
}

/** Postgres implementation of the frozen rv-7 fixture lease lifecycle port. */
export class PgFixtureLeaseAdapter implements FixtureLeaseAdapter {
  private readonly repository: PgFixtureLeaseRepository;
  private readonly eventStore?: LeaseEventStore;
  private readonly withOrgScope: OrgScope;

  public constructor(pool: pg.Pool, dependencies: PgFixtureLeaseAdapterDependencies = {}) {
    this.repository = dependencies.repository ?? new PgFixtureLeaseRepository(pool);
    this.eventStore = dependencies.eventStore;
    this.withOrgScope = dependencies.withOrgScope ?? ((orgId, operation) => runWithOrgScope(pool, orgId, operation));
  }

  public async acquire(input: AcquireFixtureLeaseInput): Promise<FixtureLease> {
    assertDate(input.expiresAt, "expiresAt");
    return this.withOrgScope(input.orgId, async (client) => {
      const leaseId = `fixture_lease_${randomUUID()}`;
      const result = await this.repository.acquireOnClient(client, {
        ...input,
        leaseId,
        resourceRef: resourceRef(input.kind, leaseId),
      });
      if (result.created) {
        await this.append(client, {
          orgId: input.orgId,
          projectId: input.projectId,
          eventType: "fixture.lease.acquired",
          payload: {
            projectId: result.lease.projectId,
            leaseId: result.lease.leaseId,
            kind: result.lease.kind,
            resourceRef: result.lease.resourceRef,
            correlationNamespace: result.lease.correlationNamespace,
          },
        });
      }
      return result.lease;
    });
  }

  public async release(input: ReleaseFixtureLeaseInput): Promise<FixtureLease | undefined> {
    assertDigest(input.cleanupEvidenceHash);
    return this.withOrgScope(input.orgId, async (client) => {
      const result = await this.repository.releaseOnClient(client, input);
      if (result.lease !== undefined && result.changed) {
        await this.append(client, {
          orgId: input.orgId,
          projectId: input.projectId,
          eventType: "fixture.lease.released",
          payload: {
            projectId: result.lease.projectId,
            leaseId: result.lease.leaseId,
            ...(result.lease.cleanupEvidenceHash === undefined
              ? {}
              : { cleanupEvidenceHash: result.lease.cleanupEvidenceHash }),
          },
        });
      }
      return result.lease;
    });
  }

  public async observeExpiry(input: ObserveFixtureLeaseExpiryInput): Promise<ReadonlyArray<FixtureLease>> {
    assertDate(input.observedAt, "observedAt");
    return this.withOrgScope(input.orgId, async (client) => {
      const expired = await this.repository.observeExpiryOnClient(client, input);
      for (const lease of expired) {
        await this.append(client, {
          orgId: input.orgId,
          projectId: input.projectId,
          eventType: "fixture.lease.expired",
          payload: {
            projectId: lease.projectId,
            leaseId: lease.leaseId,
            kind: lease.kind,
          },
        });
      }
      return expired;
    });
  }

  private async append(client: QueryClient, input: Parameters<LeaseEventStore["append"]>[0]): Promise<void> {
    const events = this.eventStore ?? new PgEventStore(client);
    await events.append(input);
  }
}
