// Seam conformance suite for the product-plane ApplicationIntegrationProvisioner
// contract. A reusable behavior spec invoked once per implementation via
// `describeApplicationIntegrationProvisionerConformance`. It asserts the CONTRACT
// only — `plan` compiles a product plan, idempotent find-or-create on `provision`,
// `bind` over a discovered resource (and rejection of an unknown id), the observe/
// reconcile/rotate/teardown lifecycle, that artifacts carry only refs/coordinates
// (never secret values), and the VERTICAL seam (the artifact is accepted by the
// in-14 BindingMaterializer's ResolvedBinding shape, and a control-plane output is
// rejected). Mirrors the control-plane IntegrationProvisioner conformance shape;
// every real product provider (relay, in-13 Slack, …) is held to it.

import { describe, expect, it } from "vitest";
import type {
  ApplicationIntegrationProvisioner,
  ProvisionedApplicationArtifact,
} from "../../src/engine/contracts/applicationIntegrationProvisioner.js";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import type { IntegrationRequirementV1 } from "../../src/engine/contracts/integrationRequirement.js";
import {
  projectIntegrationOperationTarget,
  type IntegrationOperationTarget,
  type IntegrationPrivilegedOperation,
} from "../../src/engine/contracts/integrationAuthority.js";
import {
  applicationArtifactToResolvedBinding,
  ProductProvisionFailedError,
} from "../../src/engine/integrations/product/applicationProvisionerKit.js";

export interface ApplicationProvisionerHarness {
  /** A FRESH provisioner (own scaffolding) per spec so each runs isolated. */
  make(): ApplicationIntegrationProvisioner;
  /** The product requirement the provisioner plans + provisions from. */
  requirement(): IntegrationRequirementV1;
  /** A valid org grant for the (operation, target) issued through the real authority. */
  grant(
    operation: IntegrationPrivilegedOperation,
    projectCtx: ProjectContext,
    target: IntegrationOperationTarget,
  ): Promise<OrgGrant>;
  projectCtx(projectId: string): ProjectContext;
  /** The id of a resource the made provisioner already has (for the bind spec). */
  seededResourceId: string;
  /** Direct credentials rotate at IntegrationAuthority, never inside the provider. */
  supportsProviderCredentialRotation?: boolean;
  /** Direct channels have no durable ownership marker and must not be deleted. */
  supportsProviderTeardown?: boolean;
}

const provisionTarget = (ctx: ProjectContext): IntegrationOperationTarget => projectIntegrationOperationTarget(ctx);
const bindTarget = (ctx: ProjectContext, id: string): IntegrationOperationTarget =>
  projectIntegrationOperationTarget(ctx, id);

