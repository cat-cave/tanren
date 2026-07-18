import { migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  ManualIssueSourceAdapter,
  ingestIssueObservation,
  type IssueSourceAdapter,
} from "../src/engine/forge/issueSourceAdapter.js";
import { processSourceSync } from "../src/engine/forge/sourceSyncWorker.js";
import { IssueLoopStore } from "../src/engine/repositories/issueLoops.js";
import { SourceSyncOutboxStore } from "../src/engine/repositories/sourceSyncOutbox.js";
import { authorizeSourceSync, blockSourceSync } from "./helpers/sourceSyncAuthority.js";

const describeDb = process.env["TANREN_RLS_DB_TEST"] === "1" ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_ID = "org_source_sync_worker";
const PROJECT_ID = "project_source_sync_worker";
const ISSUE_SOURCE_ID = "src_source_sync_worker_issues";
const MANUAL_SOURCE_ID = "src_source_sync_worker_manual";

function dbName(): string {
  return `tanren_source_sync_worker_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function appUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = APP_ROLE;
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: () => resolve?.() };
}

describeDb("source-sync worker failure closure — RLS integration", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    setSystemPool(ownerPool);
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG_ID],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'p', 'https://github.com/cat-cave/fixture', 'main', 'runner:v0', $2, '{}'::jsonb)`,
      [PROJECT_ID, ORG_ID],
    );
    await ownerPool.query(
      `INSERT INTO inbox_sources (id, org_id, project_id, kind, name, config)
       VALUES ($1, $3, $4, 'issues', 'issues', '{"owner":"cat-cave","repo":"fixture","labels":[]}'::jsonb),
              ($2, $3, $4, 'manual', 'manual', '{}'::jsonb)`,
      [ISSUE_SOURCE_ID, MANUAL_SOURCE_ID, ORG_ID, PROJECT_ID],
    );
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
    setSystemPool(undefined);
  }, 30_000);

  async function closeOutbox(sourceId: string, key: string) {
    const observation = await ingestIssueObservation(appPool, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      sourceId,
      externalKey: key,
      providerObjectId: key,
      providerRevision: `${key}-revision`,
      status: "open",
      severity: "warn",
      title: key,
    });
    await authorizeSourceSync(appPool, { orgId: ORG_ID, projectId: PROJECT_ID, issueLoopId: observation.loop.id });
    const outbox = await runWithOrgScope(appPool, ORG_ID, (client) => SourceSyncOutboxStore.listRunnable(client, 20));
    return {
      loop: observation.loop,
      outbox: outbox.find((row) => row.issueLoopId === observation.loop.id && row.operation === "close")!,
    };
  }

  it("does not verify a manual close until an external confirmation exists", async () => {
    const pending = await closeOutbox(MANUAL_SOURCE_ID, "manual-confirmation-required");
    let confirmed = false;
    const manual = new ManualIssueSourceAdapter({
      async lookup(input) {
        return confirmed
          ? {
              receipt: { providerRevision: `operator:${input.outbox.id}` },
              readback: { providerRevision: `operator:${input.outbox.id}`, desiredState: "closed" },
            }
          : null;
      },
    });
    const first = await processSourceSync(
      { pool: appPool, adapters: new Map([["manual", manual]]), workerId: "manual-unconfirmed" },
      pending.outbox,
    );
    expect(first?.verified).toBe(false);
    await expect(
      runWithOrgScope(appPool, ORG_ID, (client) => IssueLoopStore.get(client, ORG_ID, PROJECT_ID, pending.loop.id)),
    ).resolves.toMatchObject({
      state: "verified_source_sync_pending",
    });
    confirmed = true;
    const redriven = await runWithOrgScope(appPool, ORG_ID, (client) =>
      SourceSyncOutboxStore.redrive(client, ORG_ID, pending.outbox.id),
    );
    const verified = await processSourceSync(
      { pool: appPool, adapters: new Map([["manual", manual]]), workerId: "manual-confirmed" },
      redriven!,
    );
    expect(verified?.verified).toBe(true);
  });

  it("rejects a blocked decision id before inserting any close outbox row", async () => {
    const observation = await ingestIssueObservation(appPool, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      sourceId: ISSUE_SOURCE_ID,
      externalKey: "blocked-decision",
      providerObjectId: "blocked-decision",
      providerRevision: "blocked-decision-revision",
      status: "open",
      severity: "warn",
      title: "blocked decision",
    });
    const blocked = await blockSourceSync(appPool, {
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      issueLoopId: observation.loop.id,
    });
    await expect(
      runWithOrgScope(appPool, ORG_ID, (client) =>
        SourceSyncOutboxStore.enqueue(client, {
          orgId: ORG_ID,
          issueLoopId: observation.loop.id,
          sourceId: ISSUE_SOURCE_ID,
          operation: "close",
          payload: { desiredState: "closed" },
          resolutionDecisionId: blocked.id,
        }),
      ),
    ).rejects.toThrow("authorized ResolutionAuthority decision");
    await expect(
      runWithOrgScope(appPool, ORG_ID, (client) =>
        client.query(
          `INSERT INTO source_sync_outbox
             (org_id, id, issue_loop_id, source_id, operation, state, payload, payload_hash, resolution_decision_id)
           VALUES ($1, 'blocked_direct_outbox', $2, $3, 'close', 'pending', '{}'::jsonb, $4, $5)`,
          [ORG_ID, observation.loop.id, ISSUE_SOURCE_ID, `sha256:${"b".repeat(64)}`, blocked.id],
        ),
      ),
    ).rejects.toThrow("authorized ResolutionAuthority decision");
    await expect(
      runWithOrgScope(appPool, ORG_ID, (client) =>
        client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM source_sync_outbox WHERE org_id = $1 AND issue_loop_id = $2",
          [ORG_ID, observation.loop.id],
        ),
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("renews a live lease so reclaim cannot issue a second external close", async () => {
    const pending = await closeOutbox(ISSUE_SOURCE_ID, "lease-heartbeat");
    const entered = deferred();
    const release = deferred();
    let applies = 0;
    const adapter: IssueSourceAdapter = {
      provider: "test",
      async ingest() {
        throw new Error("ingest is not used by source-sync processing");
      },
      async sync() {
        applies += 1;
        entered.resolve();
        await release.promise;
        return { providerRevision: "close-revision" };
      },
      async readback() {
        return { providerRevision: "close-revision", desiredState: "closed" };
      },
    };
    const first = processSourceSync(
      { pool: appPool, adapters: new Map([["issues", adapter]]), workerId: "lease-first", claimLeaseMs: 30 },
      pending.outbox,
    );
    await entered.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });
    await expect(
      processSourceSync(
        { pool: appPool, adapters: new Map([["issues", adapter]]), workerId: "lease-reclaimer", claimLeaseMs: 30 },
        pending.outbox,
      ),
    ).resolves.toBeUndefined();
    release.resolve();
    await expect(first).resolves.toMatchObject({ verified: true });
    expect(applies).toBe(1);
  });
});
