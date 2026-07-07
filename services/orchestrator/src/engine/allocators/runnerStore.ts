import type pg from "pg";
import { withJobOrgScope } from "../data/orgScopedDb.js";

export interface ClaimRunnerInput {
  runnerId: string;
  /**
   * The value written to `runners.run_id` (FK → `runs`). `null` for a RUNLESS
   * Forge ideation allocation, whose synthetic handle is NOT a row in `runs` —
   * persisting it would violate `runners_run_id_runs_run_id_fk`. `runners.run_id`
   * is nullable, so NULL is the correct "no run" value. The synthetic handle is
   * still used by the allocator for runner/container naming; only the DB column
   * is NULL.
   */
  runId: string | null;
  /**
   * The value written to `runners.project_id` (FK → `projects`). `null` for a
   * project-less Forge ideation allocation (e.g. the greenfield interview, which
   * runs before any project exists) — the same FK reasoning as `runId`.
   */
  projectId: string | null;
  /**
   * The org the runner belongs to — the CALLER's org, threaded EXPLICITLY so the
   * `runners` row carries a valid tenant org_id even for a RUNLESS allocation (a
   * Forge ideation runner whose `runId` is a synthetic, non-`runs` handle). This
   * was previously derived in-statement from `(SELECT org_id FROM runs WHERE
   * run_id = $runId)`, which returns NULL for that runless handle and made the
   * org-scoped INSERT violate the `runners` WITH CHECK policy (the apex onboarding
   * interview 500'd here). `null` is the EXPLICIT system / null-org job case (the
   * worker's system scope / BYPASSRLS), NOT a missing value.
   */
  orgId: string | null;
  allocator: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  imageSha: string;
  containerId: string;
  /**
   * Cloud-provider teardown descriptor persisted alongside the row so a
   * restarted allocator can reconstruct the DELETE call without the in-memory
   * `runnerId -> resourceId` map that lives only for the process's lifetime
   * (Codex H3 Surface 5 #13). Each cloud allocator writes a discriminated
   * `{ kind, ...perProviderFields }` blob (see `providerTeardown.ts`); the
   * long-lived / no-external-resource kinds (`static-runner`, `manual-ssh`,
   * `sidecar-docker`) leave it `null` because their release semantics live in
   * the orphan sweepers, not here.
   */
  providerMetadata?: ProviderTeardownMetadata | null;
}

/**
 * The union of every cloud allocator's teardown descriptor, discriminated on
 * `kind`. Persisted verbatim as jsonb in `runners.provider_metadata` at claim
 * time, and consulted on release when the allocator's in-memory map misses
 * (the process-restart shape the H3 #13 finding names). Adding a new cloud
 * kind requires (a) extending this union, (b) updating the per-allocator
 * claim, and (c) wiring the release-path reconstruction — no silent shape
 * drift is possible because both writers and readers reference this union.
 */
export type ProviderTeardownMetadata =
  | { kind: "digitalocean"; dropletId: number }
  | { kind: "gcp"; instanceName: string }
  | { kind: "aws_ec2"; instanceId: string }
  | { kind: "kubernetes"; podName: string; secretName: string }
  | { kind: "hetzner"; serverId: number; sshKeyId: number; identitySecretRef: string };

/**
 * Thrown by {@link PgRunnerStore.claim} when the INSERT…ON CONFLICT matches a
 * LIVE `runners` row (one whose `released_at IS NULL`) — the conditional UPDATE
 * branch excludes it, the INSERT branch collides on the unique runner_id, so
 * zero rows are affected. This is a WIRING bug surface — the lifecycle is
 * meant to pre-check and short-circuit before reaching here, or two paths are
 * double-claiming the same deterministic handle (a job-reaper requeue racing
 * the original worker). It is NEVER a transient — re-trying the same INSERT
 * will hit the same LIVE row on the next pass and fail-loop forever (apex v49:
 * the bare INSERT threw an untyped `runners_pkey`, which `isRetriableInfraError`
 * defaults to RETRIABLE, and the merge coordinator's hold-loop re-drove
 * forever → an 8-hour curl hang).
 *
 * Carrying `retriable: false` opts INTO the typed-permanent path: the per-PR
 * coordinator wraps the throw as `{ kind: "blocked" }` → the recoverable
 * sustained-non-recovery hold (`holdOrHaltRecoverableDrive`) emits a LOUD
 * `merge.queue.infra_blocked` alert keyed off the unchanging signature and
 * keeps the entry queued; the batch coordinator routes the same way
 * (`holdOnRetriableDriveThrow` returns `undefined`, the catch wraps as
 * `blocked`, `settleDriveOutcome` reaches the same hold). Recovery stays
 * autonomous (the entry is never abandoned) but the hot-loop is broken — the
 * doctrine line from `docs/roadmap/timeout-eradication.md` §1: a structural
 * fixed-point is NOT a transient.
 */
