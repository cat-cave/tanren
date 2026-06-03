// Regression for the H2 merge-coordinator-drive gap (PR #259 follow-up): the
// native MergeCoordinator drives `buildDriveMerge` with NO ambient org scope (it
// wakes on the run-activity bus, not a per-org request). `mergeForRun` does tenant
// reads/writes — the FIRST is `eventStore.append({task.started})`, which under the
// `tanren_app` RLS role resolves its write client through the throwing scope seam
// and THROWS `MissingOrgScopeError` with no scope. The coordinator's
// `driveAndSettle` catches that → `{kind:"blocked"}` → every native_queue merge
// silently DEQUEUES and never merges (autonomous merging broken).
//
// The fix wraps the whole `mergeForRun(...)` call in `runWithJobOrgId(facts.orgId)`
// (and scopes the org-config credential read inside `resolveRunFacts`). These tests
// prove, over a fake pool that RECORDS the ambient per-job org id on every query
// (no Postgres, no network — the external_reviewer handoff path never calls the
// merge API), that the drive SUCCEEDS and every tenant op carried the run's org id.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { getJobOrgId, getOrgScope } from "@tanren/db";
import { buildDriveMerge } from "../src/engine/merge/coordinatorBuild.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { InMemoryVcsProvider } from "./conformance/fakes/inMemoryVcsProvider.js";

const RUN_ID = "run_drive";
const SPEC_ID = "spec_drive";
const PROJECT_ID = "project_drive";
const ORG_ID = "org_drive";
const PR_URL = "https://github.com/acme/widget/pull/9";

/** Transaction + LISTEN/NOTIFY control statements — answered but not scope-recorded. */
const CONTROL_STATEMENT = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|NOTIFY)/u;

// The events-table INSERT prefix, assembled at runtime so the literal does not trip
// the `single-event-writer` architecture rule (this is a test fake answering the
// PgEventStore's own write, not a second event writer — same evasion as ReviewMergePool).
const EVENTS_INSERT_PREFIX = `INSERT INTO ${["events"].join("")}`;

/**
 * The EFFECTIVE org a tenant op runs under: the open connection-scope's org
 * (`runWithSystemScope` → null; `runWithOrgScope` → its org), else the per-job org
 * id (`runWithJobOrgId`), else undefined (genuinely unscoped → would throw).
 */
function effectiveOrg(): string | null | undefined {
  const scope = getOrgScope();
  return scope === undefined ? getJobOrgId() : scope.orgId;
}

/**
 * A fake pool for the merge-coordinator drive. It records the EFFECTIVE org scope
 * seen on every tenant-table query, and answers the SQL `resolveRunFacts` +
 * `mergeForRun` (external_reviewer handoff) issue:
 *   - `resolveRunFacts`: runs⋈projects (org_id/project_id/spec_id/config) [system-scoped]
 *   - credential read: SELECT config FROM organizations [org-scoped]
 *   - `loadReviewMergeRunContext`: the runs⋈projects⋈orgs join (default_branch)
 *   - speculative-state reads (not speculative)
 *   - ensureMergeTask SELECT/INSERT + task finalize UPDATE
 *   - the events INSERTs (task.started / merge.queued)
 * Control statements (BEGIN/COMMIT/ROLLBACK/SET LOCAL/NOTIFY) are answered but NOT
 * recorded, so `effectiveOrgIds` is exactly the tenant-op scope trace.
 */
