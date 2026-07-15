// Exact-stack plane-split proof: seed through the owner connection, require the
// separate de-privileged worker to claim over mTLS and finalize remotely, then
// verify the durable result and deny-by-default RLS behavior through tanren_app.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createDbPool } from "../../db/src/index.js";
import { proveDataPlaneWriteDenied, proveDeprivilegeEnabled } from "./plane-split-deprivilege.js";
import { runScopedOrgRead } from "./plane-split-tx.js";
import { progressCycleReached } from "./stack-progress.js";
import { ProcessGroupRegistry } from "./stack-runtime.js";
import { inspectWorkerContainer, WorkerClaimMonitor } from "./stack-worker.js";

const workerAbort = new AbortController();
const workerGroups = new ProcessGroupRegistry();
const abortWorker = (signal: string) => workerAbort.abort(new Error(`plane-split worker interrupted by ${signal}`));
const onSigInt = () => abortWorker("SIGINT");
const onSigTerm = () => abortWorker("SIGTERM");
process.on("SIGINT", onSigInt);
process.on("SIGTERM", onSigTerm);

const MTLS_DIR = requiredEnv("TANREN_MTLS_DIR");
const CLAIM_ENDPOINT = requiredEnv("TANREN_CLAIM_ENDPOINT_SMOKE_URL");

const OWNER_URL = requiredEnv("DATABASE_URL");
const APP_URL = requiredEnv("TANREN_APP_DATABASE_URL");
const PROOF_PATH = requiredEnv("TANREN_SMOKE_PROOF_PATH");
const WORKER_CONTAINER_ID = requiredEnv("TANREN_SMOKE_WORKER_CONTAINER_ID");
const RUNTIME_EXECUTABLE = requiredEnv("TANREN_SMOKE_RUNTIME_EXECUTABLE");
/** Between-probe spacing (cadence), not a deadline or poll budget. */
const POLL_INTERVAL_MS = 2_000;

const orgId = `org_planesplit_${randomUUID().slice(0, 8)}`;
const projectId = `project_${randomUUID()}`;
const specId = `spec_${randomUUID()}`;
const runId = `run_${randomUUID()}`;
const plannerTaskId = `task_${randomUUID()}`;
const canaryRunId = `run_${randomUUID()}`;
const canaryTaskId = `task_${randomUUID()}`;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required for the exact-stack smoke`);
  return value;
}

async function seedQueuedRun(): Promise<{ queueId: number; enqueuedAtMs: number }> {
  const owner = createDbPool(OWNER_URL);
  try {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name)
       VALUES ($1, 'github_user', $1, 'planesplit-smoke', 'Plane-split Smoke')
       ON CONFLICT (id) DO NOTHING`,
      [orgId],
    );
    await owner.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, allocator, org_id)
       VALUES ($1, 'planesplit-smoke', 'https://github.com/cat-cave/tanren-fixture-easy', 'main', $2, 'local-docker', $3)`,
      [projectId, "ghcr.io/cat-cave/tanren-runner:v0", orgId],
    );
    await owner.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, acceptance_criteria, status)
       VALUES ($1, $2, $3, 'Plane-split worker proof', 'Cross-process claim+execute', $4::jsonb, 'in_flight')`,
      [specId, projectId, orgId, JSON.stringify(["worker claims it across the process boundary"])],
    );
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'tanren/planesplit-smoke', 'queued')`,
      [runId, specId, projectId, orgId],
    );
    await owner.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'Plan spec implementation', 'queued', 'answerer', 'fake', 'gpt-5-codex')`,
      [plannerTaskId, runId, orgId],
    );
    const queued = await owner.query<{ id: number; enqueued_at: Date }>(
      `INSERT INTO job_queue (run_id, task_id, task_kind, payload, org_id)
       VALUES ($1, $2, 'plan', $3::jsonb, $4)
       RETURNING id, enqueued_at`,
      [runId, plannerTaskId, JSON.stringify({ specId, projectId }), orgId],
    );
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'tanren/planesplit-canary', 'queued')`,
      [canaryRunId, specId, projectId, orgId],
    );
    await owner.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'Plan (claim watermark)', 'queued', 'answerer', 'fake', 'gpt-5-codex')`,
      [canaryTaskId, canaryRunId, orgId],
    );
    await owner.query(
      `INSERT INTO job_queue (run_id, task_id, task_kind, payload, org_id)
       VALUES ($1, $2, 'plan', $3::jsonb, $4)`,
      [canaryRunId, canaryTaskId, JSON.stringify({ specId, projectId }), orgId],
    );
    await owner.query("SELECT pg_notify('tanren_job_queue', '')");
    const target = queued.rows[0];
    if (target === undefined) throw new Error("seeded job did not return its durable queue identity");
    return { queueId: target.id, enqueuedAtMs: target.enqueued_at.getTime() };
  } finally {
    await owner.end();
  }
}

