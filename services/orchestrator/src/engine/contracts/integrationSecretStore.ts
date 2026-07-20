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

/** An immutable generation coordinate was already occupied by different bytes. */
export class IntegrationSecretConflictError extends Error {
  public override readonly name = "IntegrationSecretConflictError";
}

export interface IntegrationSecretStore {
  /** Fail-closed capability used before an operation or provider call begins. */
  supportsAtomicFinalization(): boolean;
  /** Stage a credential under an operation id. Value is never readable via list. */
  stage(operationId: string, value: string): Promise<StagedSecretHandle>;
  /**
   * Create-only finalize into an immutable generation path (Vault KV CAS).
   * Never overwrites an active coordinate.
   */
  finalize(staged: StagedSecretHandle, ref: string, generation: number): Promise<ExactSecretCoordinate>;
  /** Read exact generation only — never "latest". */
  getExact(coordinate: ExactSecretCoordinate): Promise<string | undefined>;
  /** Delete staged material only after the database activation transaction commits. */
  completeStaged(staged: StagedSecretHandle): Promise<void>;
  /** Explicit compensation for staged or orphaned finalized-but-uncommitted secrets. */
  compensate(handle: StagedSecretHandle | ExactSecretCoordinate): Promise<void>;
}

export function generationSecretRef(baseRef: string, generation: number): string {
  if (generation < 1 || !Number.isInteger(generation)) {
    throw new Error(`auth generation must be a positive integer, got ${generation}`);
  }
  return `${baseRef}/g/${generation}`;
}

/**
 * The canonical Vault ref for a generation-addressed secret coordinate: strip any
 * embedded `/g/N` off the ref and re-append the AUTHORITATIVE `generation`. This is
 * the SINGLE secret-resolution both the in-15 proof gate (via
 * {@link IntegrationSecretStore.getExact}) and the deploy attach
 * (`resolveAppEnvForScope`) use, so the bytes PROVEN equal the bytes SHIPPED — a
 * `value_ref` that embeds a different `/g/M` can never redirect attach off the
 * proven coordinate (the generation column is the authority, not the ref suffix).
 */
export function exactSecretRef(valueRef: string, generation: number): string {
  return generationSecretRef(valueRef.replace(/\/g\/\d+$/u, ""), generation);
}

/** The generation embedded in a `value_ref`'s trailing `/g/N`, or undefined if none. */
export function embeddedRefGeneration(valueRef: string): number | undefined {
  const match = /\/g\/(\d+)$/u.exec(valueRef);
  return match === null ? undefined : Number(match[1]);
}

export function integrationStagedSecretRef(operationId: string): string {
  return `secret://integration-stage/${encodeURIComponent(operationId)}`;
}

export function connectionCredentialBaseRef(orgId: string, providerKind: string, connectionId: string): string {
  return `secret://org/${encodeURIComponent(orgId)}/integration/${encodeURIComponent(providerKind)}/connection/${encodeURIComponent(connectionId)}/token`;
}