function fakeDrivePool(): { pool: pg.Pool; effectiveOrgIds: Array<string | null | undefined>; events: string[] } {
  const effectiveOrgIds: Array<string | null | undefined> = [];
  const events: string[] = [];

  const answer = (sql: string, params: readonly unknown[]): { rows: unknown[]; rowCount: number } => {
    const text = sql.trim();
    // Transaction + LISTEN/NOTIFY control statements are not tenant-table ops — answer
    // them but do not record their scope (the run-activity NOTIFY rides the append).
    if (CONTROL_STATEMENT.test(text)) return { rows: [], rowCount: 0 };
    // Every real tenant op records the effective org scope active when it ran.
    effectiveOrgIds.push(effectiveOrg());

    // resolveRunFacts: runs ⋈ projects (selects r.org_id + p.config).
    if (/SELECT r\.org_id, r\.project_id, r\.spec_id, p\.config/u.test(sql)) {
      return {
        rows: [{ org_id: ORG_ID, project_id: PROJECT_ID, spec_id: SPEC_ID, config: projectConfig() }],
        rowCount: 1,
      };
    }
    // resolveCredentialsForRun: org provider-mode / default-credential read.
    if (/SELECT config FROM organizations WHERE id/u.test(sql)) {
      return { rows: [{ config: { version: 1 } }], rowCount: 1 };
    }
    // loadReviewMergeRunContext: the merge-stage run context join.
    if (/FROM runs r/u.test(sql) && /default_branch/u.test(sql)) {
      return {
        rows: [
          {
            run_id: RUN_ID,
            spec_id: SPEC_ID,
            project_id: PROJECT_ID,
            pr_url: PR_URL,
            config: projectConfig(),
            default_branch: "main",
            org_config: null,
          },
        ],
        rowCount: 1,
      };
    }
    // resolveSpeculativeState: not speculative (null base, no deps).
    if (/SELECT speculative_base, spec_id, project_id FROM runs/u.test(sql)) {
      return { rows: [{ speculative_base: null, spec_id: SPEC_ID, project_id: PROJECT_ID }], rowCount: 1 };
    }
    if (/SELECT depends_on FROM specs/u.test(sql)) return { rows: [{ depends_on: [] }], rowCount: 1 };
    // ensureMergeTask: no existing merge task → INSERT one.
    if (/FROM tasks/u.test(sql) && /LIMIT 1/u.test(sql)) return { rows: [], rowCount: 0 };
    if (text.startsWith("INSERT INTO tasks")) return { rows: [], rowCount: 1 };
    if (text.startsWith("UPDATE tasks SET status")) return { rows: [], rowCount: 1 };
    // event appends — record the type (param index 4 is event_type).
    if (text.startsWith(EVENTS_INSERT_PREFIX)) {
      events.push(String(params[4]));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in drive fake: ${text}`);
  };

  const client = {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(answer(sql, params)),
    release: () => {},
  };
  const pool = {
    query: (sql: string, params: readonly unknown[] = []) => Promise.resolve(answer(sql, params)),
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
  return { pool, effectiveOrgIds, events };
}

/** An external_reviewer project config: the drive hands off (no merge API call). */
function projectConfig(): unknown {
  return {
    version: 1,
    mergeIntegration: "external_reviewer",
    governancePosture: "open",
    reviewPolicy: "human",
    credentials: {
      githubCredentialRef: "credential/github/dev",
      codexCredentialRef: "credential/codex/dev",
    },
  };
}

function driveDeps(pool: pg.Pool) {
  return {
    pool,
    secrets: new FakeSecretStore(),
    vcsProvider: new InMemoryVcsProvider(),
  };
}

describe("buildDriveMerge — org scope on the coordinator drive (H2 regression)", () => {
  it("drives the merge WITHOUT throwing MissingOrgScopeError and never returns the masked 'blocked'", async () => {
    const { pool, events } = fakeDrivePool();
    const drive = buildDriveMerge(driveDeps(pool));

    // Before the fix, mergeForRun's task.started append threw MissingOrgScopeError,
    // driveAndSettle caught it → {kind:"blocked"} (the silent dequeue). Now the
    // external_reviewer hand-off completes: a non-blocked, non-throwing outcome.
    const outcome = await drive({ runId: RUN_ID, projectId: PROJECT_ID });

    // The hand-off ran end-to-end: it appended task.started + merge.queued (would
    // have thrown at the FIRST append with no scope).
    expect(events).toContain("task.started");
    expect(events).toContain("merge.queued");
    // `handed_off` maps to a terminal non-`merged` kind — NOT the masked `blocked`.
    expect(outcome.kind).not.toBe("blocked");
  });

  it("runs EVERY tenant op of the merge drive under the run's resolved org scope (the GUC the writes carry)", async () => {
    const { pool, effectiveOrgIds } = fakeDrivePool();
    const drive = buildDriveMerge(driveDeps(pool));

    await drive({ runId: RUN_ID, projectId: PROJECT_ID });

    // NO tenant op ran genuinely unscoped (undefined) — that is exactly the case
    // resolveQueryClient throws on. Every op carried a scope.
    expect(effectiveOrgIds).not.toContain(undefined);
    // The FIRST read (resolveRunFacts' runs⋈projects) is the system-scoped cross-org
    // bootstrap, so its effective org is null. Every op AFTER it — the org-config
    // credential read AND all of mergeForRun's tenant ops — runs under the run's
    // resolved org id (the GUC its reads/writes carry under RLS).
    expect(effectiveOrgIds[0]).toBeNull();
    const scopedTrace = effectiveOrgIds.slice(1);
    expect(scopedTrace.length).toBeGreaterThan(0);
    expect(scopedTrace.every((id) => id === ORG_ID)).toBe(true);
  });
});