interface JobObservation {
  status: string | undefined;
  attempts: number;
  failureKind: string | null;
  jobOrgId: string | null;
  heartbeatAtMs: number | null;
  databaseNowMs: number;
}

async function observeJob(owner: ReturnType<typeof createDbPool>, targetQueueId: number): Promise<JobObservation> {
  const row = await owner.query<{
    status: string;
    attempts: number;
    failure_kind: string | null;
    org_id: string | null;
    heartbeat_at: Date | null;
    database_now: Date;
  }>(
    `SELECT status, attempts, failure_kind, org_id, heartbeat_at,
            clock_timestamp() AS database_now
       FROM job_queue WHERE id = $1 AND task_id = $2`,
    [targetQueueId, plannerTaskId],
  );
  const job = row.rows[0];
  if (job === undefined) throw new Error(`seeded queue row ${targetQueueId} disappeared`);
  return {
    status: job.status,
    attempts: job.attempts,
    failureKind: job.failure_kind,
    jobOrgId: job.org_id,
    heartbeatAtMs: job.heartbeat_at instanceof Date ? job.heartbeat_at.getTime() : null,
    databaseNowMs: job.database_now.getTime(),
  };
}

async function rlsVisibility(): Promise<[number, number, string | undefined]> {
  const app = createDbPool(APP_URL);
  try {
    const read = async (org: string | null): Promise<{ rows: number; status: string | undefined }> => {
      const client = await app.connect();
      return runScopedOrgRead(client, org, async () => {
        const result = await client.query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [runId]);
        return { rows: result.rowCount ?? 0, status: result.rows[0]?.status };
      });
    };
    const scoped = await read(orgId);
    const empty = await read(null);
    return [scoped.rows, empty.rows, scoped.status];
  } finally {
    await app.end();
  }
}

const mtlsRunId = `run_${randomUUID()}`;
const mtlsTaskId = `task_${randomUUID()}`;
const MTLS_PROBE_KIND = "demo";

