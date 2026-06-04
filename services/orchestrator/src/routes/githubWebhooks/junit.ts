// CI-intelligence ingestion (foundation): the JUnit report INGEST endpoint.
//
//   POST /webhooks/ci/junit
//
// The generated repo's CI (`tanren-ci.yml`) emits a JUnit XML report from its
// test step, then uploads it here (runner-push — webhook-first, so no new App
// artifact scopes). The push is authenticated with the per-run token that is
// already propagated to the repo as an Actions secret, presented as an HMAC
// signature over the RAW body (the SAME mandatory-signature contract the
// `/github/webhooks/ci` receiver uses — there is NO unsigned-acceptance path).
//
// The receiver carries no tenant context (the runner is outside Tanren), so it
// resolves the run SYSTEM-scoped to get its (org, project), then performs the
// per-test write + the `ci.tests.reported` emit UNDER that run's org scope, so
// the inserts are RLS-checked (deny-by-default). A malformed report is a LOUD
// 400 — never a silent accept (a runner that crashed after writing a clean
// report must not be read as all-green).

import { Hono } from "hono";
import type pg from "pg";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type { ActorContextEnv } from "../../middleware/auth.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { verifyGithubSignature } from "../../engine/forge/intake/index.js";
import { JunitParseError, parseJunitReport } from "../../engine/ci/junit.js";
import { ingestJunitResults, type JunitRunContext } from "../../engine/ci/junitIngest.js";

export interface JunitIngestRouteDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  // The secret ref for the CI ingest HMAC signing secret — the per-run token
  // propagated as an Actions secret. UNSET ⇒ the receiver has no key to verify
  // against, so it rejects every request 401 (a LOUD refusal, never an
  // unsigned-acceptance fallback), mirroring the CI webhook receiver.
  signingSecretRef?: string;
}

// The fields the runner POSTs alongside the raw report. `runId` keys the run;
// `headSha` is the commit under test; `attempt` is the CI re-run attempt;
// `testExitCode` is the test-step outcome (the runner-crash-with-clean-XML guard).
interface JunitUploadBody {
  runId: string;
  headSha: string;
  reports: string[];
  attempt?: number;
  testExitCode?: number | null;
}

function parseUploadBody(raw: unknown): JunitUploadBody | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "body must be a JSON object" };
  const body = raw as Record<string, unknown>;
  const runId = body["runId"];
  const headSha = body["headSha"];
  const reports = body["reports"];
  if (typeof runId !== "string" || runId.length === 0) return { error: "runId is required" };
  if (typeof headSha !== "string" || headSha.length === 0) return { error: "headSha is required" };
  if (!Array.isArray(reports) || reports.length === 0 || !reports.every((r) => typeof r === "string")) {
    return { error: "reports must be a non-empty array of XML strings" };
  }
  const attemptRaw = body["attempt"];
  let attempt = 1;
  if (attemptRaw !== undefined) {
    if (typeof attemptRaw !== "number" || !Number.isInteger(attemptRaw) || attemptRaw < 1) {
      return { error: "attempt must be a positive integer" };
    }
    attempt = attemptRaw;
  }
  const exitRaw = body["testExitCode"];
  let testExitCode: number | null = null;
  if (exitRaw !== undefined && exitRaw !== null) {
    if (typeof exitRaw !== "number" || !Number.isInteger(exitRaw)) {
      return { error: "testExitCode must be an integer or null" };
    }
    testExitCode = exitRaw;
  }
  return { runId, headSha, reports: reports as string[], attempt, testExitCode };
}

/** Resolve a run's (org, project) system-scoped — the receiver has no tenant context. */
async function resolveRun(pool: pg.Pool, runId: string): Promise<JunitRunContext | undefined> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query("SELECT run_id, project_id, org_id FROM runs WHERE run_id = $1", [runId]);
    const row = result.rows[0] as { run_id: string; project_id: string; org_id: string } | undefined;
    return row === undefined ? undefined : { runId: row.run_id, projectId: row.project_id, orgId: row.org_id };
  });
}

export function createJunitIngestRoutes(deps: JunitIngestRouteDeps) {
  const app = new Hono<ActorContextEnv>();

  app.post("/webhooks/ci/junit", async (c) => {
    // Read the RAW body first — the signature is over the raw bytes.
    const rawBody = await c.req.text();

    // Mandatory signature verification — no unsigned-acceptance path. An unset
    // signing ref (no key) fails closed in verifyGithubSignature (empty secret).
    const secret = deps.signingSecretRef === undefined ? undefined : await deps.secrets.get(deps.signingSecretRef);
    const check = verifyGithubSignature({
      rawBody,
      signatureHeader: c.req.header("x-hub-signature-256"),
      secret: secret?.value ?? "",
    });
    if (!check.ok) return c.json({ error: "signature_rejected", message: check.reason }, 401);

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid_body", message: "request body was not JSON" }, 400);
    }
    const parsed = parseUploadBody(json);
    if ("error" in parsed) return c.json({ error: "invalid_body", message: parsed.error }, 400);

    const run = await resolveRun(deps.pool, parsed.runId);
    if (run === undefined) return c.json({ error: "run_not_found" }, 404);

    // Parse every uploaded report; a malformed one is a LOUD 400 (never silently
    // dropped). Merge the per-test rows across reports (multi-package runners
    // emit one file per package).
    const merged = { results: [] as ReturnType<typeof parseJunitReport>["results"], total: 0, failures: 0 };
    for (const xml of parsed.reports) {
      let report;
      try {
        report = parseJunitReport(xml);
      } catch (error) {
        if (error instanceof JunitParseError) {
          return c.json({ error: "malformed_report", message: error.message }, 400);
        }
        throw error;
      }
      merged.results.push(...report.results);
      merged.total += report.total;
      merged.failures += report.failures;
    }

    try {
      const result = await runWithOrgScope(deps.pool, run.orgId, (client) =>
        ingestJunitResults({
          client,
          run,
          report: merged,
          headSha: parsed.headSha,
          attempt: parsed.attempt ?? 1,
          testExitCode: parsed.testExitCode ?? null,
        }),
      );
      return c.json({ runId: run.runId, inserted: result.inserted, flaky: result.flaky }, 200);
    } catch (error) {
      return c.json({ error: "ingest_failed", message: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  return app;
}
