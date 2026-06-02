// Per-implementation invocations of the IntegrationProvisioner conformance suite
// + the registry / resolveSmartDefault unit coverage. The foundation wave has NO
// real provider, so the contract is proven against the in-memory fake (the shape a
// real provider's behavior will be held to). When P-INT-1+ land Sentry/Slack/…,
// each adds one `describeIntegrationProvisionerConformance(...)` entry here — the
// "slottable implementation" enabler, exactly like the allocator conformance file.

import { describe, expect, it } from "vitest";
import {
  buildIntegrationProvisioner,
  resolveSmartDefault,
  UnconfiguredIntegrationProvisioner,
  type ExistingResource,
  type OrgGrant,
  type ProjectContext,
} from "../../src/engine/contracts/integrationProvisioner.js";
import { InMemoryIntegrationProvisioner } from "./fakes/inMemoryIntegrationProvisioner.js";
import { describeIntegrationProvisionerConformance } from "./integrationProvisionerConformance.js";

const grant = (): OrgGrant => ({
  providerKind: "sentry",
  credentialRef: "secret://org/sentry-token",
  metadata: { orgSlug: "acme" },
});

const projectCtx = (projectId: string): ProjectContext => ({
  projectId,
  orgId: "org_conf",
  stack: "node",
  name: projectId,
});

const SEEDED: ExistingResource = { id: "existing-1", label: "acme-web", metadata: {} };

// Contract conformance over the fake (greenfield + a seeded brownfield resource).
describeIntegrationProvisionerConformance("InMemoryIntegrationProvisioner", {
  make: () => new InMemoryIntegrationProvisioner({ capabilities: ["errors"], existing: [SEEDED] }),
  grant,
  projectCtx,
  seededResourceId: SEEDED.id,
});

// --- Registry: empty in the foundation wave → hard-throw for every kind --------
describe("buildIntegrationProvisioner registry (foundation wave: no providers)", () => {
  it("returns the hard-throw UnconfiguredIntegrationProvisioner for any kind", () => {
    const provisioner = buildIntegrationProvisioner("sentry");
    expect(provisioner).toBeInstanceOf(UnconfiguredIntegrationProvisioner);
  });

  it("every operation on the unconfigured provisioner throws loudly (never a silent no-op)", async () => {
    const provisioner = buildIntegrationProvisioner("slack");
    expect(() => provisioner.capability()).toThrow(/not implemented/u);
    await expect(provisioner.discover(grant())).rejects.toThrow(/not implemented/u);
    await expect(provisioner.provision(grant(), projectCtx("p"))).rejects.toThrow(/not implemented/u);
    await expect(provisioner.bind(grant(), "x", projectCtx("p"))).rejects.toThrow(/not implemented/u);
  });
});

// --- resolveSmartDefault (O-3) -------------------------------------------------
describe("resolveSmartDefault", () => {
  const discovered: ExistingResource[] = [
    { id: "r1", label: "acme-web", metadata: {} },
    { id: "r2", label: "acme-api", metadata: {} },
  ];

  it("greenfield → always create", () => {
    expect(resolveSmartDefault(discovered, "greenfield", { name: "acme-web" })).toEqual({ action: "create" });
    // Even with no discovered resources, greenfield creates.
    expect(resolveSmartDefault([], "greenfield", { name: "anything" })).toEqual({ action: "create" });
  });

  it("brownfield with a matching discovered resource → bind that resource", () => {
    expect(resolveSmartDefault(discovered, "brownfield", { name: "acme-api" })).toEqual({
      action: "bind",
      resourceId: "r2",
    });
  });

  it("brownfield match is case-insensitive + trims", () => {
    expect(resolveSmartDefault(discovered, "brownfield", { name: "  ACME-WEB  " })).toEqual({
      action: "bind",
      resourceId: "r1",
    });
  });

  it("brownfield with no matching resource → create", () => {
    expect(resolveSmartDefault(discovered, "brownfield", { name: "new-project" })).toEqual({ action: "create" });
    expect(resolveSmartDefault([], "brownfield", { name: "acme-web" })).toEqual({ action: "create" });
  });
});