export class RunnerClaimLiveRowError extends Error {
  readonly retriable = false as const;
  readonly runnerId: string;
  constructor(runnerId: string) {
    super(`runner ${runnerId} already has a LIVE row (released_at IS NULL); refusing to re-claim`);
    this.name = "RunnerClaimLiveRowError";
    this.runnerId = runnerId;
  }
}

export interface RunnerStore {
  claim(input: ClaimRunnerInput): Promise<void>;
  release(runnerId: string): Promise<void>;
  /**
   * Read the persisted provider teardown descriptor for a LIVE runner row —
   * the DB is the source of truth so a fresh allocator instance (post-restart)
   * can reconstruct the DELETE without its in-memory map (Codex H3 #13). Only
   * returns metadata for rows whose `released_at IS NULL`; a missing row OR an
   * already-released row returns `undefined` (the correct no-op signal for a
   * cold-start release). The `providerMetadata` field itself is `null` for the
   * long-lived allocator kinds that don't populate it — the release path
   * treats `null` identically to `undefined` (no-op).
   */
  readTeardownDescriptor(runnerId: string): Promise<ProviderTeardownMetadata | undefined>;
}

export class PgRunnerStore implements RunnerStore {
  constructor(private readonly pool: pg.Pool) {}

  async claim(input: ClaimRunnerInput): Promise<void> {
    // RLS R3a-worker (runners write): the allocator runs OUTSIDE an open
    // connection scope — the worker holds only the lightweight per-job org-id
    // (`runWithJobOrgId`, no connection across the run's minutes of I/O), so a
    // `resolveWritableClient` seam (which only finds an OPEN connection scope)
    // would fall through to the bare pool and the enforced `tanren_app` policy
    // rejects the unscoped INSERT (`new row violates row-level security policy
    // for table "runners"`). Routing through `withJobOrgScope` opens a SHORT
    // `runWithOrgScope` from the per-job org-id for THIS statement, so the
    // INSERT carries `app.current_org_id` and the policy admits the run's own
    // runner row. A system / null-org job (org_id NULL) runs under the worker's
    // per-job SYSTEM scope, so this routes through a short `runWithSystemScope`
    // (BYPASSRLS) instead — never an implicit unscoped bare-pool write.
    //
    // Idempotent claim (apex v49 / task #21A): the runner id is the
    // deterministic `runner_<handle>`, so a RETRIED claim for the same handle —
    // the job-reaper requeue of a lapsed-lease running job (lease expires, a
    // new worker claims the same `run_id` → derives the same `runner_<runId>`
    // → INSERTs the same `runner_id`) — collides on the unique runner_id. A
    // bare INSERT threw `runners_pkey` raw, which the merge coordinator's
    // hold-loop classified RETRIABLE-by-default (`isRetriableInfraError`
    // defaults untyped errors to retriable —
    // `engine/providers/githubRefReset.ts`); apex v49 looped on this for 8 hours.
    //
    // A bare `ON CONFLICT DO UPDATE` would overwrite a still-LIVE container_id
    // and orphan the prior container (the 204GB-leak class the sidecar's
    // `insert` already guards). The `WHERE runners.released_at IS NOT NULL`
    // predicate restricts the UPDATE to RE-allocating an already-RELEASED
    // runner id; a genuine LIVE conflict updates zero rows AND inserts zero
    // rows (the conditional UPDATE excludes the live row, the INSERT collides),
    // which we detect (rowCount===0) and reject LOUD as a typed-non-retryable
    // {@link RunnerClaimLiveRowError}. Mirrors the sidecar's identical pattern
    // in `services/allocator/src/pgRunnerStore.ts`.
    await withJobOrgScope(this.pool, async (client) => {
      const result = await client.query(
        // org_id is mandatory (tanren tenancy hardening) and is the CALLER's org,
        // passed EXPLICITLY ($4) — NOT derived from a `(SELECT org_id FROM runs
        // …)` subquery. A RUNLESS Forge allocation has a synthetic `runId` with no
        // matching `runs` row, so that subquery returned NULL and the org-scoped
        // INSERT violated the runners WITH CHECK policy. The runner's org is the
        // org the allocate request belongs to, full stop. `null` is the explicit
        // system / null-org job case, written under the worker's BYPASSRLS scope.
        //
        // run_id ($2) and project_id ($3) are likewise the EXPLICIT values, and
        // are NULL for a runless / project-less Forge ideation allocation — both
        // columns are nullable, so NULL avoids the run_id→runs / project_id→projects
        // FK violations the synthetic handle would otherwise cause.
        // LOCKSTEP CREATED_AT (task #8): on a re-adopt UPDATE branch (a previously-
        // released runner_id being re-claimed — e.g. orchestrator restart, lease
        // takeover, job-reaper requeue) `created_at` is set EXPLICITLY to
        // `runners.created_at` (the existing row's value) — a deliberate no-op SQL
        // pin that documents the invariant in the statement itself rather than
        // leaving it implicit-by-omission. A future mutation that drops the line
        // would visibly REGRESS the SQL surface and is caught by
        // `runnerStore.test.ts`. The original allocation timestamp drives
        // oldest-first sweeper ordering + DORA timing; resetting it to `now()` on
        // re-adopt (the `EXCLUDED.created_at` alternative, the bug shape #8 names)
        // would silently warp every downstream signal that keys off allocation age.
        // provider_metadata ($11) carries the cloud teardown descriptor (Codex
        // H3 #13). Serialized to JSON on the app side so the pg driver binds
        // it as a jsonb literal (a bare object bind is rejected as
        // `invalid input syntax for type json`). `null` for the long-lived /
        // no-external-resource kinds — indistinguishable from a legacy row
        // predating this column, which is correct: neither has anything to
        // reconstruct on release.
        `INSERT INTO runners (
           runner_id, run_id, project_id, org_id, allocator, status, ssh_host, ssh_port,
           host_key_fingerprint, image_sha, container_id, provider_metadata
         )
         VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (runner_id) DO UPDATE SET
           status = EXCLUDED.status,
           run_id = EXCLUDED.run_id,
           project_id = EXCLUDED.project_id,
           org_id = EXCLUDED.org_id,
           allocator = EXCLUDED.allocator,
           ssh_host = EXCLUDED.ssh_host,
           ssh_port = EXCLUDED.ssh_port,
           host_key_fingerprint = EXCLUDED.host_key_fingerprint,
           image_sha = EXCLUDED.image_sha,
           container_id = EXCLUDED.container_id,
           provider_metadata = EXCLUDED.provider_metadata,
           created_at = runners.created_at,
           released_at = NULL
         WHERE runners.released_at IS NOT NULL`,
        [
          input.runnerId,
          input.runId,
          input.projectId,
          input.orgId,
          input.allocator,
          input.sshHost,
          input.sshPort,
          input.hostKeyFingerprint,
          input.imageSha,
          input.containerId,
          input.providerMetadata === undefined || input.providerMetadata === null
            ? null
            : JSON.stringify(input.providerMetadata),
        ],
      );
      if (result.rowCount === 0) {
        throw new RunnerClaimLiveRowError(input.runnerId);
      }
    });
  }

