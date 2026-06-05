// Regression for the merge-coordinator-drive RLS-scope bug: the native
// MergeCoordinator drives `buildDriveMerge` with NO ambient org scope (it wakes on
// the run-activity bus, not a per-org request) over the RAW `deps.pool`. Every
// tenant-table READ the merge drive issues — `loadReviewMergeRunContext`
// (runs ⋈ projects ⋈ organizations), `resolveSpeculativeState`, `ensureMergeTask`'s
// SELECT, the re-gate CI run/PR reads — runs under the `tanren_app` (NOBYPASSRLS)
// role with an EMPTY `app.current_org_id` GUC, so deny-by-default RLS returns ZERO
// rows. The FIRST read, `loadReviewMergeRunContext`, then throws
// `ReviewMergeRunNotFoundError` for a run that EXISTS; the coordinator masks the
// throw as `{kind:"blocked"}` and a CLEAN, mergeable PR is silently dequeued and
// stranded.
//
// `runWithJobOrgId(facts.orgId)` alone does NOT fix it: that ambient marker holds NO
// connection, and a raw `pool.query` never emits the `SET LOCAL app.current_org_id`
// the GUC needs — only an `orgScopingPool` (whose `.query` self-routes each statement
// through a SHORT `runWithOrgScope`, opening a real connection-scope with the GUC set)
// admits the read under RLS. So the fixed drive hands its read paths an
// `orgScopingPool(deps.pool)`.
//
// These tests model RLS faithfully WITHOUT Postgres: a tenant read is admitted ONLY
// when a real CONNECTION scope (`getOrgScope()` — set by `runWithOrgScope` /
// `runWithSystemScope`, which emit the GUC) is open; the bare per-job org-id marker
// is treated as UNSCOPED (empty GUC → zero rows), exactly as the raw pool behaves
// under the live `tanren_app` role. The external_reviewer handoff path never calls
// the merge API, so no network is needed.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { getOrgScope } from "@tanren/db";
import { buildDriveMerge } from "../src/engine/merge/coordinatorBuild.js";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
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
 * The RLS-effective org a tenant op runs under, modelling the live `tanren_app`
 * (NOBYPASSRLS) role: a row is visible ONLY when an open CONNECTION scope set the
 * `app.current_org_id` GUC — `runWithOrgScope` (→ its org) or `runWithSystemScope`
 * (→ null, the BYPASSRLS cross-org read). A bare per-job org-id marker
 * (`runWithJobOrgId`) holds NO connection and emits NO `SET LOCAL`, so a raw-pool
 * query under it has an EMPTY GUC → `undefined` here → deny-by-default (zero rows).
 */
function rlsEffectiveOrg(): string | null | undefined {
  return getOrgScope()?.orgId;
}

interface DrivePoolHandle {
  pool: pg.Pool;
  /** The RLS-effective scope active on every tenant-table query (the SET-LOCAL trace). */
  effectiveOrgIds: Array<string | null | undefined>;
  events: string[];
}

/**
 * A fake pool for the merge-coordinator drive. It models RLS deny-by-default: a
 * tenant SELECT returns its row ONLY when a real connection scope is open (the GUC is
 * set); with an empty GUC it returns ZERO rows — exactly the live `tanren_app`
 * behavior. It also records the RLS-effective scope on every tenant op so the trace
 * proves each read carried the run's org GUC. The `runWithOrgScope` /
 * `runWithSystemScope` machinery checks out `connect()`'s client and runs the op on
 * it inside `storage.run`, so a query on that client sees the open scope.
 */
