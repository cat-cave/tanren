// CI-intelligence ingestion (foundation): the `/webhooks/ci/junit` route. Proves
// the runner-push (1) is mandatorily signature-authed, (2) resolves its run's org
// system-scoped then writes per-test rows + emits `ci.tests.reported` UNDER that
// org scope, and (3) LOUDLY rejects a malformed report (400) rather than silently
// accepting it. Uses a recording fake pool (no live Postgres) and the in-memory
// secret store; the org/system scope helpers run against the passed pool because
// the test clears the system pool override.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { setSystemPool } from "@tanren/db";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { createJunitIngestRoutes } from "../src/routes/githubWebhooks/index.js";

const SIGNING_SECRET = "ci-ingest-signing-secret";
const SECRET_REF = "credential/ci-webhook/signing";
const RUN = { run_id: "run_1", project_id: "proj_1", org_id: "org_1" };

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", SIGNING_SECRET).update(payload, "utf8").digest("hex")}`;
}

interface RecordedQuery {
  text: string;
  values: unknown[];
}

// A recording fake: connect() yields a client that records every query. The run
// SELECT returns the seeded run row; ci_test_results INSERT + the events INSERT +
// transaction control / NOTIFY are recorded and return empty.
class RecordingPool {
  readonly queries: RecordedQuery[] = [];
  runExists = true;

  async connect(): Promise<unknown> {
    const queries = this.queries;
    return {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (text.startsWith("SELECT run_id")) {
          return { rows: this.runExists ? [RUN] : [], rowCount: this.runExists ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }

  asPgPool() {
    return this as never;
  }
}

// `ref` defaults to SECRET_REF; pass `null` to configure NO signing ref.
function buildApp(pool: RecordingPool, secrets: FakeSecretStore, ref: string | null = SECRET_REF) {
  return createJunitIngestRoutes({
    pool: pool.asPgPool(),
    secrets,
    ...(ref === null ? {} : { signingSecretRef: ref }),
  });
}

const REPORT = `<testsuites><testsuite name="s">
  <testcase classname="a" name="b" time="0.01" file="a.test.ts"/>
  <testcase classname="a" name="c" time="0.02"><failure>nope</failure></testcase>
  <testcase classname="a" name="d" time="0.03"><flakyFailure>retry</flakyFailure></testcase>
</testsuite></testsuites>`;

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: "run_1",
    headSha: "abc123",
    attempt: 2,
    testExitCode: 1,
    reports: [REPORT],
    ...overrides,
  });
}

// `sig` is the signature header. Pass `null` to OMIT it entirely; omit the arg
// to sign correctly. (A default param fires on `undefined`, so `null` is the
// explicit "no header" sentinel.)
async function post(app: ReturnType<typeof buildApp>, raw: string, sig: string | null = sign(raw)) {
  return app.request("/webhooks/ci/junit", {
    method: "POST",
    headers: { "content-type": "application/json", ...(sig === null ? {} : { "x-hub-signature-256": sig }) },
    body: raw,
  });
}

describe("/webhooks/ci/junit ingest route", () => {
  let secrets: FakeSecretStore;
  let pool: RecordingPool;

  beforeEach(async () => {
    // system-scope helper runs against the passed pool
    setSystemPool(undefined);
    secrets = new FakeSecretStore();
    await secrets.put({ ref: SECRET_REF, value: SIGNING_SECRET });
    pool = new RecordingPool();
  });
  afterEach(() => setSystemPool(undefined));

  it("persists per-test rows + emits ci.tests.reported under the run's org scope", async () => {
    const app = buildApp(pool, secrets);
    const raw = body();
    const res = await post(app, raw);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId: "run_1", inserted: 3, flaky: 1 });

    // Org scope was established (SET LOCAL app.current_org_id = 'org_1').
    expect(pool.queries.some((q) => q.text.includes("SET LOCAL app.current_org_id = 'org_1'"))).toBe(true);

    // One ci_test_results INSERT per testcase, carrying org_id + head_sha + attempt.
    const inserts = pool.queries.filter((q) => q.text.includes("INSERT INTO ci_test_results"));
    expect(inserts).toHaveLength(3);
    expect(inserts[0]?.values).toContain("org_1");
    expect(inserts[0]?.values).toContain("abc123");
    expect(inserts[0]?.values).toContain(2);

    // The ci.tests.reported event was appended through the event store with the
    // summary payload (matched by the event-type value, not the raw SQL text).
    const eventInsert = pool.queries.find((q) => (q.values as unknown[]).includes("ci.tests.reported"));
    expect(eventInsert).toBeDefined();
    const payload = JSON.parse(eventInsert?.values?.[5] as string);
    expect(payload).toMatchObject({ headSha: "abc123", attempt: 2, total: 3, failures: 1, flaky: 1, testExitCode: 1 });
  });

  it("rejects a missing signature 401 (no unauthenticated ingest)", async () => {
    const app = buildApp(pool, secrets);
    const res = await post(app, body(), null);
    expect(res.status).toBe(401);
    expect(pool.queries.some((q) => q.text.startsWith("SELECT run_id"))).toBe(false);
  });

  it("rejects 401 when no signing ref is configured (fails closed)", async () => {
    const app = buildApp(pool, secrets, null);
    const res = await post(app, body());
    expect(res.status).toBe(401);
  });

  it("LOUDLY rejects a malformed report with 400 (no silent accept)", async () => {
    const app = buildApp(pool, secrets);
    const raw = body({ reports: ["<testsuites><testsuite name=s></testsuites>"] });
    const res = await post(app, raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "malformed_report" });
    // Nothing was written.
    expect(pool.queries.some((q) => q.text.includes("INSERT INTO ci_test_results"))).toBe(false);
  });

  it("404s when the run is unknown", async () => {
    pool.runExists = false;
    const app = buildApp(pool, secrets);
    const res = await post(app, body());
    expect(res.status).toBe(404);
  });

  it("rejects a body missing runId with 400", async () => {
    const app = buildApp(pool, secrets);
    const raw = JSON.stringify({ headSha: "x", reports: [REPORT] });
    const res = await post(app, raw);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
  });

  it("never echoes the signing secret in a rejection body", async () => {
    const app = buildApp(pool, secrets);
    const res = await post(app, body(), "sha256=deadbeef");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SIGNING_SECRET);
  });
});
