// Shared in-memory RunnerStore fake for the cloud + long-lived allocator tests.
// Hoisted here so each allocator test file stays under the 500-line cap after
// the Codex H3 #13 fix (persisted `providerMetadata` at claim time; DB-backed
// `readTeardownDescriptor` on the cold-start release path). The fake records
// claim + release calls and mirrors the persisted-DB fallback shape a restart
// test needs: `readTeardownDescriptor` returns the metadata written at claim
// time, minus any runner already released — so a test can share ONE store
// across two allocator instances (drop the first, spawn a fresh one on the
// same store) to exercise the process-restart shape end-to-end.
import type { ClaimRunnerInput, RunnerStore } from "../src/engine/allocators/runnerStore.js";

export class FakeRunnerStore implements RunnerStore {
  readonly claims: ClaimRunnerInput[] = [];
  readonly releases: string[] = [];
  async claim(input: ClaimRunnerInput): Promise<void> {
    this.claims.push(input);
  }
  async release(runnerId: string): Promise<void> {
    this.releases.push(runnerId);
  }
  async readTeardownDescriptor(runnerId: string) {
    if (this.releases.includes(runnerId)) return;
    return this.claims.find((c) => c.runnerId === runnerId)?.providerMetadata ?? undefined;
  }
}
