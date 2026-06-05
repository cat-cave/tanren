// Per-implementation invocations of the IntegrationProvisioner conformance suite
// + the registry / resolveSmartDefault unit coverage. The foundation wave has NO
// real provider, so the contract is proven against the in-memory fake (the shape a
// real provider's behavior will be held to). As providers land Sentry/Slack/…,
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
import { FlyDeployProvisioner } from "../../src/engine/provisioners/flyDeployProvisioner.js";
import { VercelDeployProvisioner } from "../../src/engine/provisioners/vercelDeployProvisioner.js";
import { InMemoryIntegrationProvisioner } from "./fakes/inMemoryIntegrationProvisioner.js";
import { ScriptedSentryTransport } from "./fakes/scriptedSentryTransport.js";
import { scriptedDeployTransport } from "./fakes/scriptedDeployTransport.js";
import { SlackProvisioner } from "../../src/engine/integrations/slack/slackProvisioner.js";
import { ScriptedSlackTransport } from "./fakes/scriptedSlackTransport.js";
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

  it("provision() emits an errors-kind inbox_source referencing the project slug + the org token ref (no token value)", async () => {
    const artifact = await makeSentry().provision(sentryGrant(), projectCtx("billing"));
    // `errors` is the DB-allowed (inbox_sources_kind_check) + connector-registered
    // (connectorMap.ts) kind for Sentry intake; "sentry" would violate both.
    expect(artifact.inboxSource?.kind).toBe("errors");
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

// --- deploy provisioners: the SAME contract over both real providers ----
// driven against a scripted in-memory transport (no live Vercel/Fly calls). Each
// `make()` builds a fresh secret store (seeded with the org deploy token) + a
// transport seeded with one existing app, so the brownfield `bind` spec targets it.
const DEPLOY_TOKEN_REF = "secret://org/deploy-token";
const SEEDED_DEPLOY_APP = "seeded-app";

const deployGrant = (kind: string, metadata: Record<string, unknown>): OrgGrant => ({
  providerKind: kind,
  credentialRef: DEPLOY_TOKEN_REF,
  metadata,
});

function deploySecrets(): InMemorySecretStore {
  const secrets = new InMemorySecretStore();
  void secrets.put({ ref: DEPLOY_TOKEN_REF, value: "super-secret-deploy-token-value" });
  return secrets;
}

describeIntegrationProvisionerConformance("VercelDeployProvisioner", {
  make: () =>
    new VercelDeployProvisioner({
      transport: scriptedDeployTransport("vercel", [SEEDED_DEPLOY_APP]),
      secrets: deploySecrets(),
    }),
  grant: () => deployGrant("deploy.vercel", { teamId: "team_abc", slug: "acme" }),
  projectCtx,
  seededResourceId: "vercel_app_1",
});

describeIntegrationProvisionerConformance("FlyDeployProvisioner", {
  make: () =>
    new FlyDeployProvisioner({
      transport: scriptedDeployTransport("fly", [SEEDED_DEPLOY_APP]),
      secrets: deploySecrets(),
    }),
  grant: () => deployGrant("deploy.flyio", { orgSlug: "acme" }),
  projectCtx,
  seededResourceId: "fly_app_1",
});

// --- Contract conformance over the REAL SlackProvisioner -------------
// Driven against the scripted Slack transport (no real Slack call in CI). Seeded
// with one brownfield channel so the bind spec has a target. Each make() gets its
// own transport so the per-instance state (provision → discover) is isolated.
const slackGrant = (): OrgGrant => ({
  providerKind: "slack",
  credentialRef: "secret://org/slack-bot-token",
  metadata: { workspaceId: "T123" },
});

const SLACK_SEEDED_ID = "C_existing-team";

function makeSlackProvisioner(): SlackProvisioner {
  const transport = new ScriptedSlackTransport({
    channels: [{ id: SLACK_SEEDED_ID, name: "existing-team", isMember: false }],
    // page size 1 exercises cursor pagination across the conformance run
    pageSize: 1,
  });
  // eslint-disable-next-line @typescript-eslint/require-await
  return new SlackProvisioner({ transportFactory: async () => transport });
}

describeIntegrationProvisionerConformance("SlackProvisioner", {
  make: makeSlackProvisioner,
  grant: slackGrant,
  projectCtx,
  seededResourceId: SLACK_SEEDED_ID,
});

// --- Registry: sentry/deploy.*/slack registered; other kinds still hard-throw ---
describe("buildIntegrationProvisioner registry", () => {
  it("returns the hard-throw UnconfiguredIntegrationProvisioner for an unregistered kind", () => {
    const provisioner = buildIntegrationProvisioner("linear");
    expect(provisioner).toBeInstanceOf(UnconfiguredIntegrationProvisioner);
  });

  it("every operation on the unconfigured provisioner throws loudly (never a silent no-op)", async () => {
    const provisioner = buildIntegrationProvisioner("jira");
    expect(() => provisioner.capability()).toThrow(/not implemented/u);
    await expect(provisioner.discover(grant())).rejects.toThrow(/not implemented/u);
    await expect(provisioner.provision(grant(), projectCtx("p"))).rejects.toThrow(/not implemented/u);
    await expect(provisioner.bind(grant(), "x", projectCtx("p"))).rejects.toThrow(/not implemented/u);
  });

  it("registers the deploy.vercel + deploy.flyio provisioners (capability ['deploy'])", () => {
    const secrets = deploySecrets();
    const vercel = buildIntegrationProvisioner("deploy.vercel", {
      transport: scriptedDeployTransport("vercel"),
      secrets,
    });
    const fly = buildIntegrationProvisioner("deploy.flyio", {
      transport: scriptedDeployTransport("fly"),
      secrets,
    });
    expect(vercel).toBeInstanceOf(VercelDeployProvisioner);
    expect(fly).toBeInstanceOf(FlyDeployProvisioner);
    expect(vercel.capability()).toEqual(["deploy"]);
    expect(fly.capability()).toEqual(["deploy"]);
  });

  it("a deploy provisioner without a SecretStore in deps throws (no silent no-op)", () => {
    expect(() => buildIntegrationProvisioner("deploy.vercel")).toThrow(/SecretStore/u);
  });

  it("resolves the slack kind to the real SlackProvisioner (notify capability)", () => {
    // buildSecretStore needs a backend named; memory is the in-process test backend.
    const prior = process.env["TANREN_SECRET_STORE"];
    process.env["TANREN_SECRET_STORE"] = "memory";
    try {
      const provisioner = buildIntegrationProvisioner("slack");
      expect(provisioner).toBeInstanceOf(SlackProvisioner);
      expect(provisioner.capability()).toEqual(["notify"]);
    } finally {
      if (prior === undefined) {
        delete process.env["TANREN_SECRET_STORE"];
      } else {
        process.env["TANREN_SECRET_STORE"] = prior;
      }
    }
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
