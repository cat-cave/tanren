// GV-15: production dashboard mount + strict governance fact reads. The mock
// is the orchestrator HTTP boundary; createApp mounts the real screen registry.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = { id: "org_acme", kind: "github_org", login: "cat-cave", displayName: "Cat Cave", role: "org:admin" };
const PROJECT = {
  projectId: "project_easy",
  name: "tanren-fixture-easy",
  repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};
const HASH = `sha256:${"a".repeat(64)}`;
const REVISION = {
  id: "policy_revision_1",
  projectId: PROJECT.projectId,
  revisionNumber: 1,
  schemaVersion: 1,
  sourceDocument: { apiVersion: "tanren.dev/governance/v2" },
  compiledAst: { rules: [] },
  policyHash: HASH,
  createdBy: "user_admin",
  createdAt: "2026-07-21T00:00:00.000Z",
  status: "inactive",
};
const TIER = {
  id: "governance_tier_private",
  projectId: PROJECT.projectId,
  tierName: "private",
  preset: "private",
  tierJson: { apiVersion: "tanren.dev/governance/v2" },
  canonicalHash: HASH,
  state: "active",
  createdAt: "2026-07-21T00:00:00.000Z",
};
const BINDING = {
  id: "policy_binding_1",
  projectId: PROJECT.projectId,
  tierId: TIER.id,
  effectivePolicyHash: HASH,
  isActive: true,
  createdAt: "2026-07-21T00:00:00.000Z",
};
const FRAGMENT_CONFIG = {
  apiVersion: "tanren.dev/governance-fragments/v1",
  schemaVersion: 1,
  fragments: [
    {
      fragmentId: "private-policy",
      version: "1.0.0",
      dependsOn: [],
      derivation: {
        personaRevisionIds: [],
        behaviorRevisionIds: [],
        designEntityIds: [],
        riskClassifications: ["private"],
      },
      requiredPolicy: {
        core: { rules: [] },
        org: { rules: [] },
        tier: { rules: [{ key: "repository.visibility", value: "private" }] },
        binding: { rules: [] },
      },
    },
  ],
};
const RECEIPT = {
  id: "effective_policy_snapshot_1",
  projectId: PROJECT.projectId,
  bindingId: BINDING.id,
  tierId: TIER.id,
  policyRevisionId: REVISION.id,
  effectivePolicyHash: HASH,
  compiledBody: { apiVersion: "tanren.dev/governance/v2", rules: [] },
  subjectKind: "activation",
  subjectId: BINDING.id,
  inputsDigest: HASH,
  createdAt: "2026-07-21T00:00:00.000Z",
  createdBy: "user_admin",
};
let revisions: (typeof REVISION)[];
let bindings: (typeof BINDING)[];
let bindingReceipt: typeof RECEIPT;
let revisionStatus: number;
let bindingReceiptStatus: number;
let receiptReads: string[];
let activationReadStatus: "inactive" | "active";
let capturedWrites: Array<{ path: string; body: unknown; headers: Record<string, string> }>;

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    if (path === "/auth/me") return json({ userId: "u1", csrfToken: "csrf-live", expiresAt: "2030-01-01" });
    if (path === "/orgs") return json({ orgs: [ORG] });
    if (path === `/orgs/${ORG.id}/projects`) return json({ projects: [PROJECT] });
    const base = `/orgs/${ORG.id}/projects/${PROJECT.projectId}/governance`;
    if (method === "GET" && path === `${base}/revisions`) return json({ revisions }, revisionStatus);
    if (method === "GET" && path === `${base}/tiers`) return json({ tiers: [TIER] });
    if (method === "GET" && path === `${base}/bindings`) return json({ bindings });
    if (method === "GET" && path === `${base}/effective/activation/${BINDING.id}`) {
      receiptReads.push(path);
      return bindingReceiptStatus === 200
        ? json({ snapshot: bindingReceipt })
        : json({ error: "effective_policy_snapshot_not_found" }, bindingReceiptStatus);
    }
    if (method === "GET" && path.startsWith(`${base}/effective/`))
      return json({ error: "effective_policy_snapshot_not_found" }, 404);
    if (method === "POST") {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      capturedWrites.push({ path, body, headers: (init?.headers ?? {}) as Record<string, string> });
      if (path === `${base}/revisions`) {
        const created = { ...REVISION, id: "policy_revision_2", revisionNumber: 2, parentRevisionId: REVISION.id };
        revisions = [REVISION, created];
        return json(
          { revision: created, fragmentSnapshot: [], fragmentSnapshotDiff: { added: [], removed: [], changed: [] } },
          201,
        );
      }
      if (path === `${base}/revisions/${REVISION.id}/activate`) {
        revisions = revisions.map((revision) =>
          revision.id === REVISION.id ? { ...revision, status: activationReadStatus } : revision,
        );
        return json({ revision: { ...REVISION, status: "active" } });
      }
      if (path === `${base}/tiers/${TIER.id}/bind`)
        return json({ tier: TIER, binding: BINDING, policyRevisionId: REVISION.id }, 201);
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  revisions = [REVISION];
  bindings = [BINDING];
  bindingReceipt = RECEIPT;
  revisionStatus = 200;
  bindingReceiptStatus = 200;
  receiptReads = [];
  activationReadStatus = "active";
  capturedWrites = [];
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("Governance Studio", () => {
  it("mounts through the real screen registry and renders lineage, binding, and its exact activation receipt", async () => {
    const app = await build();
    const html = await (await app.request("/governance?projectId=project_easy")).text();
    expect(app.routes.filter((route) => route.method === "GET" && route.path === "/governance")).toHaveLength(1);
    expect(html).toContain("governance studio");
    expect(html).toContain('data-governance-revision="policy_revision_1"');
    expect(html).toContain('data-governance-active-tier="governance_tier_private"');
    expect(html).toContain('data-governance-receipt="effective_policy_snapshot_1"');
    expect(html).toContain('data-nav-id="governance"');
  });

  it("fails loudly on a failed primary read instead of rendering an empty or active policy", async () => {
    revisionStatus = 500;
    const html = await (await (await build()).request("/governance?projectId=project_easy")).text();
    expect(html).toContain("data-governance-studio-unavailable");
    expect(html).toContain("This is not an empty or active policy state.");
    expect(html).not.toContain("data-governance-active-tier");
    expect(html).not.toContain("data-governance-revisions-empty");
  });

  it("rejects multiple active bindings as malformed rather than selecting one", async () => {
    bindings = [BINDING, { ...BINDING, id: "policy_binding_2" }];
    const html = await (await (await build()).request("/governance?projectId=project_easy")).text();
    expect(html).toContain("data-governance-studio-unavailable");
    expect(html).toContain("malformed or inconsistent");
    expect(html).not.toContain("data-governance-active-tier");
  });

  it("renders a legitimate zero-binding project as unbound, never as an active default", async () => {
    bindings = [];
    const html = await (await (await build()).request("/governance?projectId=project_easy")).text();
    expect(html).toContain("data-governance-unbound");
    expect(html).not.toContain("data-governance-active-tier");
    expect(html).not.toContain("data-governance-receipt=");
  });

  it("keeps an absent exact receipt visible as not found and never displays a fabricated policy body", async () => {
    const html = await (
      await (await build()).request("/governance?projectId=project_easy&receiptKind=run&receiptId=run_missing")
    ).text();
    expect(html).toContain("data-governance-receipt-not-found");
    expect(html).toContain("No compiled policy is displayed.");
    expect(html).not.toContain('data-governance-receipt="effective_policy_snapshot_1"');
  });

  it("marks both active claims unverified when the binding activation receipt is not found", async () => {
    bindingReceiptStatus = 404;
    const html = await (await (await build()).request("/governance?projectId=project_easy")).text();
    expect(html).toContain("data-governance-receipt-not-found");
    expect(html).not.toContain("data-governance-active-tier");
    expect(html).not.toContain('data-governance-binding-state="active"');
    expect(html).toContain('data-governance-binding-state="active-unverified"');
    expect(html).toContain("data-governance-active-unverified");
  });

  it("marks both active claims unverified when the binding activation receipt mismatches", async () => {
    bindingReceipt = { ...RECEIPT, bindingId: "policy_binding_other" };
    const html = await (await (await build()).request("/governance?projectId=project_easy")).text();
    expect(html).toContain("data-governance-receipt-unavailable");
    expect(html).not.toContain('data-governance-receipt="effective_policy_snapshot_1"');
    expect(html).not.toContain("data-governance-active-tier");
    expect(html).not.toContain('data-governance-binding-state="active"');
    expect(html).toContain('data-governance-binding-state="active-unverified"');
    expect(html).toContain("data-governance-active-unverified");
  });

  it("rejects malformed author input before any governance command", async () => {
    const app = await build();
    const response = await app.request("/governance/revisions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_easy&fragmentConfig=%7B%22",
    });
    const html = await response.text();
    expect(html).toContain("Fragment config is not valid JSON. No command was sent.");
    expect(capturedWrites).toEqual([]);
  });

  it("rejects a JSON value that is not a governance-fragments/v1 config before any command", async () => {
    const app = await build();
    const response = await app.request("/governance/revisions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `projectId=project_easy&fragmentConfig=${encodeURIComponent('{"apiVersion":"tanren.dev/governance-fragments/v1"}')}`,
    });
    expect(await response.text()).toContain(
      "Fragment config does not match governance-fragments/v1. No command was sent.",
    );
    expect(capturedWrites).toEqual([]);
  });

  it("confirms a revision lifecycle activation when the canonical re-read reports it active", async () => {
    const app = await build();
    const author = await app.request("/governance/revisions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `projectId=project_easy&parentRevisionId=policy_revision_1&fragmentConfig=${encodeURIComponent(JSON.stringify(FRAGMENT_CONFIG))}`,
    });
    expect(await author.text()).toContain("created and reloaded from the authoritative lineage");
    receiptReads = [];
    const activate = await app.request("/governance/revisions/activate", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_easy&revisionId=policy_revision_1",
    });
    const html = await activate.text();
    expect(html).toContain("Lifecycle activation was confirmed by governance authority");
    expect(html).not.toContain("pending/unconfirmed");
    expect(html).toContain('data-governance-revision-state="active"');
    expect(capturedWrites.map((write) => write.path)).toEqual([
      `/orgs/${ORG.id}/projects/${PROJECT.projectId}/governance/revisions`,
      `/orgs/${ORG.id}/projects/${PROJECT.projectId}/governance/revisions/${REVISION.id}/activate`,
    ]);
    expect(capturedWrites.every((write) => write.headers["x-csrf-token"] === "csrf-live")).toBe(true);
    expect(receiptReads).toEqual([
      `/orgs/${ORG.id}/projects/${PROJECT.projectId}/governance/effective/activation/${BINDING.id}`,
    ]);
  });

  it("keeps revision lifecycle activation pending when its canonical re-read remains inactive", async () => {
    activationReadStatus = "inactive";
    const response = await (
      await build()
    ).request("/governance/revisions/activate", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_easy&revisionId=policy_revision_1",
    });
    const html = await response.text();
    expect(html).toContain("pending/unconfirmed");
    expect(html).not.toContain("Lifecycle activation was confirmed by governance authority");
    expect(html).toContain('data-governance-active-tier="governance_tier_private"');
    expect(html).toContain('data-governance-binding-state="active"');
    expect(html).toContain('data-governance-revision-state="inactive"');
    expect(receiptReads).toEqual([
      `/orgs/${ORG.id}/projects/${PROJECT.projectId}/governance/effective/activation/${BINDING.id}`,
    ]);
  });

  it("activates the observed tier only through the canonical binding command", async () => {
    const app = await build();
    const response = await app.request("/governance/tiers/bind", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "projectId=project_easy&tierId=governance_tier_private",
    });
    expect(await response.text()).toContain("The active binding policy_binding_1 was confirmed");
    expect(capturedWrites).toHaveLength(1);
    expect(capturedWrites[0]).toMatchObject({
      path: `/orgs/${ORG.id}/projects/${PROJECT.projectId}/governance/tiers/${TIER.id}/bind`,
      headers: { "x-csrf-token": "csrf-live" },
    });
  });
});