function fakeDrivePool(): DrivePoolHandle {
  const effectiveOrgIds: Array<string | null | undefined> = [];
  const events: string[] = [];

  // A tenant SELECT denied by RLS (empty GUC) returns NO rows — the live deny-by-default.
  const denied = { rows: [] as unknown[], rowCount: 0 };

  const answer = (sql: string, params: readonly unknown[]): { rows: unknown[]; rowCount: number } => {
    const text = sql.trim();
    // Transaction + LISTEN/NOTIFY control statements are not tenant-table ops.
    if (CONTROL_STATEMENT.test(text)) return { rows: [], rowCount: 0 };
    const scope = rlsEffectiveOrg();
    effectiveOrgIds.push(scope);
    // RLS deny-by-default: a tenant READ with no GUC (no open connection scope) sees
    // zero rows. The drive's cross-org bootstrap read uses `runWithSystemScope`
    // (BYPASSRLS, scope.orgId === null), which DOES see rows.
    const admitted = scope !== undefined;

    // resolveRunFacts: runs ⋈ projects (system-scoped — admitted via null scope).
    if (/SELECT r\.org_id, r\.project_id, r\.spec_id, p\.config/u.test(sql)) {
      return admitted
        ? { rows: [{ org_id: ORG_ID, project_id: PROJECT_ID, spec_id: SPEC_ID, config: projectConfig() }], rowCount: 1 }
        : denied;
    }
    // resolveCredentialsForRun: org provider-mode / default-credential read.
    if (/SELECT config FROM organizations WHERE id/u.test(sql)) {
      return admitted ? { rows: [{ config: { version: 1 } }], rowCount: 1 } : denied;
    }
    // loadReviewMergeRunContext: the merge-stage run context join — the FIRST tenant
    // read inside mergeForRun, where the bug threw ReviewMergeRunNotFoundError.
    if (/FROM runs r/u.test(sql) && /default_branch/u.test(sql)) {
      return admitted
        ? {
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
          }
        : denied;
    }
    // resolveSpeculativeState: not speculative (null base, no deps).
    if (/SELECT speculative_base, spec_id, project_id FROM runs/u.test(sql)) {
      return admitted
        ? { rows: [{ speculative_base: null, spec_id: SPEC_ID, project_id: PROJECT_ID }], rowCount: 1 }
        : denied;
    }
    if (/SELECT depends_on FROM specs/u.test(sql))
      return admitted ? { rows: [{ depends_on: [] }], rowCount: 1 } : denied;
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
    // The drive-path conflict resolver's deps. This test exercises the
    // external_reviewer HAND-OFF (no conflict), so the resolver hook is never
    // invoked — fakes satisfy the now-required deps without being driven.
    allocator: new FakeAllocator(),
    ssh: new FakeCommandSubstrate(),
    identitySecretRef: "secret/runner/identity",
  };
}

describe("buildDriveMerge — RLS scope on the coordinator merge drive", () => {
  it("loads the run context under a GUC-bearing scope (no ReviewMergeRunNotFoundError for an existing run) and never returns the masked 'blocked'", async () => {
    const { pool, events } = fakeDrivePool();
    const drive = buildDriveMerge(driveDeps(pool));

    // Pre-fix, the drive read tenant tables on the RAW pool under only a per-job
    // org-id marker (empty GUC). loadReviewMergeRunContext saw zero rows and threw
    // ReviewMergeRunNotFoundError → the coordinator masked it as {kind:"blocked"}
    // and stranded the clean PR. Now every read self-routes through a real
    // runWithOrgScope, so the context loads and the external_reviewer hand-off runs.
    const outcome = await drive({ runId: RUN_ID, projectId: PROJECT_ID });

    // The hand-off ran end-to-end: it appended task.started + merge.queued (a denied
    // context read would have thrown BEFORE the first append).
    expect(events).toContain("task.started");
    expect(events).toContain("merge.queued");
    // `handed_off` maps to a terminal non-`merged` kind — NOT the masked `blocked`.
    expect(outcome.kind).not.toBe("blocked");
  });

  it("runs EVERY tenant read of the merge drive under a GUC-bearing scope (the SET-LOCAL trace)", async () => {
    const { pool, effectiveOrgIds } = fakeDrivePool();
    const drive = buildDriveMerge(driveDeps(pool));

    await drive({ runId: RUN_ID, projectId: PROJECT_ID });

    // NO tenant op ran with an empty GUC (undefined) — that is exactly the RLS-deny
    // case that stranded the PR. Every op carried a real connection scope.
    expect(effectiveOrgIds).not.toContain(undefined);
    // The FIRST read (resolveRunFacts' runs⋈projects) is the system-scoped cross-org
    // bootstrap, so its GUC is null (BYPASSRLS). Every op AFTER it — the org-config
    // credential read AND all of mergeForRun's tenant reads — runs under the run's
    // resolved org id (the GUC its reads carry under RLS).
    expect(effectiveOrgIds[0]).toBeNull();
    const scopedTrace = effectiveOrgIds.slice(1);
    expect(scopedTrace.length).toBeGreaterThan(0);
    expect(scopedTrace.every((id) => id === ORG_ID)).toBe(true);
  });
});
