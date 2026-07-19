// ds-5 — the design Studio HTTP surface, exercised through the REAL mounted Hono
// app (createDesignStudioRoutes) with an injected actor, a fake org-scoped pool
// (answering the project-access + evidence reads), an injected Studio store, and
// an in-memory ArtifactStore. Proves: org/project authorization gating, the
// admin-only reuse binding write, the evidence-lab read, and the export byte
// download's fail-closed behavior (real bytes vs 404 vs 503).

import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { ArtifactNotFoundError, sha256Digest, type ArtifactStore } from "../src/engine/design/system/artifactStore.js";
import { DesignBindingTargetError } from "../src/engine/design/system/designStudioStore.js";
import type { DesignStudioReadStore } from "../src/routes/designStudio/reads.js";
import { createDesignStudioRoutes } from "../src/routes/designStudio/reads.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";

const ADMIN: ActorContext = {
  userId: "admin",
  orgId: "org-a",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};
const MEMBER: ActorContext = {
  userId: "member",
  orgId: "org-a",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

/** A fake org-scoped pool: answers txn control, the project-access gate, and the
 * evidence read. `verdictRows` seeds the design-render evidence SELECT. */
function fakePool(projectOrgId: string | null, verdictRows: Record<string, unknown>[] = []): pg.Pool {
  const client = {
    query: vi.fn<(sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>>(async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT org_id FROM projects")) {
        return {
          rows: projectOrgId === null ? [] : [{ org_id: projectOrgId }],
          rowCount: projectOrgId === null ? 0 : 1,
        };
      }
      if (sql.includes("FROM project_members")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM design_render_land_verdicts")) return { rows: verdictRows, rowCount: verdictRows.length };
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    release: vi.fn<() => void>(),
  };
  return { connect: vi.fn<() => Promise<typeof client>>(async () => client) } as unknown as pg.Pool;
}

const CATALOG = [
  {
    designSystemId: "sys-1",
    slug: "console",
    name: "Console DS",
    description: "shared",
    lifecycle: "active",
    defaultChannel: "stable",
    publishedReleaseCount: 1,
    latestPublishedRelease: {
      releaseId: "rel-1",
      version: 1,
      contractDigest: `sha256:${"a".repeat(64)}`,
      canonicalArtifactId: "art-1",
      publishedAt: "2026-01-01T00:00:00.000Z",
    },
    channels: [{ channel: "stable", releaseId: "rel-1" }],
    reuseCount: 1,
  },
];

const BINDING = {
  projectId: "project-a",
  designSystemId: "sys-1",
  pinMode: "release" as const,
  pinnedReleaseId: "rel-1",
  channel: null,
  boundBy: "admin",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const EXPORT_FILE = {
  path: "exports/tokens.css",
  kind: "export",
  mediaType: "text/css",
  digest: sha256Digest(new TextEncoder().encode(":root{--x:1}")),
  byteSize: 12,
};

class MemoryArtifactStore implements ArtifactStore {
  private readonly bytes = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<string> {
    const digest = sha256Digest(bytes);
    this.bytes.set(digest, new Uint8Array(bytes));
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    const found = this.bytes.get(digest);
    if (found === undefined) throw new ArtifactNotFoundError(digest);
    return found;
  }
}

function buildHarness(opts?: {
  actor?: ActorContext;
  projectOrgId?: string;
  verdictRows?: Record<string, unknown>[];
  store?: Partial<DesignStudioReadStore>;
  artifactStore?: ArtifactStore;
}) {
  const actor = opts?.actor ?? ADMIN;
  const store: DesignStudioReadStore = {
    listCatalog: vi.fn<DesignStudioReadStore["listCatalog"]>(async () => CATALOG),
    getBinding: vi.fn<DesignStudioReadStore["getBinding"]>(async () => BINDING),
    putBinding: vi.fn<DesignStudioReadStore["putBinding"]>(async () => BINDING),
    listExportFiles: vi.fn<DesignStudioReadStore["listExportFiles"]>(async () => [EXPORT_FILE]),
    getExportFile: vi.fn<DesignStudioReadStore["getExportFile"]>(async () => EXPORT_FILE),
    ...opts?.store,
  };
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route(
    "/v1/orgs",
    createDesignStudioRoutes({
      pool: fakePool(opts?.projectOrgId ?? "org-a", opts?.verdictRows),
      artifactStore: opts?.artifactStore ?? new MemoryArtifactStore(),
      store,
    }),
  );
  return { app, store };
}

describe("ds-5 design Studio HTTP surface", () => {
  it("serves the within-org reuse catalog and rejects a cross-org request", async () => {
    const { app } = buildHarness();
    const ok = await app.request("/v1/orgs/org-a/design-systems");
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({
      version: "v1",
      orgId: "org-a",
      systems: [{ designSystemId: "sys-1" }],
    });

    const denied = await app.request("/v1/orgs/org-b/design-systems");
    expect(denied.status).toBe(403);
  });

  it("reads the project binding and gates the reuse WRITE on org-admin", async () => {
    const read = await buildHarness().app.request("/v1/orgs/org-a/projects/project-a/design-binding");
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ binding: { designSystemId: "sys-1" } });

    const member = buildHarness({ actor: MEMBER });
    const denied = await member.app.request("/v1/orgs/org-a/projects/project-a/design-binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ designSystemId: "sys-1", pinMode: "release", pinnedReleaseId: "rel-1" }),
    });
    expect(denied.status).toBe(403);
    expect(member.store.putBinding).not.toHaveBeenCalled();

    const admin = buildHarness();
    const ok = await admin.app.request("/v1/orgs/org-a/projects/project-a/design-binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ designSystemId: "sys-1", pinMode: "release", pinnedReleaseId: "rel-1" }),
    });
    expect(ok.status).toBe(200);
    expect(admin.store.putBinding).toHaveBeenCalledOnce();
  });

  it("rejects a malformed binding body and surfaces a non-published target as 409", async () => {
    const bad = await buildHarness().app.request("/v1/orgs/org-a/projects/project-a/design-binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ designSystemId: "sys-1", pinMode: "release", channel: "stable" }),
    });
    expect(bad.status).toBe(400);

    const rejecting = buildHarness({
      store: {
        putBinding: vi.fn<DesignStudioReadStore["putBinding"]>(async () => {
          throw new DesignBindingTargetError("org-a", "release 'rel-x' is not a published release of the system");
        }),
      },
    });
    const conflict = await rejecting.app.request("/v1/orgs/org-a/projects/project-a/design-binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ designSystemId: "sys-1", pinMode: "release", pinnedReleaseId: "rel-x" }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: "binding_target_invalid" });
  });

  it("reads the evidence lab verdict (null when none recorded, populated when present)", async () => {
    const empty = await buildHarness().app.request("/v1/orgs/org-a/projects/project-a/design-evidence");
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({ verdict: null });

    const seeded = buildHarness({
      verdictRows: [
        {
          outcome: "failed_visual",
          accessibility_standard: "wcag21aa",
          design_contract_version: "1",
          release_id: "rel-1",
          contract_digest: `sha256:${"b".repeat(64)}`,
          failing_scenario_key: "home:dark:mobile",
          failing_rule_ids: ["contrast"],
          checkpoint_count: 1,
          checkpoints: [{ checkpointId: "cp-1", verdict: "failed", failingRuleIds: ["contrast"] }],
        },
      ],
    });
    const populated = await seeded.app.request("/v1/orgs/org-a/projects/project-a/design-evidence");
    expect(populated.status).toBe(200);
    await expect(populated.json()).resolves.toMatchObject({
      verdict: {
        outcome: "failed_visual",
        failingScenarioKey: "home:dark:mobile",
        checkpoints: [{ checkpointId: "cp-1" }],
      },
    });
  });

  it("lists exports with download links and streams the real bytes", async () => {
    const store = new MemoryArtifactStore();
    const digest = await store.put(new TextEncoder().encode(":root{--x:1}"));
    const harness = buildHarness({
      artifactStore: store,
      store: { getExportFile: vi.fn<DesignStudioReadStore["getExportFile"]>(async () => ({ ...EXPORT_FILE, digest })) },
    });

    const list = await harness.app.request("/v1/orgs/org-a/design-artifacts/art-1/exports");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      files: [
        {
          path: "exports/tokens.css",
          href: expect.stringContaining(`download?path=${encodeURIComponent("exports/tokens.css")}`),
        },
      ],
    });

    const download = await harness.app.request(
      `/v1/orgs/org-a/design-artifacts/art-1/exports/download?path=${encodeURIComponent("exports/tokens.css")}`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("text/css");
    expect(await download.text()).toBe(":root{--x:1}");
  });

  it("fails LOUD (404 / 503) when an export file or its bytes are absent — never fabricates", async () => {
    const missingFile = buildHarness({
      store: { getExportFile: vi.fn<DesignStudioReadStore["getExportFile"]>(async () => null) },
    });
    const notFound = await missingFile.app.request(
      `/v1/orgs/org-a/design-artifacts/art-1/exports/download?path=${encodeURIComponent("exports/missing.css")}`,
    );
    expect(notFound.status).toBe(404);

    // File row present but its CAS byte is gone → 503 blocked, not an empty 200.
    const missingBytes = buildHarness({
      artifactStore: new MemoryArtifactStore(),
      store: { getExportFile: vi.fn<DesignStudioReadStore["getExportFile"]>(async () => EXPORT_FILE) },
    });
    const blocked = await missingBytes.app.request(
      `/v1/orgs/org-a/design-artifacts/art-1/exports/download?path=${encodeURIComponent("exports/tokens.css")}`,
    );
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toMatchObject({ error: "artifact_bytes_unavailable" });
  });
});
