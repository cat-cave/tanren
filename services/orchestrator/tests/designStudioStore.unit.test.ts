// DB-free design-system Studio store coverage. Every query is routed through an
// in-memory client, preserving the same RLS-scoped method boundaries as production.

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { DesignBindingTargetError, DesignStudioStore } from "../src/engine/design/system/designStudioStore.js";

const ORG = "org_ds7";
const NOW = new Date("2026-07-21T00:00:00.000Z");

function studioPool(options: { readonly systemExists?: boolean; readonly bindingRow?: Record<string, unknown> } = {}) {
  const query = vi.fn<(sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>>(
    async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("FROM design_systems WHERE org_id") && sql.includes("ORDER BY updated_at")) {
        return {
          rows: [
            {
              id: "design_ds7",
              slug: "ds7",
              name: "DS-7",
              description: "system",
              lifecycle: "active",
              default_channel: "stable",
            },
          ],
        };
      }
      if (sql.includes("FROM design_system_releases") && sql.includes("ORDER BY version DESC")) {
        return {
          rows: [
            {
              id: "release_ds7",
              version: 2,
              contract_digest: "sha256:abc",
              canonical_artifact_id: "artifact_ds7",
              published_at: NOW,
            },
          ],
        };
      }
      if (sql.includes("FROM design_release_channels"))
        return { rows: [{ channel: "stable", release_id: "release_ds7" }], rowCount: 1 };
      if (sql.includes("COUNT(*)::text AS count")) return { rows: [{ count: "2" }] };
      if (sql.includes("SELECT 1 FROM design_systems")) {
        return options.systemExists === false ? { rows: [], rowCount: 0 } : { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      if (sql.includes("SELECT 1 FROM design_system_releases")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("INSERT INTO project_design_bindings")) {
        const pinMode = String(params[3]);
        return {
          rows: [
            {
              project_id: "project_ds7",
              design_system_id: "design_ds7",
              pin_mode: pinMode,
              pinned_release_id: params[4] as string | null,
              channel: params[5] as string | null,
              bound_by: "operator",
              updated_at: NOW,
            },
          ],
        };
      }
      if (sql.includes("FROM project_design_bindings"))
        return { rows: options.bindingRow === undefined ? [] : [options.bindingRow], rowCount: 0 };
      if (sql.includes("JOIN design_artifacts artifact")) {
        return {
          rows: [
            {
              path: "exports/tokens.css",
              kind: "export",
              media_type: "text/css",
              digest: "sha256:abc",
              byte_size: "42",
            },
          ],
        };
      }
      if (sql.includes("FROM design_artifact_files")) {
        return {
          rows:
            params[2] === "absent.css"
              ? []
              : [
                  {
                    path: "exports/tokens.css",
                    kind: "export",
                    media_type: "text/css",
                    digest: "sha256:abc",
                    byte_size: "42",
                  },
                ],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  );
  return { pool: { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool, query };
}

describe("DesignStudioStore — fake-pool publication and binding guards", () => {
  it("maps the reusable catalog, export index, and an absent binding without Postgres", async () => {
    const { pool } = studioPool();
    const store = new DesignStudioStore(pool);

    await expect(store.listCatalog(ORG)).resolves.toEqual([
      expect.objectContaining({
        designSystemId: "design_ds7",
        publishedReleaseCount: 1,
        latestPublishedRelease: expect.objectContaining({ canonicalArtifactId: "artifact_ds7" }),
        reuseCount: 2,
      }),
    ]);
    await expect(store.getBinding(ORG, "project_ds7")).resolves.toBeNull();
    await expect(store.listExportFiles(ORG, "artifact_ds7")).resolves.toEqual([
      expect.objectContaining({ path: "exports/tokens.css", byteSize: 42 }),
    ]);
    await expect(store.getExportFile(ORG, "artifact_ds7", "absent.css")).resolves.toBeNull();
  });

  it("writes only after a same-org published release target is proven", async () => {
    const { pool } = studioPool();
    const store = new DesignStudioStore(pool);

    await expect(
      store.putBinding({
        orgId: ORG,
        projectId: "project_ds7",
        designSystemId: "design_ds7",
        pinMode: "release",
        pinnedReleaseId: "release_ds7",
        boundBy: "operator",
      }),
    ).resolves.toMatchObject({ pinMode: "release", pinnedReleaseId: "release_ds7" });
  });

  it("maps an existing binding and permits a channel pin only after its published target resolves", async () => {
    const { pool } = studioPool({
      bindingRow: {
        project_id: "project_ds7",
        design_system_id: "design_ds7",
        pin_mode: "channel",
        pinned_release_id: null,
        channel: "stable",
        bound_by: "operator",
        updated_at: NOW,
      },
    });
    const store = new DesignStudioStore(pool);

    await expect(store.getBinding(ORG, "project_ds7")).resolves.toMatchObject({
      pinMode: "channel",
      channel: "stable",
    });
    await expect(store.getExportFile(ORG, "artifact_ds7", "exports/tokens.css")).resolves.toMatchObject({
      byteSize: 42,
    });
    await expect(
      store.putBinding({
        orgId: ORG,
        projectId: "project_ds7",
        designSystemId: "design_ds7",
        pinMode: "channel",
        channel: "stable",
        boundBy: "operator",
      }),
    ).resolves.toMatchObject({ pinMode: "channel", pinnedReleaseId: null, channel: "stable" });
  });

  it("fails closed when a release pin has no release id", async () => {
    const { pool } = studioPool();
    const store = new DesignStudioStore(pool);

    await expect(
      store.putBinding({
        orgId: ORG,
        projectId: "project_ds7",
        designSystemId: "design_ds7",
        pinMode: "release",
        boundBy: "operator",
      }),
    ).rejects.toBeInstanceOf(DesignBindingTargetError);
  });

  it("fails closed before binding when the referenced system does not exist in the org", async () => {
    const { pool } = studioPool({ systemExists: false });
    const store = new DesignStudioStore(pool);

    await expect(
      store.putBinding({
        orgId: ORG,
        projectId: "project_ds7",
        designSystemId: "missing_design",
        pinMode: "release",
        pinnedReleaseId: "release_ds7",
        boundBy: "operator",
      }),
    ).rejects.toBeInstanceOf(DesignBindingTargetError);
  });
});