function assertNoSecretValueLeak(artifact: ProvisionedApplicationArtifact): void {
  const serialized = JSON.stringify(artifact);
  expect(serialized).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  for (const resolved of artifact.outputs) {
    const hasPlain = resolved.plainValue !== undefined;
    const hasSecret = resolved.secretSource !== undefined;
    // Exactly one resolution coordinate, and a secret is a REF, never a value.
    expect(hasPlain !== hasSecret).toBe(true);
    // A secret output must be a `secret://` pointer; a plain output uses a sentinel
    // so the assertion stays unconditional (no conditional expect).
    expect(resolved.secretSource?.ref ?? "secret://plain").toMatch(/^secret:\/\//u);
  }
}

export function describeApplicationIntegrationProvisionerConformance(
  label: string,
  harness: ApplicationProvisionerHarness,
): void {
  describe(`ApplicationIntegrationProvisioner conformance: ${label}`, () => {
    it("capability() returns a non-empty list of capability ids", () => {
      const caps = harness.make().capability();
      expect(Array.isArray(caps)).toBe(true);
      expect(caps.length).toBeGreaterThan(0);
      caps.forEach((cap) => expect(typeof cap).toBe("string"));
    });

    it("plan() compiles a product-plane plan from the requirement", () => {
      const ctx = harness.projectCtx("proj_plan");
      const plan = harness.make().plan(harness.requirement(), ctx);
      expect(plan.providerKind.length).toBeGreaterThan(0);
      expect(["test", "preview", "production"]).toContain(plan.environment);
      expect(plan.bindingOutputs.length).toBeGreaterThan(0);
      plan.bindingOutputs.forEach((output) => expect(output.kind.startsWith("product.")).toBe(true));
    });

    it("discover() returns an array of well-formed ExistingResource", async () => {
      const ctx = harness.projectCtx("proj_discover");
      const resources = await harness.make().discover(await harness.grant("discover", ctx, {}), ctx);
      expect(Array.isArray(resources)).toBe(true);
      resources.forEach((resource) => {
        expect(typeof resource.id).toBe("string");
        expect(resource.id.length).toBeGreaterThan(0);
        expect(typeof resource.label).toBe("string");
      });
    });

    it("provision() returns a well-formed product artifact carrying only refs/coordinates", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_provision");
      const plan = provisioner.plan(harness.requirement(), ctx);
      const artifact = await provisioner.provision(
        await harness.grant("provision", ctx, provisionTarget(ctx)),
        plan,
        ctx,
      );
      expect(artifact.outputs.length).toBe(plan.bindingOutputs.length);
      artifact.outputs.forEach((output) => expect(output.output.kind.startsWith("product.")).toBe(true));
      assertNoSecretValueLeak(artifact);
    });

    it("provision() is idempotent — re-running yields the SAME resource, never a duplicate", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_idem");
      const plan = provisioner.plan(harness.requirement(), ctx);
      const first = await provisioner.provision(await harness.grant("provision", ctx, provisionTarget(ctx)), plan, ctx);
      const before = (await provisioner.discover(await harness.grant("discover", ctx, {}), ctx)).length;
      const second = await provisioner.provision(
        await harness.grant("provision", ctx, provisionTarget(ctx)),
        plan,
        ctx,
      );
      const after = (await provisioner.discover(await harness.grant("discover", ctx, {}), ctx)).length;
      expect(after).toBe(before);
      expect(second.externalResourceId).toBe(first.externalResourceId);
    });

    it("provision() then discover() surfaces the created resource (brownfield can find it)", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_surface");
      const plan = provisioner.plan(harness.requirement(), ctx);
      const before = (await provisioner.discover(await harness.grant("discover", ctx, {}), ctx)).length;
      await provisioner.provision(await harness.grant("provision", ctx, provisionTarget(ctx)), plan, ctx);
      const after = (await provisioner.discover(await harness.grant("discover", ctx, {}), ctx)).length;
      expect(after).toBe(before + 1);
    });

    it("bind() links an already-discovered resource and returns its artifact", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_bind");
      const plan = provisioner.plan(harness.requirement(), ctx);
      const artifact = await provisioner.bind(
        await harness.grant("bind", ctx, bindTarget(ctx, harness.seededResourceId)),
        harness.seededResourceId,
        plan,
        ctx,
      );
      expect(artifact.ownership).toBe("adopted");
      assertNoSecretValueLeak(artifact);
    });

    it("bind() of an unknown resource id rejects (no silent success)", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_bind_miss");
      const plan = provisioner.plan(harness.requirement(), ctx);
      await expect(
        provisioner.bind(
          await harness.grant("bind", ctx, bindTarget(ctx, "does_not_exist")),
          "does_not_exist",
          plan,
          ctx,
        ),
      ).rejects.toThrow(ProductProvisionFailedError);
    });

    it("observe() reports the binding present after provision", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_observe");
      const plan = provisioner.plan(harness.requirement(), ctx);
      await provisioner.provision(await harness.grant("provision", ctx, provisionTarget(ctx)), plan, ctx);
      const observation = await provisioner.observe(await harness.grant("discover", ctx, {}), ctx);
      expect(observation.present).toBe(true);
      expect(observation.drift).toEqual([]);
    });

    it("reconcile() converges idempotently to the same resource", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_reconcile");
      const plan = provisioner.plan(harness.requirement(), ctx);
      const first = await provisioner.provision(await harness.grant("provision", ctx, provisionTarget(ctx)), plan, ctx);
      const reconciled = await provisioner.reconcile(
        await harness.grant("provision", ctx, provisionTarget(ctx)),
        plan,
        ctx,
      );
      expect(reconciled.externalResourceId).toBe(first.externalResourceId);
    });

    it("rotate() either confirms a new provider credential generation or fails closed when authority-owned", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_rotate");
      const plan = provisioner.plan(harness.requirement(), ctx);
      const before = await provisioner.provision(
        await harness.grant("provision", ctx, provisionTarget(ctx)),
        plan,
        ctx,
      );
      const outcome = await provisioner
        .rotate(await harness.grant("provision", ctx, provisionTarget(ctx)), plan, ctx)
        .then((rotated) => ({
          kind: "returned" as const,
          typedError: false,
          resourcePreserved: rotated.externalResourceId === before.externalResourceId,
          workloadChanged: rotated.receipt?.["workloadGeneration"] !== before.receipt?.["workloadGeneration"],
        }))
        .catch((error: unknown) => ({
          kind: "failed" as const,
          typedError: error instanceof ProductProvisionFailedError,
          resourcePreserved: false,
          workloadChanged: false,
        }));
      const ownsRotation = harness.supportsProviderCredentialRotation !== false;
      expect(outcome.kind).toBe(ownsRotation ? "returned" : "failed");
      expect(outcome.typedError).toBe(!ownsRotation);
      expect(outcome.resourcePreserved).toBe(ownsRotation);
      expect(outcome.workloadChanged).toBe(ownsRotation);
    });

    it("teardown() removes a created resource, or rejects where durable ownership is unavailable", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_teardown");
      const plan = provisioner.plan(harness.requirement(), ctx);
      await provisioner.provision(await harness.grant("provision", ctx, provisionTarget(ctx)), plan, ctx);
      const outcome = await provisioner
        .teardown(await harness.grant("provision", ctx, provisionTarget(ctx)), ctx)
        .then(() => ({ kind: "returned" as const, typedError: false }))
        .catch((error: unknown) => ({
          kind: "failed" as const,
          typedError: error instanceof ProductProvisionFailedError,
        }));
      const observation = await provisioner.observe(await harness.grant("discover", ctx, {}), ctx);
      const ownsTeardown = harness.supportsProviderTeardown !== false;
      expect(outcome.kind).toBe(ownsTeardown ? "returned" : "failed");
      expect(outcome.typedError).toBe(!ownsTeardown);
      expect(observation.present).toBe(!ownsTeardown);
    });

    it("VERTICAL: the artifact converts to a materializer-valid ResolvedBinding", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_vertical");
      const plan = provisioner.plan(harness.requirement(), ctx);
      const grant = await harness.grant("provision", ctx, provisionTarget(ctx));
      const artifact = await provisioner.provision(grant, plan, ctx);
      const resolved = applicationArtifactToResolvedBinding(artifact, grant, ctx, plan);
      expect(resolved.outputs.length).toBe(artifact.outputs.length);
      expect(resolved.bindingId.length).toBeGreaterThan(0);
      expect(resolved.environment).toBe(plan.environment);
      resolved.outputs.forEach((output) => {
        const hasSecret = output.secretSource !== undefined;
        const hasPlain = output.plainValue !== undefined;
        expect(hasSecret !== hasPlain).toBe(true);
        expect(output.secret).toBe(hasSecret);
      });
    });

    it("VERTICAL: a control-plane output on a product artifact is rejected (wrong-plane catch)", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_wrong_plane");
      const plan = provisioner.plan(harness.requirement(), ctx);
      const grant = await harness.grant("provision", ctx, provisionTarget(ctx));
      const artifact = await provisioner.provision(grant, plan, ctx);
      const poisoned: ProvisionedApplicationArtifact = {
        ...artifact,
        outputs: [
          {
            output: {
              version: 1,
              kind: "control.notify.bot_token_ref",
              logicalKey: "SLACK_BOT_TOKEN",
              classification: "secret_ref",
              required: true,
            },
            secretSource: { ref: "secret://control/bot-token/g/1", generation: 1 },
          },
        ],
      };
      expect(() => applicationArtifactToResolvedBinding(poisoned, grant, ctx, plan)).toThrow(
        ProductProvisionFailedError,
      );
    });
  });
}
