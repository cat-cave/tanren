import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InboxStore } from "../src/engine/forge/inbox/index.js";

interface Call {
  sql: string;
  params: unknown[];
}

function activeSourceRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    state: "active",
    attention_code: null,
    attention_message: null,
    attention_observed_at: null,
    webhook_configured: false,
    retry_not_before: null,
    ...row,
  };
}

function recorder(handlers: Array<{ match: string; rows: () => unknown[] }>): { client: pg.Pool; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async query(text: string, params: unknown[] = []) {
      const sql = text.replaceAll(/\s+/gu, " ").trim();
      calls.push({ sql, params });
      const handler = handlers.find(({ match }) => sql.includes(match));
      const rows = handler?.rows() ?? [];
      return { rows, rowCount: rows.length };
    },
  };
  return { client: client as unknown as pg.Pool, calls };
}

describe("mapSource — strict lifecycle + config normalization", () => {
  it("accepts null config only for a complete needs-attention row", async () => {
    const { client } = recorder([
      {
        match: "FROM inbox_sources WHERE id = $1",
        rows: () => [
          activeSourceRow({
            id: "src_1",
            org_id: "org_a",
            project_id: null,
            kind: "issues",
            name: "n",
            detail: "d",
            config: null,
            enabled: "false",
            auto_route: "true",
            state: "needs_attention",
            attention_code: "invalid_config",
            attention_message: "recreate this source",
            attention_observed_at: "2026-07-16T12:00:00.000Z",
          }),
        ],
      },
    ]);
    const source = await InboxStore.getSource(client, "src_1");
    expect(source).toMatchObject({
      enabled: false,
      autoRoute: true,
      config: null,
      projectId: null,
      attention: { code: "invalid_config" },
    });
  });

  it.each(["manual", "scheduled_audit"] as const)(
    "rejects an active %s row whose persisted config is null",
    async (kind) => {
      const { client } = recorder([
        {
          match: "FROM inbox_sources WHERE id = $1",
          rows: () => [
            activeSourceRow({
              id: `src_${kind}`,
              org_id: "org_a",
              project_id: null,
              kind,
              name: kind,
              detail: "",
              config: null,
              enabled: "true",
              auto_route: "false",
            }),
          ],
        },
      ]);
      await expect(InboxStore.getSource(client, `src_${kind}`)).rejects.toThrow(/config/u);
    },
  );

  it("rejects rows that omit the post-migration lifecycle columns", async () => {
    const { client } = recorder([
      {
        match: "FROM inbox_sources WHERE id = $1",
        rows: () => [
          {
            id: "src_legacy",
            org_id: "org_a",
            project_id: null,
            kind: "manual",
            name: "legacy",
            detail: "",
            config: {},
            enabled: "true",
            auto_route: "false",
          },
        ],
      },
    ]);
    await expect(InboxStore.getSource(client, "src_legacy")).rejects.toThrow(/state/u);
  });

  it("treats any non-'true' enabled string as false", async () => {
    const { client } = recorder([
      {
        match: "FROM inbox_sources WHERE id = $1",
        rows: () => [
          activeSourceRow({
            id: "src_2",
            org_id: "o",
            project_id: "p",
            kind: "manual",
            name: "n",
            detail: "",
            config: {},
            enabled: "t",
            auto_route: "false",
          }),
        ],
      },
    ]);
    expect((await InboxStore.getSource(client, "src_2"))?.enabled).toBe(false);
  });

  it("returns undefined when no source row matches", async () => {
    const { client } = recorder([]);
    expect(await InboxStore.getSource(client, "src_missing")).toBeUndefined();
  });

  it("lists sources ordered by created_at and scoped to the org", async () => {
    const { client, calls } = recorder([
      {
        match: "FROM inbox_sources WHERE org_id = $1",
        rows: () => [
          activeSourceRow({
            id: "s1",
            org_id: "org_a",
            project_id: null,
            kind: "issues",
            name: "a",
            detail: "",
            config: { owner: "cat-cave", repo: "app", labels: [] },
            enabled: "true",
            auto_route: "false",
          }),
          activeSourceRow({
            id: "s2",
            org_id: "org_a",
            project_id: null,
            kind: "errors",
            name: "b",
            detail: "",
            config: { org: "cat-cave", project: "app", baseUrl: "https://sentry.io" },
            enabled: "true",
            auto_route: "false",
          }),
        ],
      },
    ]);
    const sources = await InboxStore.listSources(client, "org_a");
    expect(calls[0]).toMatchObject({ params: ["org_a"] });
    expect(calls[0]!.sql).toContain("ORDER BY created_at");
    expect(sources.map(({ id }) => id)).toEqual(["s1", "s2"]);
  });
});
