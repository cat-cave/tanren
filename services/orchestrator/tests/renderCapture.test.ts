// rv-9 render/response capture — content-addressed verification-artifact store.
// Part A proves the store in isolation (content-addressing, dedupe, and
// fail-closed on every digest disagreement). Part B drives the REAL
// AcceptanceOrchestrator through the REAL HttpAcceptanceSurfaceDriver against a
// REAL node:http server and proves the run content-addresses its response
// capture into the store, addressed by the digest of the deterministic bytes.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  contentDigestOf,
  parseDigest,
  type CasArtifactBytes,
  type CasArtifactRef,
  type CasByteStore,
  type Digest,
} from "../src/engine/contracts/cas.js";
import type { ExecutionMatrix } from "../src/engine/contracts/runtimeVerificationPlan.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  AcceptanceOrchestrator,
  CaptureDigestMismatchError,
  HttpAcceptanceSurfaceDriver,
  PgVerificationCaptureStore,
  captureArtifactId,
  recordAttemptedVerdictSequential,
  type AcceptanceBaseUrlResolver,
  type AcceptanceDriveInput,
  type AcceptanceEventSink,
  type AcceptancePlan,
  type AcceptanceRunStore,
  type CompleteAcceptanceRunInput,
  type EnsureVerificationPlanInput,
  type RecordAcceptanceRunInput,
  type RecordAcceptanceVerdictInput,
  type RecordAttemptInput,
  type RecordAttemptedVerdictInput,
  type RecordAttemptedVerdictResult,
  type StoredAcceptanceVerdict,
} from "../src/engine/verification/acceptance/index.js";

const ARTIFACT = `sha256:${"a".repeat(64)}` as Digest;
const ORG = "org_rv9";
const PROJECT = "project_rv9";

/** In-memory CAS byte store that dedupes by digest and verifies integrity on read. */
class InMemoryCas implements CasByteStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  /** Optional override: force put() to return a digest that disagrees with the content. */
  public liar?: Digest;

  public put(input: { orgId: string; bytes: Uint8Array; mediaType: string }): Promise<CasArtifactRef> {
    if (this.liar !== undefined)
      return Promise.resolve({ digest: this.liar, byteSize: input.bytes.byteLength, mediaType: input.mediaType });
    const digest = contentDigestOf(input.bytes);
    const key = `${input.orgId}\n${digest}`;
    if (!this.blobs.has(key)) this.blobs.set(key, { bytes: new Uint8Array(input.bytes), mediaType: input.mediaType });
    return Promise.resolve({ digest, byteSize: input.bytes.byteLength, mediaType: input.mediaType });
  }
  public get(orgId: string, digest: Digest): Promise<CasArtifactBytes> {
    const stored = this.blobs.get(`${orgId}\n${digest}`);
    if (stored === undefined) throw new Error(`cas miss ${orgId} ${digest}`);
    // Integrity: a tampered blob whose bytes no longer hash to the digest fails closed.
    if (contentDigestOf(stored.bytes) !== digest) throw new Error(`cas integrity ${digest}`);
    return Promise.resolve({ digest, bytes: new Uint8Array(stored.bytes), mediaType: stored.mediaType });
  }
  public has(orgId: string, digest: Digest): Promise<boolean> {
    return Promise.resolve(this.blobs.has(`${orgId}\n${digest}`));
  }
  /** Test-only corruption to prove the read integrity gate. */
  public corrupt(orgId: string, digest: Digest): void {
    this.blobs.set(`${orgId}\n${digest}`, { bytes: new TextEncoder().encode("tampered"), mediaType: "x" });
  }
}

interface FakeRow {
  id: string;
  cas_digest: string;
  media_type: string;
  byte_size: number;
  kind: string;
  redaction_class: string;
  retention_class: string;
  producing_attempt_id: string | null;
}

