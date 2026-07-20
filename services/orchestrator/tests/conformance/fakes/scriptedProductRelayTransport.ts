// Scripted in-memory ProductRelayTransport — a TEST FIXTURE (tests/ only) that
// models Tanren's managed relay behaviorally so the RelayMessagingProvisioner runs
// with no live relay call. `registerBinding` is idempotent find-or-create keyed on
// stableKey; it records every relay CONTROL token it is handed so a spec can assert
// the token was resolved through the lease (never inlined). Never reaches a
// production src/ path.

import type {
  ProductRelayTransport,
  RegisterRelayBindingRequest,
  RelayBinding,
} from "../../../src/engine/integrations/product/relayMessagingProvisioner.js";

export class ScriptedProductRelayTransport implements ProductRelayTransport {
  private readonly byStableKey = new Map<string, RelayBinding>();
  private readonly stableKeyById = new Map<string, string>();
  /** Every token the provisioner handed the relay (asserts lease resolution). */
  public readonly tokensSeen: string[] = [];
  /** Count of actual channel creations (idempotency assertion). */
  public registerCount = 0;
  public rotateCount = 0;
  public revokeCount = 0;
  private seq = 0;

  constructor(seed: readonly RelayBinding[] = []) {
    for (const binding of seed) {
      this.byStableKey.set(binding.stableKey, binding);
      this.stableKeyById.set(binding.bindingId, binding.stableKey);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async registerBinding(token: string, req: RegisterRelayBindingRequest): Promise<RelayBinding> {
    this.tokensSeen.push(token);
    const existing = this.byStableKey.get(req.stableKey);
    if (existing !== undefined) {
      return existing;
    }
    this.seq += 1;
    this.registerCount += 1;
    const binding: RelayBinding = {
      bindingId: `relay-binding-${this.seq}`,
      channelId: `chan-${this.seq}`,
      channelName: req.channelName,
      stableKey: req.stableKey,
      workloadGeneration: 1,
      receiptId: `receipt-${this.seq}`,
      created: true,
    };
    this.byStableKey.set(binding.stableKey, binding);
    this.stableKeyById.set(binding.bindingId, binding.stableKey);
    return binding;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getBinding(token: string, _orgId: string, stableKey: string): Promise<RelayBinding | undefined> {
    this.tokensSeen.push(token);
    return this.byStableKey.get(stableKey);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listBindings(token: string, _orgId: string): Promise<readonly RelayBinding[]> {
    this.tokensSeen.push(token);
    return [...this.byStableKey.values()];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async rotateWorkloadCredential(token: string, _orgId: string, bindingId: string): Promise<RelayBinding> {
    this.tokensSeen.push(token);
    const stableKey = this.stableKeyById.get(bindingId);
    const current = stableKey === undefined ? undefined : this.byStableKey.get(stableKey);
    if (current === undefined) {
      throw new Error(`relay binding '${bindingId}' not found`);
    }
    this.rotateCount += 1;
    this.seq += 1;
    const rotated: RelayBinding = {
      ...current,
      workloadGeneration: current.workloadGeneration + 1,
      receiptId: `receipt-${this.seq}`,
    };
    this.byStableKey.set(rotated.stableKey, rotated);
    return rotated;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async revokeBinding(token: string, _orgId: string, bindingId: string): Promise<void> {
    this.tokensSeen.push(token);
    const stableKey = this.stableKeyById.get(bindingId);
    if (stableKey === undefined) {
      throw new Error(`relay binding '${bindingId}' not found`);
    }
    this.revokeCount += 1;
    this.byStableKey.delete(stableKey);
    this.stableKeyById.delete(bindingId);
  }
}