async function seedMtlsClaimRun(): Promise<void> {
  const owner = createDbPool(OWNER_URL);
  try {
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'tanren/planesplit-mtls', 'queued')`,
      [mtlsRunId, specId, projectId, orgId],
    );
    await owner.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli, model)
       VALUES ($1, $2, $3, 'plan', 'Plan (mTLS claim proof)', 'queued', 'answerer', 'fake', 'gpt-5-codex')`,
      [mtlsTaskId, mtlsRunId, orgId],
    );
    await owner.query(
      `INSERT INTO job_queue (run_id, task_id, task_kind, payload, org_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [mtlsRunId, mtlsTaskId, MTLS_PROBE_KIND, JSON.stringify({ specId, projectId }), orgId],
    );
  } finally {
    await owner.end();
  }
}

interface ClaimAttempt {
  status: number | "tls_rejected";
  body: string;
}

function postOverMtls(path: string, payload: unknown, withClientCert: boolean): Promise<ClaimAttempt> {
  const ca = readFileSync(`${MTLS_DIR}/ca.crt`);
  const target = new URL(path, CLAIM_ENDPOINT);
  const body = JSON.stringify(payload);
  return new Promise<ClaimAttempt>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        ca,
        rejectUnauthorized: true,
        ...(withClientCert
          ? { cert: readFileSync(`${MTLS_DIR}/worker.crt`), key: readFileSync(`${MTLS_DIR}/worker.key`) }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", (error) => {
      // A handshake rejection (no/invalid client cert) surfaces as a socket/TLS
      // error, NOT an HTTP status — that IS the authn-closed proof.
      const message = String((error as { code?: string }).code ?? error);
      if (/ALERT|HANDSHAKE|ECONNRESET|EPROTO|SSL|TLS/iu.test(message)) {
        resolve({ status: "tls_rejected", body: message });
      } else {
        reject(error);
      }
    });
    req.write(body);
    req.end();
  });
}

function claimOverMtls(claimRunId: string, withClientCert: boolean): Promise<ClaimAttempt> {
  return postOverMtls("/internal/claim-job", { taskKind: MTLS_PROBE_KIND, runId: claimRunId }, withClientCert);
}

async function proveMtlsClaimEndpoint(): Promise<void> {
  await seedMtlsClaimRun();
  process.stdout.write(`[plane-split-smoke] seeded mTLS-claim run ${mtlsRunId}; probing /internal/claim-job…\n`);

  const noCert = await claimOverMtls(mtlsRunId, false);
  if (noCert.status !== "tls_rejected" && noCert.status !== 401) {
    throw new Error(`mTLS authn NOT enforced: a no-cert caller got status ${String(noCert.status)} (expected reject)`);
  }
  process.stdout.write(`[plane-split-smoke] authn closed: no-cert claim rejected (${String(noCert.status)})\n`);

  const withCert = await claimOverMtls(mtlsRunId, true);
  if (withCert.status !== 200) {
    throw new Error(`mTLS claim failed: trusted caller got status ${String(withCert.status)} — ${withCert.body}`);
  }
  const parsed = JSON.parse(withCert.body) as { job: { runId?: string; orgId?: string } | null };
  if (parsed.job?.runId !== mtlsRunId) {
    throw new Error(`mTLS claim returned the wrong job: ${JSON.stringify(parsed.job)}`);
  }
  if (parsed.job.orgId !== orgId) {
    throw new Error(`mTLS claim dropped the org thread: expected ${orgId}, got ${String(parsed.job.orgId)}`);
  }
  process.stdout.write(
    `[plane-split-smoke] PROOF (P2): the trusted worker cert claimed ${mtlsRunId} over mTLS via ` +
      `/internal/claim-job — org=${String(parsed.job.orgId)} (same atomic CAS, transport behind mutual TLS)\n`,
  );
}

const writeRunId = `run_${randomUUID()}`;

async function seedWriteProbeRun(): Promise<void> {
  const owner = createDbPool(OWNER_URL);
  try {
    await owner.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, $3, $4, 'cli', 'tanren/planesplit-p3-write', 'running')`,
      [writeRunId, specId, projectId, orgId],
    );
  } finally {
    await owner.end();
  }
}

async function readWriteProbeRun(): Promise<{ status: string | undefined; events: number }> {
  const owner = createDbPool(OWNER_URL);
  try {
    const run = await owner.query<{ status: string }>("SELECT status FROM runs WHERE run_id = $1", [writeRunId]);
    const ev = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM events WHERE run_id = $1 AND event_type = 'run.failed'",
      [writeRunId],
    );
    return { status: run.rows[0]?.status, events: Number(ev.rows[0]?.n ?? "0") };
  } finally {
    await owner.end();
  }
}

