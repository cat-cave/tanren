import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { fragmentEvidenceContentDigest } from "../src/engine/templates/fragments/fragmentEvidenceContract.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueEvidenceContractRoutes } from "../src/routes/mergeQueue/evidenceContracts.js";

const ORG = "org_mq12_unit";
const PROJECT = "project_mq12_unit";
const NODE = "inode_mq12_unit";
const DIGEST = fragmentEvidenceContentDigest({
  schemaVersion: "fragment_evidence.v1",
  junitReportPath: "reports/junit.xml",
  testSelector: { path: ".tanren/test-selector.json", format: "json" },
  behaviorManifest: { path: ".tanren/behavior-manifest.json", format: "json" },
  contentDigest: `sha256:${"0".repeat(64)}`,
});
const CONTRACT = {
  reportPath: "reports/junit.xml",
  evidence: {
    schemaVersion: "fragment_evidence.v1",
    junitReportPath: "reports/junit.xml",
    testSelector: { path: ".tanren/test-selector.json", format: "json" },
    behaviorManifest: { path: ".tanren/behavior-manifest.json", format: "json" },
    contentDigest: DIGEST,
  },
};
const ACTOR: ActorContext = {
  userId: "user_mq12_unit",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface ProofUnitRow {
  readonly proof_unit_id: string;
  readonly subject_id: string;
  readonly input_hash: string;
  readonly artifact_hash: string | null;
  readonly verdict: "pass" | "fail" | "skipped";
}

class EvidenceProjectionPool {
  constructor(
    private readonly unit: ProofUnitRow | undefined,
    private readonly contracts: readonly Record<string, unknown>[],
    private readonly projectOrg: string | null = ORG,
  ) {}

  async connect() {
    let scopedOrg: string | undefined;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        const text = sql.replaceAll(/\s+/gu, " ").trim();
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return rows([]);
        if (text.startsWith("SET LOCAL app.current_org_id")) {
          scopedOrg = text.match(/= '([^']+)'$/u)?.[1];
          return rows([]);
        }
        if (text === "SELECT org_id FROM projects WHERE project_id = $1") {
          return this.projectOrg === null ? rows([]) : rows([{ org_id: this.projectOrg }]);
        }
        if (text.startsWith("SELECT role FROM project_members")) return rows([]);
        if (text.includes("FROM integration_proof_units")) {
          const visible = scopedOrg === ORG && params[0] === ORG && params[1] === PROJECT && params[2] === NODE;
          return visible && this.unit !== undefined ? rows([this.unit]) : rows([]);
        }
        if (text.includes("FROM fragments")) {
          const visible = scopedOrg === ORG && params[0] === ORG && params[1] === DIGEST;
          return visible ? rows(this.contracts.map((contract) => ({ contract }))) : rows([]);
        }
        throw new Error(`unexpected query: ${text}`);
      },
      release() {},
    } as never;
  }

  asPgPool(): pg.Pool {
    return this as never;
  }
}

function rows(values: readonly Record<string, unknown>[]) {
  return { rows: [...values], rowCount: values.length };
}

function selectedUnit(): ProofUnitRow {
  return {
    proof_unit_id: "proof_unit_mq12",
    subject_id: "fragment_evidence:selected",
    input_hash: DIGEST,
    artifact_hash: DIGEST,
    verdict: "pass",
  };
}

function appFor(pool: EvidenceProjectionPool, actor: ActorContext = ACTOR): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/orgs", createMergeQueueEvidenceContractRoutes({ pool: pool.asPgPool() }));
  return app;
}

function endpoint(orgId = ORG, projectId = PROJECT, nodeId = NODE): string {
  return `/orgs/${orgId}/projects/${projectId}/merge-queue/evidence-contracts/${nodeId}`;
}

describe("mq-12 evidence contract route", () => {
  it("projects only the frozen declarative contract for an exact selected artifact", async () => {
    const response = await appFor(new EvidenceProjectionPool(selectedUnit(), [CONTRACT])).request(endpoint());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      resolutionStatus: "selected",
      contract: { contentDigest: DIGEST, junitReportPath: "reports/junit.xml" },
      proofUnit: { id: "proof_unit_mq12", artifactDigest: DIGEST, verdict: "pass" },
      fallback: null,
    });
    expect(JSON.stringify(body)).not.toContain("body_ts");
  });

  it("reports a durable full-gate fallback rather than inventing a selected contract", async () => {
    const response = await appFor(
      new EvidenceProjectionPool(
        {
          ...selectedUnit(),
          subject_id: "fragment_evidence:fallback:selector_set_mismatch",
          artifact_hash: null,
          verdict: "fail",
        },
        [],
      ),
    ).request(endpoint());

    expect(await response.json()).toMatchObject({
      resolutionStatus: "full_gate_fallback",
      contract: null,
      fallback: "selector_set_mismatch",
      proofUnit: { verdict: "fail", artifactDigest: null },
    });
  });

  it("fails closed for an unobserved node or a selected digest lacking one valid frozen contract", async () => {
    const unobserved = await appFor(new EvidenceProjectionPool(undefined, [])).request(endpoint());
    expect(await unobserved.json()).toMatchObject({
      resolutionStatus: "unavailable",
      contract: null,
      proofUnit: null,
      fallback: "unobserved",
    });

    const ambiguous = await appFor(new EvidenceProjectionPool(selectedUnit(), [CONTRACT, CONTRACT])).request(
      endpoint(),
    );
    expect(await ambiguous.json()).toMatchObject({
      resolutionStatus: "selected_contract_unavailable",
      contract: null,
      fallback: null,
    });
  });

  it("never exposes another org or a project outside the addressed org", async () => {
    const pool = new EvidenceProjectionPool(selectedUnit(), [CONTRACT], "org_someone_else");
    const crossOrg = await appFor(pool).request(endpoint("org_other"));
    const mismatchedProject = await appFor(pool).request(endpoint());

    expect(crossOrg.status).toBe(404);
    expect(mismatchedProject.status).toBe(404);
  });
});
