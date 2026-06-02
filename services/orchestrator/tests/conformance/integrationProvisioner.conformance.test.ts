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
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import { SentryProvisioner } from "../../src/engine/providers/sentryProvisioner.js";
import { InMemoryIntegrationProvisioner } from "./fakes/inMemoryIntegrationProvisioner.js";
import { ScriptedSentryTransport } from "./fakes/scriptedSentryTransport.js";
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

// --- Sentry: the REAL SentryProvisioner driven over a SCRIPTED FAKE transport ---
// A token preloaded into the in-memory secret store satisfies the org grant; the
// scripted transport models the Sentry org. The seeded project ("acme-web") is
// the bind target. A fresh transport + store per make() keeps specs isolated.
const SENTRY_TOKEN_REF = "secret://org/sentry-token";
const SENTRY_SEEDED_SLUG = "acme-web";

function sentryGrant(): OrgGrant {
  return {
    providerKind: "sentry",
    credentialRef: SENTRY_TOKEN_REF,
    metadata: { orgSlug: "acme", team: "platform" },
  };
}

function makeSentry(): SentryProvisioner {
  const secrets = new InMemorySecretStore();
  // The org grant token lives in the secret store (resolved by ref, never inline).
  void secrets.put({ ref: SENTRY_TOKEN_REF, value: "org-token-value" });
  const transport = new ScriptedSentryTransport({
    existing: [{ slug: SENTRY_SEEDED_SLUG, name: "acme-web", platform: "node" }],
  });
  return new SentryProvisioner(transport, secrets);
}

describeIntegrationProvisionerConformance("SentryProvisioner (scripted transport)", {
  make: makeSentry,
  grant: sentryGrant,
  projectCtx,
  seededResourceId: SENTRY_SEEDED_SLUG,
});

describe("SentryProvisioner — Sentry-specific behavior", () => {
  it("discover() lists org projects as ExistingResource (slug → id, name → label)", async () => {
    const resources = await makeSentry().discover(sentryGrant());
    expect(resources).toContainEqual(expect.objectContaining({ id: SENTRY_SEEDED_SLUG, label: "acme-web" }));
  });

  it("provision() find-or-create is idempotent — a 2nd provision creates NO 2nd project", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: SENTRY_TOKEN_REF, value: "org-token-value" });
    const transport = new ScriptedSentryTransport();
    const provisioner = new SentryProvisioner(transport, secrets);
    const ctx = projectCtx("billing");

    const first = await provisioner.provision(sentryGrant(), ctx);
    const second = await provisioner.provision(sentryGrant(), ctx);

    // Exactly ONE project-create POST landed across both provisions.
    expect(transport.projectCreates).toBe(1);
    expect(first.projectConfig).toEqual(second.projectConfig);
    expect((first.projectConfig as { sentryProjectSlug: string }).sentryProjectSlug).toBe("billing");
  });

  it("provision() stores the DSN in the secret manager and the artifact carries ONLY the ref (never the DSN value)", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: SENTRY_TOKEN_REF, value: "org-token-value" });
    const transport = new ScriptedSentryTransport();
    const provisioner = new SentryProvisioner(transport, secrets);

    const artifact = await provisioner.provision(sentryGrant(), projectCtx("billing"));
    const ref = artifact.secretRefs?.["SENTRY_DSN"];
    expect(ref).toBeDefined();

    const stored = await secrets.get(ref as string);
    // The real DSN landed in the store.
    expect(stored?.value).toMatch(/^https:\/\//u);
    // The artifact ref is a POINTER, not the DSN value.
    expect(ref).not.toMatch(/^https:\/\//u);
    // No field of the artifact leaks the DSN value.
    expect(JSON.stringify(artifact)).not.toContain(stored?.value);
  });

  it("provision() emits a sentry inbox_source referencing the project slug + the org token ref (no token value)", async () => {
    const artifact = await makeSentry().provision(sentryGrant(), projectCtx("billing"));
    expect(artifact.inboxSource?.kind).toBe("sentry");
    expect(artifact.inboxSource?.config).toMatchObject({
      org: "acme",
      project: "billing",
      tokenRef: SENTRY_TOKEN_REF,
    });
    // The inbox source carries the token REF, never the resolved token value.
    expect(JSON.stringify(artifact.inboxSource)).not.toContain("org-token-value");
  });

  it("bind() links an existing project + ensures a DSN; binding an unknown slug rejects", async () => {
    const provisioner = makeSentry();
    const artifact = await provisioner.bind(sentryGrant(), SENTRY_SEEDED_SLUG, projectCtx("billing"));
    expect((artifact.projectConfig as { sentryProjectSlug: string }).sentryProjectSlug).toBe(SENTRY_SEEDED_SLUG);
    expect(artifact.secretRefs?.["SENTRY_DSN"]).toBeDefined();
    await expect(provisioner.bind(sentryGrant(), "ghost-project", projectCtx("p"))).rejects.toThrow(/unknown project/u);
  });

  it("registry: buildIntegrationProvisioner('sentry', { sentry }) constructs the real SentryProvisioner", () => {
    const provisioner = buildIntegrationProvisioner("sentry", {
      sentry: { http: new ScriptedSentryTransport(), secrets: new InMemorySecretStore() },
    });
    expect(provisioner).toBeInstanceOf(SentryProvisioner);
    expect(provisioner.capability()).toEqual(["errors"]);
  });

  it("registry: buildIntegrationProvisioner('sentry') without deps throws (no silent stub)", () => {
    expect(() => buildIntegrationProvisioner("sentry")).toThrow(/requires deps\.sentry/u);
  });
});

// --- Registry: an UNREGISTERED kind → hard-throw unconfigured provisioner ------
describe("buildIntegrationProvisioner registry (unregistered kinds)", () => {
  it("returns the hard-throw UnconfiguredIntegrationProvisioner for an unregistered kind", () => {
    const provisioner = buildIntegrationProvisioner("linear");
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