/** Minimal in-memory `verification_artifacts` table honoring the store's 3 statements. */
class FakeDb {
  public readonly rows = new Map<string, FakeRow>();
  public readonly withOrgScope = async <T>(
    orgId: string,
    op: (client: Pick<pg.PoolClient, "query">) => Promise<T>,
  ): Promise<T> => {
    const client = {
      query: (
        text: string,
        params: readonly unknown[] = [],
      ): Promise<{ rows: readonly unknown[]; rowCount: number }> => {
        if (text.includes("FROM projects")) return Promise.resolve({ rows: [], rowCount: 1 });
        if (text.startsWith("INSERT INTO verification_artifacts")) {
          const key = `${String(params[0])}\n${String(params[1])}`;
          const attempt = params[9] === null || params[9] === undefined ? null : String(params[9]);
          const existing = this.rows.get(key);
          if (existing !== undefined) {
            // rv-10 FINDING 3: ON CONFLICT DO UPDATE COALESCE — backfill only a NULL producing
            // attempt; `xmax != 0` (a conflict-update) reports `inserted = false`.
            if (existing.producing_attempt_id === null && attempt !== null) existing.producing_attempt_id = attempt;
            return Promise.resolve({ rows: [{ inserted: false }], rowCount: 1 });
          }
          this.rows.set(key, {
            id: String(params[1]),
            cas_digest: String(params[3]),
            kind: String(params[4]),
            media_type: String(params[5]),
            byte_size: Number(params[6]),
            redaction_class: String(params[7]),
            retention_class: String(params[8]),
            producing_attempt_id: attempt,
          });
          return Promise.resolve({ rows: [{ inserted: true }], rowCount: 1 });
        }
        if (text.includes("FROM verification_artifacts")) {
          const row = this.rows.get(`${String(params[0])}\n${String(params[1])}`);
          return Promise.resolve(row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 });
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    return op(client);
  };
}

function makeStore(cas: InMemoryCas, db: FakeDb): PgVerificationCaptureStore {
  return new PgVerificationCaptureStore({} as unknown as pg.Pool, cas, { withOrgScope: db.withOrgScope });
}

describe("rv-9 PgVerificationCaptureStore — content-addressed, fail-closed", () => {
  it("addresses a capture by the digest of its bytes and records one provenance row", async () => {
    const cas = new InMemoryCas();
    const db = new FakeDb();
    const bytes = new TextEncoder().encode("hello capture");
    const stored = await makeStore(cas, db).capture({
      orgId: ORG,
      projectId: PROJECT,
      kind: "response_capture",
      mediaType: "application/json",
      bytes,
      redactionClass: "sensitive",
    });
    expect(stored.casDigest).toBe(contentDigestOf(bytes));
    expect(stored.verificationArtifactId).toBe(captureArtifactId(PROJECT, contentDigestOf(bytes), "response_capture"));
    expect(stored.deduped).toBe(false);
    expect(db.rows.size).toBe(1);
  });

  it("dedupes identical content of the same kind onto ONE address", async () => {
    const cas = new InMemoryCas();
    const db = new FakeDb();
    const store = makeStore(cas, db);
    const bytes = new TextEncoder().encode("same bytes");
    const first = await store.capture({
      orgId: ORG,
      projectId: PROJECT,
      kind: "response_capture",
      mediaType: "application/json",
      bytes,
      redactionClass: "none",
    });
    const second = await store.capture({
      orgId: ORG,
      projectId: PROJECT,
      kind: "response_capture",
      mediaType: "application/json",
      bytes: new Uint8Array(bytes),
      redactionClass: "none",
    });
    expect(second.verificationArtifactId).toBe(first.verificationArtifactId);
    expect(second.casDigest).toBe(first.casDigest);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(db.rows.size).toBe(1);
  });

  it("FAIL-CLOSED: a caller-claimed digest that does not match the bytes throws", async () => {
    const store = makeStore(new InMemoryCas(), new FakeDb());
    const bytes = new TextEncoder().encode("real bytes");
    const wrong = parseDigest(`sha256:${"b".repeat(64)}`);
    await expect(
      store.capture({
        orgId: ORG,
        projectId: PROJECT,
        kind: "response_capture",
        mediaType: "application/json",
        bytes,
        redactionClass: "none",
        expectedDigest: wrong,
      }),
    ).rejects.toBeInstanceOf(CaptureDigestMismatchError);
  });

  it("FAIL-CLOSED: a CAS that returns a digest disagreeing with the content throws", async () => {
    const cas = new InMemoryCas();
    cas.liar = parseDigest(`sha256:${"c".repeat(64)}`);
    const store = makeStore(cas, new FakeDb());
    await expect(
      store.capture({
        orgId: ORG,
        projectId: PROJECT,
        kind: "response_capture",
        mediaType: "application/json",
        bytes: new TextEncoder().encode("x"),
        redactionClass: "none",
      }),
    ).rejects.toBeInstanceOf(CaptureDigestMismatchError);
  });

  it("reads back verified bytes and FAILS CLOSED when the stored blob is tampered", async () => {
    const cas = new InMemoryCas();
    const db = new FakeDb();
    const store = makeStore(cas, db);
    const bytes = new TextEncoder().encode("payload to read back");
    const stored = await store.capture({
      orgId: ORG,
      projectId: PROJECT,
      kind: "response_capture",
      mediaType: "application/json",
      bytes,
      redactionClass: "none",
    });
    const read = await store.read({ orgId: ORG, verificationArtifactId: stored.verificationArtifactId });
    expect(read.bytes).toEqual(bytes);
    cas.corrupt(ORG, stored.casDigest);
    await expect(store.read({ orgId: ORG, verificationArtifactId: stored.verificationArtifactId })).rejects.toThrow(
      /cas integrity/u,
    );
  });
});

// ---- Part B: the REAL acceptance run captures its response, addressed by digest ----

const MATRIX: ExecutionMatrix = {
  browser: [],
  viewport: [],
  locale: [],
  theme: [],
  motion: [],
  contrast: [],
  device: [],
};

class NoopStore implements AcceptanceRunStore {
  public recordRun(_input: RecordAcceptanceRunInput): Promise<string> {
    return Promise.resolve("run_1");
  }
  public completeRun(_input: CompleteAcceptanceRunInput): Promise<void> {
    return Promise.resolve();
  }
  public ensureVerificationPlan(input: EnsureVerificationPlanInput): Promise<string> {
    return Promise.resolve(input.planId);
  }
  public recordAttempt(_input: RecordAttemptInput): Promise<string> {
    return Promise.resolve("attempt_1");
  }
  public recordVerdict(_input: RecordAcceptanceVerdictInput): Promise<string> {
    return Promise.resolve("verdict_1");
  }
  public recordAttemptedVerdict(input: RecordAttemptedVerdictInput): Promise<RecordAttemptedVerdictResult> {
    return recordAttemptedVerdictSequential(this, input);
  }
  public listVerdicts(): Promise<readonly StoredAcceptanceVerdict[]> {
    return Promise.resolve([]);
  }
}
class NoopEvents implements AcceptanceEventSink {
  public append<N extends EventName>(_input: AppendEventInput<N>): Promise<void> {
    return Promise.resolve();
  }
}
function fixedResolver(baseUrl: string): AcceptanceBaseUrlResolver {
  return { resolve: (_input: AcceptanceDriveInput) => Promise.resolve({ kind: "resolved" as const, baseUrl }) };
}
function healthPlan(): AcceptancePlan {
  return {
    planId: "plan_rv9",
    behaviorRevisionId: "br_rv9",
    requiredSurfaces: ["api"],
    assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
    httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  };
}
function expectedCaptureDigest(healthBody: string): Digest {
  const bytes = new TextEncoder().encode(
    canonicalJson({ probes: [{ probeId: "p1", method: "GET", path: "/health", status: 200, body: healthBody }] }),
  );
  return contentDigestOf(bytes);
}

describe("rv-9 render-capture wired into the REAL acceptance run", () => {
  let server: Server;
  let baseUrl: string;
  const healthBody = JSON.stringify({ status: "ok", count: 3 });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(healthBody);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("captures the real response, content-addresses it, and threads the EvidenceLinkRef", async () => {
    const cas = new InMemoryCas();
    const db = new FakeDb();
    const orchestrator = new AcceptanceOrchestrator({
      store: new NoopStore(),
      events: new NoopEvents(),
      drivers: [new HttpAcceptanceSurfaceDriver({ surface: "api", resolveBaseUrl: fixedResolver(baseUrl) })],
      renderCapture: makeStore(cas, db),
    });
    const req = {
      orgId: ORG,
      projectId: PROJECT,
      integrationNodeId: "inode_1",
      environmentId: "env_1",
      preparedHeadSha: "abc",
      jjTreeId: "tree",
      artifactDigest: ARTIFACT,
      deploymentFingerprint: "fp",
      plans: [healthPlan()],
    };
    const result = await orchestrator.execute(req);
    const behavior = result.behaviors[0]!;
    expect(behavior.outcome).toBe("passed");
    expect(behavior.evidenceLinkRefs).toHaveLength(1);
    // The captured artifact's ADDRESS is the digest of the deterministic capture bytes.
    expect(behavior.evidenceLinkRefs[0]!.casDigest).toBe(expectedCaptureDigest(healthBody));
    expect(db.rows.size).toBe(1);
    const stored = await cas.get(ORG, behavior.evidenceLinkRefs[0]!.casDigest);
    expect(new TextDecoder().decode(stored.bytes)).toContain(`"status":200`);

    // A second identical run dedupes onto the same address — no duplicate row.
    const again = await orchestrator.execute(req);
    expect(again.behaviors[0]!.evidenceLinkRefs[0]!.casDigest).toBe(behavior.evidenceLinkRefs[0]!.casDigest);
    expect(db.rows.size).toBe(1);
  });
});

// ---- FINDING 2 write path: the verdict recorded onto the ledger carries the capture links ----

/** Records every verdict input so a test can assert what reached the durable ledger. */
class RecordingStore implements AcceptanceRunStore {
  public readonly verdicts: RecordAcceptanceVerdictInput[] = [];
  public recordRun(_input: RecordAcceptanceRunInput): Promise<string> {
    return Promise.resolve("run_1");
  }
  public completeRun(_input: CompleteAcceptanceRunInput): Promise<void> {
    return Promise.resolve();
  }
  public ensureVerificationPlan(input: EnsureVerificationPlanInput): Promise<string> {
    return Promise.resolve(input.planId);
  }
  public recordAttempt(_input: RecordAttemptInput): Promise<string> {
    return Promise.resolve("attempt_1");
  }
  public recordVerdict(input: RecordAcceptanceVerdictInput): Promise<string> {
    this.verdicts.push(input);
    return Promise.resolve("verdict_1");
  }
  public recordAttemptedVerdict(input: RecordAttemptedVerdictInput): Promise<RecordAttemptedVerdictResult> {
    return recordAttemptedVerdictSequential(this, input);
  }
  public listVerdicts(): Promise<readonly StoredAcceptanceVerdict[]> {
    return Promise.resolve([]);
  }
}

describe("rv-9 durable linkage: captures are threaded onto the recorded verdict (FINDING 2)", () => {
  let server: Server;
  let baseUrl: string;
  const healthBody = JSON.stringify({ status: "ok", count: 7 });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(healthBody);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function makeRequest() {
    return {
      orgId: ORG,
      projectId: PROJECT,
      integrationNodeId: "inode_1",
      environmentId: "env_1",
      preparedHeadSha: "abc",
      jjTreeId: "tree",
      artifactDigest: ARTIFACT,
      deploymentFingerprint: "fp",
      plans: [healthPlan()],
    };
  }

  it("with renderCapture: recordVerdict receives the content-addressed capture link", async () => {
    const store = new RecordingStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NoopEvents(),
      drivers: [new HttpAcceptanceSurfaceDriver({ surface: "api", resolveBaseUrl: fixedResolver(baseUrl) })],
      renderCapture: makeStore(new InMemoryCas(), new FakeDb()),
    });
    await orchestrator.execute(makeRequest());
    const links = store.verdicts[0]!.evidenceLinks!;
    expect(links).toHaveLength(1);
    expect(links[0]!.casDigest).toBe(expectedCaptureDigest(healthBody));
    expect(links[0]!.verificationArtifactId).toBe(
      captureArtifactId(PROJECT, expectedCaptureDigest(healthBody), "response_capture"),
    );
  });

  it("without renderCapture: the recorded verdict carries no evidence links (never a partial write)", async () => {
    const store = new RecordingStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new NoopEvents(),
      drivers: [new HttpAcceptanceSurfaceDriver({ surface: "api", resolveBaseUrl: fixedResolver(baseUrl) })],
    });
    const result = await orchestrator.execute(makeRequest());
    expect(result.behaviors[0]!.evidenceLinkRefs).toHaveLength(0);
    expect(store.verdicts[0]!.evidenceLinks).toBeUndefined();
  });
});
