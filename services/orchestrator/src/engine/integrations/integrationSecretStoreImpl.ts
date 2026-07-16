import {
  assertPrincipalVerificationPermit,
  type PrincipalVerificationPermit,
} from "../contracts/integrationAuthority.js";
import type { SecretStore } from "../contracts/secretStore.js";
import {
  generationSecretRef,
  type ExactSecretCoordinate,
  type IntegrationSecretStore,
  type StagedSecretHandle,
} from "../contracts/integrationSecretStore.js";

function stagedPath(operationId: string): string {
  return `secret://integration-stage/${encodeURIComponent(operationId)}`;
}

function isStaged(handle: StagedSecretHandle | ExactSecretCoordinate): handle is StagedSecretHandle {
  return "handle" in handle && "operationId" in handle;
}

/**
 * Generation-addressed integration secrets backed by a private SecretStore.
 * Create-only finalize: refuses to overwrite an existing generation path.
 * Staged reads are only available to principal verifiers that hold a permit.
 */
export class GenerationAddressedIntegrationSecretStore implements IntegrationSecretStore {
  private getExactCalls = 0;

  constructor(private readonly secrets: SecretStore) {}

  /** Test/observability: count of exact generation reads. */
  getExactCallCount(): number {
    return this.getExactCalls;
  }

  async stage(operationId: string, value: string): Promise<StagedSecretHandle> {
    if (operationId.trim() === "") throw new Error("operationId required to stage integration secret");
    if (value.trim() === "") throw new Error("credential value required to stage");
    const handle = stagedPath(operationId);
    await this.secrets.put({ ref: handle, value });
    return { handle, operationId };
  }

  async finalize(staged: StagedSecretHandle, ref: string, generation: number): Promise<ExactSecretCoordinate> {
    if (staged.handle !== stagedPath(staged.operationId)) {
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
    const existing = await this.secrets.get(coordinate.ref);
    if (existing !== undefined) {
      if (existing.value === stagedValue.value) {
        await this.secrets.delete(staged.handle);
        return coordinate;
      }
      throw new Error(`integration secret generation already exists: ${coordinate.ref}`);
    }
    await this.secrets.put({ ref: coordinate.ref, value: stagedValue.value });
    await this.secrets.delete(staged.handle);
    return coordinate;
  }

  async getExact(coordinate: ExactSecretCoordinate): Promise<string | undefined> {
    this.getExactCalls += 1;
    const baseRef = coordinate.ref.replace(/\/g\/\d+$/u, "");
    const ref = generationSecretRef(baseRef, coordinate.generation);
    const secret = await this.secrets.get(ref);
    return secret?.value;
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