async function proveMtlsWriteEndpoints(): Promise<void> {
  await seedWriteProbeRun();
  process.stdout.write(`[plane-split-smoke] seeded write-probe run ${writeRunId}; probing /internal/finalize-run…\n`);

  const noCert = await postOverMtls(
    "/internal/finalize-run",
    { runId: writeRunId, orgId, status: "halted", outcome: "halted", fromStatuses: ["running", "queued"] },
    false,
  );
  if (noCert.status !== "tls_rejected" && noCert.status !== 401) {
    throw new Error(`P3 write authn NOT enforced: no-cert finalize got ${String(noCert.status)} (expected reject)`);
  }
  process.stdout.write(`[plane-split-smoke] authn closed: no-cert write rejected (${String(noCert.status)})\n`);

  const finalize = await postOverMtls(
    "/internal/finalize-run",
    { runId: writeRunId, orgId, status: "halted", outcome: "halted", fromStatuses: ["running", "queued"] },
    true,
  );
  if (finalize.status !== 200) {
    throw new Error(`P3 finalize-run failed: trusted caller got ${String(finalize.status)} — ${finalize.body}`);
  }
  const finalized = JSON.parse(finalize.body) as { updated: boolean; specId?: string };
  if (!finalized.updated || finalized.specId !== specId) {
    throw new Error(`P3 finalize-run did not move the run: ${finalize.body}`);
  }

  const event = await postOverMtls(
    "/internal/append-event",
    {
      runId: writeRunId,
      specId,
      projectId,
      orgId,
      eventType: "run.failed",
      // run.failed is PUBLIC + redacted: its payload carries ONLY a closed-vocabulary
      // failureCode + stage + a FIXED safe summary (never a raw error string) — see
      // engine/worker/runFailureClassifier.ts. The server-side append re-parses against
      // RunFailedPayload (strict, all four fields required), so the proof must send the
      // real redacted shape, not the legacy `{ status, message }`.
      payload: {
        status: "halted",
        failureCode: "internal",
        stage: "run",
        message: "plane-split P3 write-endpoint proof",
      },
    },
    true,
  );
  if (event.status !== 204) {
    throw new Error(`P3 append-event failed: trusted caller got ${String(event.status)} — ${event.body}`);
  }

  // Exactly-once: a retried finalize matches no row now (the run is halted), so
  // it is a no-op — proving a retry never double-finalizes.
  const retry = await postOverMtls(
    "/internal/finalize-run",
    { runId: writeRunId, orgId, status: "halted", outcome: "halted", fromStatuses: ["running", "queued"] },
    true,
  );
  const retryResult = JSON.parse(retry.body) as { updated: boolean };
  if (retry.status !== 200 || retryResult.updated !== false) {
    throw new Error(`P3 finalize-run is NOT exactly-once: a retry re-finalized (${retry.body})`);
  }

  const persisted = await readWriteProbeRun();
  if (persisted.status !== "halted") {
    throw new Error(`P3 write did not land: run ${writeRunId} status=${String(persisted.status)} (expected halted)`);
  }
  if (persisted.events < 1) {
    throw new Error(`P3 append-event did not land: 0 run.failed events for ${writeRunId}`);
  }
  process.stdout.write(
    `[plane-split-smoke] PROOF (P3): the trusted worker cert finalized ${writeRunId} + appended its event over ` +
      `mTLS via /internal/finalize-run + /internal/append-event — rows landed server-side under enforced RLS ` +
      `(status=${persisted.status}, run.failed events=${persisted.events}); a retried finalize was a no-op ` +
      `(exactly-once). The data plane wrote NO tenant tables directly.\n`,
  );
}

// The worker has finished with the job once it leaves `queued`/`claimed`/`running`.
const QUEUE_TERMINAL = new Set(["done", "failed", "cancelled", "dead_letter"]);
const RUN_TERMINAL = new Set(["halted", "completed", "failed", "cancelled"]);

function finalizationMatches(queueStatus: string, runStatus: string): boolean {
  if (queueStatus === "done") return runStatus === "completed";
  if (queueStatus === "cancelled") return runStatus === "cancelled";
  return (
    (queueStatus === "failed" || queueStatus === "dead_letter") && (runStatus === "halted" || runStatus === "failed")
  );
}

