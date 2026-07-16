import type { PrincipalVerificationPermit } from "../contracts/integrationAuthority.js";
import { assertPrincipalVerificationPermit } from "./integrationAuthorityImpl.js";
import type { SecretStore } from "../contracts/secretStore.js";
import {
  generationSecretRef,
  integrationStagedSecretRef,
  type ExactSecretCoordinate,
  IntegrationSecretConflictError,
  type IntegrationSecretStore,
  type StagedSecretHandle,
} from "../contracts/integrationSecretStore.js";

function isStaged(handle: StagedSecretHandle | ExactSecretCoordinate): handle is StagedSecretHandle {
  return "handle" in handle && "operationId" in handle;
}

/**
 * Generation-addressed integration secrets backed by a private SecretStore.
 * Create-only finalize uses SecretStore.putCreateOnly (Vault KV v2 CAS=0).
 * Staged reads are only available to principal verifiers that hold a permit.
 */
export class GenerationAddressedIntegrationSecretStore implements IntegrationSecretStore {
  private getExactCalls = 0;

  constructor(private readonly secrets: SecretStore) {}

  supportsAtomicFinalization(): boolean {
    return this.secrets.createOnlyAtomicity === "atomic";
  }

  /** Test/observability: count of exact generation reads. */
  getExactCallCount(): number {
    return this.getExactCalls;
  }

  async stage(operationId: string, value: string): Promise<StagedSecretHandle> {
    if (operationId.trim() === "") throw new Error("operationId required to stage integration secret");
    if (value.trim() === "") throw new Error("credential value required to stage");
    const handle = integrationStagedSecretRef(operationId);
    await this.secrets.put({ ref: handle, value });
    return { handle, operationId };
  }

  async finalize(staged: StagedSecretHandle, ref: string, generation: number): Promise<ExactSecretCoordinate> {
    if (!this.supportsAtomicFinalization()) {
      throw new Error("integration_secret_atomic_finalization_unavailable");
    }
    if (staged.handle !== integrationStagedSecretRef(staged.operationId)) {
      throw new Error("staged secret handle does not match operation");
    }
    const stagedValue = await this.secrets.get(staged.handle);
    if (stagedValue === undefined) {
      throw new Error(`staged secret missing for operation ${staged.operationId}`);
    }
    const baseRef = ref.replace(/\/g\/\d+$/u, "");
    const coordinate: ExactSecretCoordinate = {
      ref: generationSecretRef(baseRef, generation),
      generation,
    };
    // True create-only — no get→put race, never overwrite an occupied generation.
    const result = await this.secrets.putCreateOnly({ ref: coordinate.ref, value: stagedValue.value });
    if (result.status === "conflict_different_value") {
      throw new IntegrationSecretConflictError(`integration secret generation already exists: ${coordinate.ref}`);
    }
    // created | already_exists_identical — both are success. The saga retains
    // staged bytes until the database activation transaction has committed.
    return coordinate;
  }

  async getExact(coordinate: ExactSecretCoordinate): Promise<string | undefined> {
    this.getExactCalls += 1;
    const baseRef = coordinate.ref.replace(/\/g\/\d+$/u, "");
    const ref = generationSecretRef(baseRef, coordinate.generation);
    const secret = await this.secrets.get(ref);
    return secret?.value;
  }

  async completeStaged(staged: StagedSecretHandle): Promise<void> {
    if (staged.handle !== integrationStagedSecretRef(staged.operationId)) {
      throw new Error("staged secret handle does not match operation");
    }
    await this.secrets.delete(staged.handle);
  }

  async compensate(handle: StagedSecretHandle | ExactSecretCoordinate): Promise<void> {
    if (isStaged(handle)) {
      await this.secrets.delete(handle.handle);
      return;
    }
    const baseRef = handle.ref.replace(/\/g\/\d+$/u, "");
    await this.secrets.delete(generationSecretRef(baseRef, handle.generation));
  }

  /** Sealed: only principal verifiers holding a permit may read staged credentials. */
  async readStagedForPermit(permit: PrincipalVerificationPermit, staged: StagedSecretHandle): Promise<string> {
    assertPrincipalVerificationPermit(permit);
    if (staged.operationId !== permit.operationId || staged.handle !== permit.stagedSecretHandle) {
      throw new Error("staged credential handle does not match verification permit");
    }
    const secret = await this.secrets.get(staged.handle);
    if (secret === undefined) {
      throw new Error(`staged secret missing for operation ${staged.operationId}`);
    }
    return secret.value;
  }
}
