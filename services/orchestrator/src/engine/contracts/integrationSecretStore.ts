/**
 * Integration-specific generation-addressed secret store.
 * Does not widen the global SecretStore API.
 */

export interface StagedSecretHandle {
  readonly handle: string;
  readonly operationId: string;
}

export interface ExactSecretCoordinate {
  ref: string;
  generation: number;
}

export interface IntegrationSecretStore {
  /** Stage a credential under an operation id. Value is never readable via list. */
  stage(operationId: string, value: string): Promise<StagedSecretHandle>;
  /**
   * Create-only finalize into an immutable generation path (Vault KV CAS).
   * Never overwrites an active coordinate.
   */
  finalize(staged: StagedSecretHandle, ref: string, generation: number): Promise<ExactSecretCoordinate>;
  /** Read exact generation only — never "latest". */
  getExact(coordinate: ExactSecretCoordinate): Promise<string | undefined>;
  /** Explicit compensation for staged or orphaned finalized-but-uncommitted secrets. */
  compensate(handle: StagedSecretHandle | ExactSecretCoordinate): Promise<void>;
}

export function generationSecretRef(baseRef: string, generation: number): string {
  if (generation < 1 || !Number.isInteger(generation)) {
    throw new Error(`auth generation must be a positive integer, got ${generation}`);
  }
  return `${baseRef}/g/${generation}`;
}

export function connectionCredentialBaseRef(orgId: string, providerKind: string, connectionId: string): string {
  return `secret://org/${encodeURIComponent(orgId)}/integration/${encodeURIComponent(providerKind)}/connection/${encodeURIComponent(connectionId)}/token`;
}
