// TEST FIXTURE ONLY. An in-memory `CredentialRegistry` double for tests that
// want to assert registry state directly without a SecretStore round-trip.
// Production wiring uses the durable `SecretStoreCredentialRegistry` (records
// persist in the SecretStore so the credential LIST survives a restart) — this
// in-memory variant must never appear in any production/runtime path.
import type { CredentialRecord, CredentialRegistry } from "../../src/routes/credentials/index.js";

export class InMemoryCredentialRegistry implements CredentialRegistry {
  private readonly records = new Map<string, CredentialRecord>();

  async list(args: { scope: "org" | "me"; ownerId: string }): Promise<CredentialRecord[]> {
    return [...this.records.values()].filter(
      (record) => record.scope === args.scope && record.ownerId === args.ownerId,
    );
  }

  async get(ref: string): Promise<CredentialRecord | undefined> {
    return this.records.get(ref);
  }

  async put(record: CredentialRecord): Promise<void> {
    this.records.set(record.ref, record);
  }

  async delete(ref: string): Promise<void> {
    this.records.delete(ref);
  }
}
