// Seam conformance suite for the IntegrationProvisioner contract
// (`engine/contracts/integrationProvisioner.ts`). A reusable behavior spec
// invoked once per implementation via `describeIntegrationProvisionerConformance`.
// It asserts the CONTRACT only — the shape of `ProvisionedArtifact`, idempotent
// find-or-create on `provision`, `bind` over a discovered resource, and that the
// artifact carries secret REFS (never values) — never private fields. The same
// fixtures will validate every real provider (Sentry/Slack/deploy/…) as they land
// as providers land, so a new provider gets contract coverage by adding one entry to the
// per-impl invocation file. Mirrors the Allocator / VcsProvider conformance shape.

import { describe, expect, it } from "vitest";
import type {
  ExistingResource,
  IntegrationProvisioner,
  OrgGrant,
  ProjectContext,
} from "../../src/engine/contracts/integrationProvisioner.js";

/**
 * What a per-implementation test file hands the suite. `make()` returns a FRESH
 * provisioner (its own scaffolding) so each spec runs isolated. `grant()` /
 * `projectCtx()` return a valid org grant + project context for the impl. When the
 * impl is seeded with a brownfield resource, `seededResourceId` names it so the
 * `bind` spec can target it; omit it for a greenfield-only impl.
 */
export interface IntegrationProvisionerHarness {
  make(): IntegrationProvisioner;
  grant(): OrgGrant;
  projectCtx(projectId: string): ProjectContext;
  /** The id of a resource the made provisioner already has (for the bind spec). */
  seededResourceId: string;
}

function expectArtifactNeverLeaksSecretValue(secretRefs: Record<string, string> | undefined): void {
  if (secretRefs === undefined) {
    return;
  }
  for (const ref of Object.values(secretRefs)) {
    // A ref is a pointer, not the material — sanity-check it isn't raw key/token
    // material masquerading as a ref.
    expect(ref).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(typeof ref).toBe("string");
    expect(ref.length).toBeGreaterThan(0);
  }
}

export function describeIntegrationProvisionerConformance(label: string, harness: IntegrationProvisionerHarness): void {
  describe(`IntegrationProvisioner conformance: ${label}`, () => {
    it("capability() returns a non-empty list of capability ids", () => {
      const caps = harness.make().capability();
      expect(Array.isArray(caps)).toBe(true);
      expect(caps.length).toBeGreaterThan(0);
      caps.forEach((cap) => expect(typeof cap).toBe("string"));
    });

    it("discover() returns an array of well-formed ExistingResource", async () => {
      const resources = await harness.make().discover(harness.grant());
      expect(Array.isArray(resources)).toBe(true);
      resources.forEach((resource: ExistingResource) => {
        expect(typeof resource.id).toBe("string");
        expect(resource.id.length).toBeGreaterThan(0);
        expect(typeof resource.label).toBe("string");
      });
    });

    it("provision() returns a well-formed ProvisionedArtifact carrying only secret refs", async () => {
      const provisioner = harness.make();
      const artifact = await provisioner.provision(harness.grant(), harness.projectCtx("proj_conf_1"));
      expect(typeof artifact).toBe("object");
      expectArtifactNeverLeaksSecretValue(artifact.secretRefs);
    });

    it("provision() is idempotent — re-running yields the SAME resource, never a duplicate", async () => {
      const provisioner = harness.make();
      const ctx = harness.projectCtx("proj_conf_idem");
      const first = await provisioner.provision(harness.grant(), ctx);
      const before = (await provisioner.discover(harness.grant())).length;
      const second = await provisioner.provision(harness.grant(), ctx);
      const after = (await provisioner.discover(harness.grant())).length;
      // No new resource created on the second provision (find-or-create).
      expect(after).toBe(before);
      // The artifact identity is stable across re-provision.
      expect(JSON.stringify(second.projectConfig)).toBe(JSON.stringify(first.projectConfig));
    });

    it("provision() then discover() surfaces the created resource (brownfield can find it)", async () => {
      const provisioner = harness.make();
      const before = (await provisioner.discover(harness.grant())).length;
      await provisioner.provision(harness.grant(), harness.projectCtx("proj_conf_disc"));
      const after = await provisioner.discover(harness.grant());
      expect(after.length).toBe(before + 1);
    });

    it("bind() links an already-discovered resource and returns its artifact", async () => {
      const provisioner = harness.make();
      const artifact = await provisioner.bind(
        harness.grant(),
        harness.seededResourceId,
        harness.projectCtx("proj_conf_bind"),
      );
      expect(typeof artifact).toBe("object");
      expectArtifactNeverLeaksSecretValue(artifact.secretRefs);
    });

    it("bind() of an unknown resource id rejects (no silent success)", async () => {
      const provisioner = harness.make();
      await expect(
        provisioner.bind(harness.grant(), "does_not_exist", harness.projectCtx("proj_conf_bind_miss")),
      ).rejects.toThrow(Error);
    });
  });
}