  async release(runnerId: string): Promise<void> {
    // RLS R3a-worker (runners write): same per-job-org-id seam as `claim` —
    // the release runs under the worker's `runWithJobOrgId` (no open connection
    // scope), so it opens a SHORT org-scoped txn for this UPDATE.
    await withJobOrgScope(this.pool, (client) =>
      client.query("UPDATE runners SET status = 'released', released_at = now() WHERE runner_id = $1", [runnerId]),
    );
  }

  /**
   * Codex H3 #13: cloud teardown reconstruction for a restarted allocator.
   * Returns the persisted `provider_metadata` blob for a LIVE row
   * (`released_at IS NULL`). A missing row OR an already-released row returns
   * `undefined` — the calling allocator treats that as a no-op (nothing to
   * tear down, or a concurrent release already won). Runs through the same
   * per-job-org-id seam as `claim` / `release` so the SELECT is RLS-scoped to
   * the caller's tenant (the allocator layer is always inside a per-job scope
   * by this point; a bare-pool read would trip RLS deny-by-default).
   */
  async readTeardownDescriptor(runnerId: string): Promise<ProviderTeardownMetadata | undefined> {
    return withJobOrgScope(this.pool, async (client) => {
      const result = await client.query<{ provider_metadata: ProviderTeardownMetadata | null }>(
        `SELECT provider_metadata
         FROM runners
         WHERE runner_id = $1 AND released_at IS NULL`,
        [runnerId],
      );
      // Missing row (already released or never existed) → no-op.
      // A `null` blob is a legacy row (predates 0028) or a long-lived kind that
      // never populated it — either way there is nothing to reconstruct.
      return result.rows[0]?.provider_metadata ?? undefined;
    });
  }
}