async function main(): Promise<void> {
  const target = await seedQueuedRun();
  process.stdout.write(
    `[plane-split-smoke] seeded queued run ${runId} (org ${orgId}); waiting for the worker container…\n`,
  );

  await proveMtlsClaimEndpoint();

  await proveMtlsWriteEndpoints();

  if (proveDeprivilegeEnabled()) {
    await proveDataPlaneWriteDenied({ orgId, runId, specId, projectId });
  }

  const owner = createDbPool(OWNER_URL);
  // Progress model: target-specific durable claim/finalization signatures. Concurrent
  // later queue IDs are never treated as progress for this target. Identical target
  // repeated structural signatures are a non-progress cycle (worker wedged), not a time budget.
  const claimMonitor = new WorkerClaimMonitor({ expectedWorkerContainerId: WORKER_CONTAINER_ID });
  const postClaimSignatures: string[] = [];
  try {
    let claimed = false;
    for (;;) {
      const job = await observeJob(owner, target.queueId);
      const worker = await inspectWorkerContainer(RUNTIME_EXECUTABLE, WORKER_CONTAINER_ID, process.env, {
        cwd: process.cwd(),
        signal: workerAbort.signal,
        onGroup: (pgid, state) => workerGroups.record(pgid, state),
      });
      const verdict = claimMonitor.observe({
        targetQueueId: target.queueId,
        targetStatus: job.status,
        targetAttempts: job.attempts,
        targetHeartbeatAtMs: job.heartbeatAtMs,
        enqueuedAtMs: target.enqueuedAtMs,
        databaseNowMs: job.databaseNowMs,
        ...worker,
      });
      if ((verdict === "claimed" || verdict === "finalized") && !claimed) {
        claimed = true;
        process.stdout.write(
          `[plane-split-smoke] worker container CLAIMED the job (job_queue status: ${job.status})\n`,
        );
      }
      if (verdict === "finalized" || (job.status !== undefined && QUEUE_TERMINAL.has(job.status))) {
        if (job.jobOrgId !== orgId) {
          throw new Error(`job org mismatch: expected ${orgId}, got ${String(job.jobOrgId)}`);
        }
        const [scopedRows, emptyScopeRows, runStatus] = await rlsVisibility();
        if (scopedRows < 1) {
          throw new Error("run not visible under its own org scope on the tanren_app role (RLS misconfigured)");
        }
        if (emptyScopeRows !== 0) {
          throw new Error("run visible under an EMPTY scope on tanren_app — RLS deny-by-default not enforced");
        }
        if (runStatus === undefined || !RUN_TERMINAL.has(runStatus)) {
          postClaimSignatures.push(`queue=${job.status}|run=${String(runStatus)}|attempts=${job.attempts}`);
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              // Poll cadence only; structural queue/run state controls convergence.
              resolve();
            }, POLL_INTERVAL_MS);
          });
          continue;
        }
        if (!finalizationMatches(job.status!, runStatus)) {
          throw new Error(`queue/run finalization contradiction: queue=${job.status}, run=${runStatus}`);
        }
        process.stdout.write(
          `[plane-split-smoke] PROOF: the standalone worker container claimed + finished the job across the ` +
            `API↔worker process boundary — job_queue status=${job.status} attempts=${job.attempts} ` +
            `failureKind=${String(job.failureKind)} org=${String(job.jobOrgId)}; the run finalized to a terminal ` +
            `state (status=${String(runStatus)}) and is org-scoped under the tanren_app role ` +
            `(scoped=${scopedRows} row, empty-scope=${emptyScopeRows} rows / deny-by-default)\n`,
        );
        writeFileSync(
          PROOF_PATH,
          `${JSON.stringify({ runId, orgId, projectId, specId, jobStatus: job.status, runStatus, claimEndpoint: CLAIM_ENDPOINT }, null, 2)}\n`,
          { mode: 0o600 },
        );
        return;
      }
      if (claimed) {
        const signature = `${job.status ?? "missing"}|${job.attempts}|${String(job.heartbeatAtMs ?? "null")}`;
        postClaimSignatures.push(signature);
        if (progressCycleReached(postClaimSignatures)) {
          throw new Error(
            `STALL: post-claim target made no durable progress at signature ${signature} for run ${runId}`,
          );
        }
      }
      await new Promise((resolve) => {
        setTimeout(resolve, POLL_INTERVAL_MS);
      });
    }
  } finally {
    await owner.end();
  }
}

try {
  await main();
} finally {
  process.off("SIGINT", onSigInt);
  process.off("SIGTERM", onSigTerm);
  await workerGroups.fenceAll();
  workerGroups.assertEmpty();
}
