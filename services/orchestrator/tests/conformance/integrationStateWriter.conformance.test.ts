// Conformance lock for the integration lifecycle plane split. It deliberately
// drives the in-memory provider's reconciliation path rather than merely
// type-checking the fake: lifecycle state must travel through the writer.

import { describe, expect, it } from "vitest";
import type {
  ClaimedIntegrationReconciliation,
  ClaimIntegrationReconciliationInput,
  CompleteIntegrationReconciliationInput,
  HeartbeatIntegrationReconciliationInput,
  IntegrationStateWriter,
  MarkIntegrationReconciliationStateUnknownInput,
} from "../../src/engine/contracts/integrationStateWriter.js";
import { testOrgGrant } from "../helpers/orgGrant.js";
import { InMemoryIntegrationProvisioner } from "./fakes/inMemoryIntegrationProvisioner.js";

class RecordingIntegrationStateWriter implements IntegrationStateWriter {
  readonly calls: string[] = [];
  readonly stateUnknownResults: boolean[] = [];
  readonly transitions: string[] = [];
  completeResult = true;
  private status: "pending" | "claimed" | "completed" | "state_unknown" = "pending";
  private claimOwner: string | undefined;
  private claimExpiresAt = 0;

  async claim(input: ClaimIntegrationReconciliationInput): Promise<ClaimedIntegrationReconciliation | undefined> {
    this.calls.push(`claim:${input.reconciliationId}`);
    if (this.status !== "pending") return undefined;
    this.status = "claimed";
    this.claimOwner = input.claimOwner;
    this.claimExpiresAt = Date.now() + input.leaseMs;
    return { projectId: "project_writer", requirementId: "requirement_writer", phase: "provision", attempt: 1 };
  }

  async heartbeat(input: HeartbeatIntegrationReconciliationInput): Promise<boolean> {
    this.calls.push(`heartbeat:${input.reconciliationId}`);
    if (!this.holdsLiveClaim(input)) return false;
    this.claimExpiresAt = Date.now() + input.leaseMs;
    return true;
  }

  async complete(input: CompleteIntegrationReconciliationInput): Promise<boolean> {
    this.calls.push(`complete:${input.reconciliationId}:${input.status}`);
    if (!this.holdsLiveClaim(input)) return false;
    // In production a false result is a claim-owner/expiry fence miss, never a
    // still-live claimant declining to complete. Model that here so a test
    // cannot accidentally combine complete=false with stateUnknown=true.
    if (!this.completeResult) {
      this.claimExpiresAt = Date.now() - 1;
      return false;
    }
    this.status = "completed";
    this.claimOwner = undefined;
    return true;
  }

  async stateUnknown(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean> {
    this.calls.push(`state_unknown:${input.reconciliationId}`);
    const marked = this.holdsLiveClaim(input);
    this.stateUnknownResults.push(marked);
    if (marked) this.transitionToStateUnknown();
    return marked;
  }

  async stateUnknownAfterClaimLost(input: MarkIntegrationReconciliationStateUnknownInput): Promise<boolean> {
    this.calls.push(`state_unknown_after_claim_lost:${input.reconciliationId}`);
    const marked = this.status === "claimed" && !this.holdsLiveClaim(input);
    this.stateUnknownResults.push(marked);
    if (marked) this.transitionToStateUnknown();
    return marked;
  }

  private holdsLiveClaim(input: { claimOwner: string }): boolean {
    return this.status === "claimed" && this.claimOwner === input.claimOwner && this.claimExpiresAt > Date.now();
  }

  private transitionToStateUnknown(): void {
    this.status = "state_unknown";
    this.claimOwner = undefined;
    this.transitions.push("integration.reconcile.state_unknown");
  }
}

describe("IntegrationStateWriter conformance — in-memory provisioner data plane", () => {
  it("exercises the writer seam and exposes no direct lifecycle mutation surface", async () => {
    const writer = new RecordingIntegrationStateWriter();
    const provisioner = new InMemoryIntegrationProvisioner();
    const projectCtx = { orgId: "org_writer", projectId: "project_writer", orgSlug: "writer", name: "writer" };
    const grant = await testOrgGrant({
      orgId: projectCtx.orgId,
      projectId: projectCtx.projectId,
      providerKind: "sentry",
      capability: "errors",
      operation: "provision",
    });

    const result = await provisioner.reconcile({
      writer,
      reconciliationId: "reconciliation_writer",
      claimOwner: "data-plane-worker",
      leaseMs: 30_000,
      grant,
      projectCtx,
    });

    expect(result.status).toBe("completed");
    expect(writer.calls).toEqual(["claim:reconciliation_writer", "complete:reconciliation_writer:succeeded"]);
    // The provider has external-resource state only. It cannot receive a query
    // client or call a direct integration_reconciliations mutation method.
    expect(Reflect.get(provisioner, "query")).toBeUndefined();
    expect(Reflect.get(provisioner, "setIntegrationLifecycleState")).toBeUndefined();
  });

  it("records state_unknown through the lost-claim writer path when lifecycle completion loses its claim", async () => {
    const writer = new RecordingIntegrationStateWriter();
    writer.completeResult = false;
    const provisioner = new InMemoryIntegrationProvisioner();
    const projectCtx = { orgId: "org_writer", projectId: "project_writer", orgSlug: "writer" };
    const grant = await testOrgGrant({
      orgId: projectCtx.orgId,
      projectId: projectCtx.projectId,
      providerKind: "sentry",
      capability: "errors",
      operation: "provision",
    });

    await expect(
      provisioner.reconcile({
        writer,
        reconciliationId: "reconciliation_lost",
        claimOwner: "data-plane-worker",
        leaseMs: 30_000,
        grant,
        projectCtx,
      }),
    ).rejects.toThrow(/lost its claim/u);
    expect(writer.calls).toEqual([
      "claim:reconciliation_lost",
      "complete:reconciliation_lost:succeeded",
      "state_unknown:reconciliation_lost",
      "state_unknown_after_claim_lost:reconciliation_lost",
    ]);
    // The normal stateUnknown fence matches the complete fence: a lost claim
    // must not silently report a successful owner-scoped state_unknown write.
    expect(writer.stateUnknownResults).toEqual([false, true]);
    // The fallback is a real lifecycle transition, not just an ignored false.
    expect(writer.transitions).toEqual(["integration.reconcile.state_unknown"]);
  });
});
