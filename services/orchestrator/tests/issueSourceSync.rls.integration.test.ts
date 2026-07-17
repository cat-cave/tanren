import { migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { IssueLoopStore } from "../src/engine/repositories/issueLoops.js";
import { SourceSyncOutboxStore } from "../src/engine/repositories/sourceSyncOutbox.js";
import {
  GithubIssueSourceAdapter,
  ingestGithubWebhookObservation,
} from "../src/engine/forge/githubIssueSourceAdapter.js";
import { ManualIssueSourceAdapter } from "../src/engine/forge/issueSourceAdapter.js";
import { WebhookEventStore } from "../src/engine/repositories/webhookEvents.js";
import { intakeAutoRouteDeps, processWebhookEvent } from "../src/engine/forge/intake/index.js";
import { createInternalSourceSyncRoutes } from "../src/routes/internal/sourceSync.js";
import type { CandidateTriage, TriageAnswerer } from "../src/engine/forge/inbox/index.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
import { authorizeSourceSync } from "./helpers/sourceSyncAuthority.js";

const describeDb = process.env["TANREN_RLS_DB_TEST"] === "1" ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_issue_source_a";
const ORG_B = "org_issue_source_b";
const PROJECT_A = "project_issue_source_a";
const PROJECT_B = "project_issue_source_b";
const SOURCE_A = "src_issue_source_a";
const SOURCE_B = "src_issue_source_b";
const MANUAL_A = "src_manual_issue_source_a";
const TOKEN_REF = `credential/github/org/${ORG_A}/default`;

function dbName(): string {
  return `tanren_issue_source_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const issue = (number: number, action: string, updatedAt: string) => ({
  action,
  issue: {
    number,
    title: `Issue ${number}`,
    body: "A source issue",
    updated_at: updatedAt,
    labels: [{ name: "bug" }],
  },
  repository: { owner: { login: "cat-cave" }, name: "fixture" },
});

const triage: TriageAnswerer = {
  async triage(): Promise<CandidateTriage> {
    return {
      dedupe: "new issue",
      match: "issue loop",
      placement: "inbox",
      verdict: "needs_call",
      duplicateOfSpecId: null,
      discoveryVariant: "bug",
      routableSpec: null,
      entityAnchor: null,
    };
  },
};

describeDb("IssueSourceAdapter + source-sync outbox — RLS integration", () => {
  const database = dbName();
  let ownerPool: Pool;
  let appPool: Pool;
  let github: GithubIssueSourceAdapter;
  let manual: ManualIssueSourceAdapter;
  let closeFails = false;
  let closeMutations = 0;

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
       VALUES ($1, 'oidc', $1, $1, $1, $2::jsonb),
              ($3, 'oidc', $3, $3, $3, '{"version":1}'::jsonb)`,
      [ORG_A, JSON.stringify({ version: 1, defaultCredentials: { github_token: TOKEN_REF } }), ORG_B],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'p', 'https://github.com/cat-cave/fixture', 'main', 'runner:v0', $3, '{}'::jsonb),
              ($2, 'p', 'https://github.com/cat-cave/fixture', 'main', 'runner:v0', $4, '{}'::jsonb)`,
      [PROJECT_A, PROJECT_B, ORG_A, ORG_B],
    );
    await ownerPool.query(
      `INSERT INTO inbox_sources (id, org_id, project_id, kind, name, config)
       VALUES ($1, $3, $5, 'issues', 'github', '{"owner":"cat-cave","repo":"fixture","labels":[]}'::jsonb),
              ($2, $4, $6, 'issues', 'github', '{"owner":"cat-cave","repo":"fixture","labels":[]}'::jsonb),
              ($7, $3, $5, 'manual', 'manual', '{}'::jsonb)`,
      [SOURCE_A, SOURCE_B, ORG_A, ORG_B, PROJECT_A, PROJECT_B, MANUAL_A],
    );
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: TOKEN_REF, value: "gh-test-token" });
    const githubHttp: GitHubHttpClient = {
      async request(input) {
        if (input.method === "PATCH") {
          closeMutations += 1;
          if (closeFails) return { status: 503, body: { message: "provider unavailable" } };
          return {
            status: 200,
            body: {
              number: 41,
              state: input.body === undefined ? "closed" : (input.body as { state: "open" | "closed" }).state,
            },
          };
        }
        return { status: 200, body: { number: 41, state: "closed", updated_at: "2026-07-17T13:00:00Z" } };
      },
    };
    github = new GithubIssueSourceAdapter({
      pool: appPool,
      secrets,
      githubHttp,
      defaultStaticRef: TOKEN_REF,
    });
    manual = new ManualIssueSourceAdapter();
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

  async function receiveGithubWebhook(payload: unknown, deliveryId: string) {
    const persisted = await runWithOrgScope(appPool, ORG_A, (client) =>
      WebhookEventStore.persistWithOutcome(client, {
        sourceId: SOURCE_A,
        orgId: ORG_A,
        eventType: "issues",
        provider: "github",
        deliveryId,
        payload,
      }),
    );
    const processed =
      persisted.inserted &&
      (await processWebhookEvent(
        {
          pool: appPool,
          answererFactory: () => triage,
          autoRoute: intakeAutoRouteDeps(),
          recordIssueObservation: async (source, event) => {
            await ingestGithubWebhookObservation(appPool, source, event);
          },
        },
        persisted.event,
      ));
    return { ...persisted, processed };
  }

  async function recordAuthorizedDecision(issueLoopId: string): Promise<{ id: string }> {
    return authorizeSourceSync(appPool, { orgId: ORG_A, projectId: PROJECT_A, issueLoopId });
  }

  async function closeOutbox(loopId: string) {
    return runWithOrgScope(appPool, ORG_A, async (client) => {
      const rows = await SourceSyncOutboxStore.listRunnable(client, 20);
      return rows.find((row) => row.issueLoopId === loopId && row.operation === "close");
    });
  }

  it("uses tanren_app without superuser or RLS-bypass privileges", async () => {
    const identity = await appPool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("records GitHub webhook findings through the bh-3 processor and emits frozen loop events", async () => {
    const received = await receiveGithubWebhook(issue(41, "opened", "2026-07-17T12:00:00Z"), "delivery-41");
    expect(received).toMatchObject({ inserted: true, processed: true });
    const duplicate = await receiveGithubWebhook(issue(41, "opened", "2026-07-17T12:00:00Z"), "delivery-41");
    expect(duplicate).toMatchObject({ inserted: false, processed: false });
    const source = (
      await runWithOrgScope(appPool, ORG_A, (client) =>
        client.query<{ id: string; project_id: string }>("SELECT id, project_id FROM inbox_sources WHERE id = $1", [
          SOURCE_A,
        ]),
      )
    ).rows[0]!;
    const loop = (
      await runWithOrgScope(appPool, ORG_A, (client) => IssueLoopStore.listForProject(client, ORG_A, source.project_id))
    ).find((candidate) => candidate.externalKey === "gh-cat-cave/fixture#41");
    expect(loop).toBeDefined();
    const findings = await runWithOrgScope(appPool, ORG_A, (client) =>
      IssueLoopStore.listFindings(client, ORG_A, loop!.id),
    );
    expect(findings).toHaveLength(1);
    const eventTypes = await runWithOrgScope(appPool, ORG_A, async (client) => {
      const result = await client.query<{ event_type: string; payload: unknown }>(
        "SELECT event_type, payload FROM events WHERE org_id = $1 ORDER BY id",
        [ORG_A],
      );
      return result.rows;
    });
    expect(eventTypes.map((event) => event.event_type)).toEqual([
      "source.finding.recorded",
      "issue_loop.opened",
      "issue_loop.source_revision_observed",
    ]);
    expect(eventTypes[1]?.payload).toMatchObject({ projectId: PROJECT_A, issueLoopId: loop!.id });
    expect(eventTypes[2]?.payload).toMatchObject({ projectId: PROJECT_A, issueLoopId: loop!.id });
    const manualResult = await manual.ingest(appPool, {
      orgId: ORG_A,
      sourceId: MANUAL_A,
      externalKey: "manual-1",
      providerObjectId: "manual-1",
      providerRevision: "manual-rev-1",
      status: "open",
      severity: "warn",
      title: "Manually reported issue",
    });
    expect(manualResult.finding.issueLoopId).toBe(manualResult.loop.id);
    expect(manualResult.loop.projectId).toBe(PROJECT_A);
  });

  it("enqueues only through the authority, reads back before verified closure, and reconciles external drift", async () => {
    const open = await receiveGithubWebhook(issue(42, "opened", "2026-07-17T14:00:00Z"), "delivery-42-open");
    const loopId = (
      await runWithOrgScope(appPool, ORG_A, (client) => IssueLoopStore.listForProject(client, ORG_A, PROJECT_A))
    ).find((loop) => loop.externalKey === "gh-cat-cave/fixture#42")!.id;
    const decision = await recordAuthorizedDecision(loopId);
    const pending = await closeOutbox(loopId);
    expect(pending).toMatchObject({ state: "pending", resolutionDecisionId: decision.id });
    const outboxCount = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM source_sync_outbox WHERE org_id = $1 AND issue_loop_id = $2 AND operation = 'close'",
        [ORG_A, loopId],
      ),
    );
    expect(outboxCount.rows).toEqual([{ count: "1" }]);
    closeMutations = 0;
    const processed = await (
      await import("../src/engine/forge/sourceSyncWorker.js")
    ).processSourceSync({ pool: appPool, adapters: new Map([["issues", github]]), workerId: "sync-a" }, pending!);
    expect(processed?.verified).toBe(true);
    expect(closeMutations).toBe(1);
    const verified = await runWithOrgScope(appPool, ORG_A, (client) =>
      IssueLoopStore.get(client, ORG_A, PROJECT_A, loopId),
    );
    expect(verified?.state).toBe("verified_closed");
    const siblingOpen = await receiveGithubWebhook(issue(43, "opened", "2026-07-17T14:30:00Z"), "delivery-43-open");
    expect(siblingOpen.processed).toBe(true);
    const siblingLoop = (
      await runWithOrgScope(appPool, ORG_A, (client) => IssueLoopStore.listForProject(client, ORG_A, PROJECT_A))
    ).find((loop) => loop.externalKey === "gh-cat-cave/fixture#43")!;
    await recordAuthorizedDecision(siblingLoop.id);
    const siblingPending = await closeOutbox(siblingLoop.id);
    expect(siblingPending?.state).toBe("pending");
    const external = await receiveGithubWebhook(issue(43, "closed", "2026-07-17T15:00:00Z"), "delivery-closed-43");
    expect(external.processed).toBe(true);
    const externalLoop = (
      await runWithOrgScope(appPool, ORG_A, (client) => IssueLoopStore.listForProject(client, ORG_A, PROJECT_A))
    ).find((loop) => loop.externalKey === "gh-cat-cave/fixture#43");
    expect(externalLoop?.state).toBe("open");
    const externalOutbox = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ id: string; state: string }>(
        "SELECT id, state FROM source_sync_outbox WHERE org_id = $1 AND issue_loop_id = $2",
        [ORG_A, externalLoop!.id],
      ),
    );
    expect(externalOutbox.rows).toContainEqual({ id: siblingPending!.id, state: "externally_closed_unverified" });
    expect(
      await (
        await import("../src/engine/forge/sourceSyncWorker.js")
      ).processSourceSync(
        { pool: appPool, adapters: new Map([["issues", github]]), workerId: "sync-sibling" },
        siblingPending!,
      ),
    ).toBeUndefined();
    const eventTypes = await runWithOrgScope(appPool, ORG_A, async (client) => {
      const result = await client.query<{ event_type: string }>(
        "SELECT event_type FROM events WHERE org_id = $1 ORDER BY id",
        [ORG_A],
      );
      return result.rows.map((row) => row.event_type);
    });
    expect(eventTypes).toContain("source_issue.sync.enqueued");
    expect(eventTypes).toContain("source_issue.sync.succeeded");
    expect(eventTypes).toContain("issue_loop.verified");
    expect(eventTypes).toContain("source_issue.sync.drifted");
    expect(eventTypes).toContain("source.sync.externally_closed_unverified");
    expect(eventTypes).toContain("issue_loop.reopened");
    expect(open.processed).toBe(true);
  });

  it("keeps an authority-authorized loop pending when the provider mutation fails", async () => {
    await receiveGithubWebhook(issue(44, "opened", "2026-07-17T15:30:00Z"), "delivery-44-open");
    const loop = (
      await runWithOrgScope(appPool, ORG_A, (client) => IssueLoopStore.listForProject(client, ORG_A, PROJECT_A))
    ).find((candidate) => candidate.externalKey === "gh-cat-cave/fixture#44")!;
    await recordAuthorizedDecision(loop.id);
    const pending = await closeOutbox(loop.id);
    closeFails = true;
    const failed = await (
      await import("../src/engine/forge/sourceSyncWorker.js")
    ).processSourceSync({ pool: appPool, adapters: new Map([["issues", github]]), workerId: "sync-failure" }, pending!);
    closeFails = false;
    expect(failed?.verified).toBe(false);
    const state = await runWithOrgScope(appPool, ORG_A, (client) =>
      IssueLoopStore.get(client, ORG_A, PROJECT_A, loop.id),
    );
    expect(state?.state).toBe("verified_source_sync_pending");
    const events = await runWithOrgScope(appPool, ORG_A, (client) =>
      client.query<{ event_type: string }>("SELECT event_type FROM events WHERE org_id = $1", [ORG_A]),
    );
    expect(events.rows.map((event) => event.event_type)).toContain("source_issue.sync.failed");
  });

  it("claims and redrives an authority-created outbox row through the internal mTLS surface", async () => {
    await receiveGithubWebhook(issue(45, "opened", "2026-07-17T16:00:00Z"), "delivery-45-open");
    const loop = (
      await runWithOrgScope(appPool, ORG_A, (client) => IssueLoopStore.listForProject(client, ORG_A, PROJECT_A))
    ).find((candidate) => candidate.externalKey === "gh-cat-cave/fixture#45")!;
    await recordAuthorizedDecision(loop.id);
    const pending = await closeOutbox(loop.id);
    const routes = createInternalSourceSyncRoutes({
      pool: appPool,
      verifier: { verify: () => ({ commonName: "source-sync-test" }) },
    });
    const claim = await routes.request(
      "/internal/source-sync/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: ORG_A, workerId: "internal-source-sync", sourceSyncOutboxId: pending!.id }),
      },
      { incoming: { socket: {} } },
    );
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toMatchObject({
      outbox: { id: pending!.id, claimOwner: "internal-source-sync" },
    });
    const redrive = await routes.request(
      `/internal/source-sync/${pending!.id}/redrive`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: ORG_A }),
      },
      { incoming: { socket: {} } },
    );
    expect(redrive.status).toBe(200);
    await expect(redrive.json()).resolves.toMatchObject({ outbox: { id: pending!.id, claimOwner: null } });
  });

  it("keeps issue loops, findings, outbox rows, and events isolated by org", async () => {
    const persisted = await runWithOrgScope(appPool, ORG_B, (client) =>
      WebhookEventStore.persistWithOutcome(client, {
        sourceId: SOURCE_B,
        orgId: ORG_B,
        eventType: "issues",
        provider: "github",
        deliveryId: "delivery-b",
        payload: issue(99, "opened", "2026-07-17T16:00:00Z"),
      }),
    );
    expect(
      await processWebhookEvent(
        {
          pool: appPool,
          answererFactory: () => triage,
          autoRoute: intakeAutoRouteDeps(),
          recordIssueObservation: async (source, event) => {
            await ingestGithubWebhookObservation(appPool, source, event);
          },
        },
        persisted.event,
      ),
    ).toBe(true);
    expect(
      await runWithOrgScope(appPool, ORG_B, (client) => IssueLoopStore.listForProject(client, ORG_A, PROJECT_A)),
    ).toEqual([]);
    expect(await runWithOrgScope(appPool, ORG_B, (client) => SourceSyncOutboxStore.listRunnable(client, 20))).toEqual(
      [],
    );
    const orgBEvents = await runWithOrgScope(appPool, ORG_B, (client) =>
      client.query<{ event_type: string }>("SELECT event_type FROM events WHERE org_id = $1", [ORG_B]),
    );
    expect(orgBEvents.rows.map((row) => row.event_type)).toEqual([
      "source.finding.recorded",
      "issue_loop.opened",
      "issue_loop.source_revision_observed",
    ]);
    const invisible = await runWithOrgScope(appPool, ORG_B, (client) =>
      client.query("SELECT id FROM source_findings WHERE org_id = $1", [ORG_A]),
    );
    expect(invisible.rows).toEqual([]);
  });
});
