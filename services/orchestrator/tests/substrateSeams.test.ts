// Unit coverage for the v21 execution-backend substrate seams that PROMOTE
// existing behavior to a single named contract: the CredentialMaterializer (one
// interface over the per-CLI materializers), the UsageMeter (one interface over
// the window monitor + ccusage accountant + cost resolver), and the
// ReleaseFinalizer (release + a reconcilable cleanup outcome).
import { describe, expect, it } from "vitest";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import type { Allocator, ReleaseReason } from "../src/engine/contracts/allocator.js";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { FakeCostResolver } from "../src/engine/contracts/costResolver.js";
import { AllocatorReleaseFinalizer } from "../src/engine/contracts/releaseFinalizer.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeCodexAuthBundle } from "../src/engine/credentials/codexAuth.js";
import { PerCliCredentialMaterializer } from "../src/engine/credentials/perCliCredentialMaterializer.js";
import { SshUsageMeter } from "../src/engine/usage/index.js";
import { fakeSshHandle } from "./conformance/commandSubstrateConformance.js";

describe("CredentialMaterializer seam (PerCliCredentialMaterializer)", () => {
  it("dispatches on cli and normalizes the per-CLI result into the seam's env map", async () => {
    const secrets = new FakeSecretStore();
    const authJson = JSON.stringify({ tokens: { access_token: "secret-token" } });
    await storeCodexAuthBundle(secrets, { ref: "credential/codex/dev", authJson });

    const materialized = await new PerCliCredentialMaterializer().materialize({
      cli: "codex",
      secrets,
      ssh: new FakeCommandSubstrate(),
      target: fakeSshHandle(),
      ref: "credential/codex/dev",
      runId: "run_seam_1",
    });

    expect(materialized.cli).toBe("codex");
    expect(materialized.env["CODEX_HOME"]).toBe("/home/tanren/.tanren/runs/run_seam_1/codex-home");
    expect(materialized.ref).toBe("credential/codex/dev");
    expect(materialized.managed).toBe(false);
    expect(materialized.redacted).toBe(true);
    // The secret value is NEVER on the redacted result.
    expect(JSON.stringify(materialized)).not.toContain("secret-token");
  });
});

describe("UsageMeter seam (SshUsageMeter)", () => {
  it("bundles the window monitor, accountant, and cost resolver as one meter", () => {
    const meter = new SshUsageMeter(new FakeCommandSubstrate(), new FakeCostResolver());
    expect(meter.monitor).toBeDefined();
    expect(meter.accountant).toBeDefined();
    expect(meter.costResolver).toBeDefined();
  });
});

describe("ReleaseFinalizer seam (AllocatorReleaseFinalizer)", () => {
  it("records a `released` outcome when the allocator releases cleanly", async () => {
    const outcome = await new AllocatorReleaseFinalizer(new FakeAllocator()).finalize("runner_1", "completed");
    expect(outcome).toEqual({ kind: "released", runnerId: "runner_1", reason: "completed" });
  });

  it("records a `leaked` outcome (never throws) when release fails — the sweeper reconciles it", async () => {
    const leaking: Allocator = {
      taxonomy: "provisioning" as const,
      allocate: () => {
        throw new Error("unused");
      },
      release: async (_runnerId: string, _reason?: ReleaseReason) => {
        throw new Error("destroy API timed out");
      },
    };
    const outcome = await new AllocatorReleaseFinalizer(leaking).finalize("runner_2", "failed");
    expect(outcome).toEqual({
      kind: "leaked",
      runnerId: "runner_2",
      reason: "failed",
      message: "destroy API timed out",
    });
  });
});
