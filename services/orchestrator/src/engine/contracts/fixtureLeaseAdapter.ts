export type FixtureLeaseKind = "org" | "account" | "channel" | "dataset";
export type FixtureLeaseState = "leased" | "released" | "expired";

/** A durable, org-scoped fixture lease; implementations own provider lifecycle work. */
export interface FixtureLease {
  orgId: string;
  projectId: string;
  leaseId: string;
  kind: FixtureLeaseKind;
  resourceRef: string;
  correlationNamespace: string;
  state: FixtureLeaseState;
  acquiredAt: Date;
  expiresAt?: Date;
  cleanupEvidenceHash?: string;
}

export interface AcquireFixtureLeaseInput {
  orgId: string;
  projectId: string;
  kind: FixtureLeaseKind;
  correlationNamespace: string;
  expiresAt?: Date;
}

export interface ReleaseFixtureLeaseInput {
  orgId: string;
  projectId: string;
  leaseId: string;
  cleanupEvidenceHash?: string;
}

export interface ObserveFixtureLeaseExpiryInput {
  orgId: string;
  projectId: string;
  observedAt?: Date;
}

/** Type-only rv-7 port; the owning lane supplies implementations and conformance. */
export interface FixtureLeaseAdapter {
  acquire(input: AcquireFixtureLeaseInput): Promise<FixtureLease>;
  release(input: ReleaseFixtureLeaseInput): Promise<FixtureLease | undefined>;
  observeExpiry(input: ObserveFixtureLeaseExpiryInput): Promise<ReadonlyArray<FixtureLease>>;
}
