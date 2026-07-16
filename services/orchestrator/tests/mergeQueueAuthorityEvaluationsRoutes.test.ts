// cspell:ignore mqeval mqgrp
import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { MergeSignalClassificationV1 } from "../src/engine/merge/authoritySignalClassification.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueAuthorityEvaluationRoutes } from "../src/routes/mergeQueue/authorityEvaluations.js";
import {
  decisionEvaluationId,
  EvaluationProjectionPool,
  MQ2_ROUTE_PROJECT,
  nodeGroupId,
  quarantineVersion,
  validBatchNode,
  validBatchProof,
  validDecision,
  validQuarantine,
} from "./helpers/mq2BatchAuthority.js";

const ORG = "org_acme";
const PROJECT = MQ2_ROUTE_PROJECT;
const W0_EVALUATION = `mqeval_${"a".repeat(64)}`;
const W0_GROUP = `mqgrp_${"b".repeat(64)}`;

const alice: ActorContext = {
  userId: "user_alice",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function policySignal(): MergeSignalClassificationV1 {
  return {
    missionNodeId: "mq-1",
    evaluationId: W0_EVALUATION,
    groupId: W0_GROUP,
    signalVersion: "merge_signal.v1",
    memberIds: ["B"],
    findingIds: ["finding-b"],
    classification: "deterministic_policy",
    reasonCode: "audit_policy",
    retryability: "non_retryable",
    wakeKey: null,
    disposition: "member_repair",
  };
}

function buildApp(pool: pg.Pool, actor: ActorContext = alice) {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/orgs", createMergeQueueAuthorityEvaluationRoutes({ pool }));
  return app;
}

function listEndpoint(limit = 20): string {
  return `/orgs/${ORG}/projects/${PROJECT}/merge-queue/authority-evaluations?limit=${limit}`;
}

function detailEndpoint(evaluationId: string): string {
  return `/orgs/${ORG}/projects/${PROJECT}/merge-queue/authority-evaluations/${evaluationId}`;
}

describe("mq-2 authority-evaluation HTTP projection", () => {
  it("projects an exact persisted node + passing proof + matching decision as all-admit", async () => {
    const decision = validDecision();
    const pool = new EvaluationProjectionPool(ORG, [], [decision]);
    const response = await buildApp(pool.asPgPool()).request(listEndpoint());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { latestEvaluationId: string; evaluations: Array<Record<string, unknown>> };
    expect(body.latestEvaluationId).toBe(decisionEvaluationId(decision));
    expect(body.evaluations).toHaveLength(1);
    expect(body.evaluations[0]).toMatchObject({
      evaluationId: decisionEvaluationId(decision),
      kind: "authorized_subset",
      source: "authority_decision",
      sourceId: decision.decision_id,
      nodeId: "inode_batch",
      memberSetHash: decision.member_key,
      proofReuseKey: decision.proof_reuse_key,
      findingIds: [],
      reasonCodes: [],
      eligibleMemberIds: ["A", "B"],
      members: [
        { ordinal: 0, specId: "A", runId: "run-a", disposition: "admit" },
        { ordinal: 1, specId: "B", runId: "run-b", disposition: "admit" },
      ],
    });

    const detail = await buildApp(pool.asPgPool()).request(detailEndpoint(decisionEvaluationId(decision)));
    expect(detail.status).toBe(200);
    expect((await detail.json()) as object).toMatchObject({ evaluation: { kind: "authorized_subset" } });
  });

  it("never projects green when any exact decision binding component is stale", async () => {
    const valid = validDecision();
    const staleRows = [
      validDecision({ artifact_digest: `sha256:${"f".repeat(64)}` }),
      validDecision({ proof_evidence: { ...(valid.proof_evidence as object), treeHash: "tree-stale" } }),
    ];
    for (const stale of staleRows) {
      const response = await buildApp(new EvaluationProjectionPool(ORG, [], [stale]).asPgPool()).request(
        listEndpoint(),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ latestEvaluationId: null, evaluations: [] });
    }
  });

  it("projects an exact failed multi-member proof as a no-blame interaction failure on list and detail", async () => {
    const proof = validBatchProof({ verdict: "failed" });
    const pool = new EvaluationProjectionPool(ORG, [], [], [proof]);
    const response = await buildApp(pool.asPgPool()).request(listEndpoint());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      latestEvaluationId: string;
      evaluations: Array<{ evaluationId: string; kind: string; members: Array<{ disposition: string }> }>;
    };
    expect(body.evaluations).toHaveLength(1);
    expect(body.evaluations[0]).toMatchObject({
      kind: "interaction_failure",
      source: "batch_gate",
      sourceId: proof.proof_id,
      nodeId: proof.node_id,
      memberSetHash: proof.member_key,
      proofReuseKey: proof.proof_reuse_key,
      eligibleMemberIds: [],
      reasonCodes: ["integrated_gate_failure_under_bisect"],
    });
    expect(body.evaluations[0]?.members).toHaveLength(3);
    expect(body.evaluations[0]?.members.every((member) => member.disposition === "hold")).toBe(true);

    const detail = await buildApp(pool.asPgPool()).request(detailEndpoint(body.latestEvaluationId));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ evaluation: { kind: "interaction_failure" } });
  });

  it("projects flake only from an exact passing proof and exact active same-head quarantine epoch", async () => {
    const quarantine = validQuarantine();
    const proof = validBatchProof({ verdict: "passed", quarantineVersion: quarantineVersion([quarantine]) });
    const response = await buildApp(
      new EvaluationProjectionPool(ORG, [], [], [proof], [], [], [quarantine]).asPgPool(),
    ).request(listEndpoint());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { evaluations: Array<Record<string, unknown>> };
    expect(body.evaluations).toHaveLength(1);
    expect(body.evaluations[0]).toMatchObject({
      kind: "flake_observation",
      source: "quarantine",
      sourceId: quarantine.id,
      nodeId: proof.node_id,
      proofReuseKey: proof.proof_reuse_key,
      eligibleMemberIds: [],
      reasonCodes: ["same_tree_nondeterminism"],
    });
  });

  it("fails closed for wrong proof, tree, quarantine epoch, or member binding", async () => {
    const quarantine = validQuarantine();
    const wrongProof = validBatchProof({
      verdict: "failed",
      mutateEvidence: (evidence) => ({ ...evidence, proofReuseKey: "f".repeat(64) }),
    });
    const wrongTree = validBatchProof({
      verdict: "failed",
      mutateEvidence: (evidence) => ({ ...evidence, treeHash: "tree-other" }),
    });
    const wrongMember = validBatchProof({
      verdict: "failed",
      mutateEvidence: (evidence) => ({ ...evidence, memberSetHash: "e".repeat(64) }),
    });
    for (const proof of [wrongProof, wrongTree, wrongMember]) {
      const response = await buildApp(new EvaluationProjectionPool(ORG, [], [], [proof]).asPgPool()).request(
        listEndpoint(),
      );
      const body = (await response.json()) as { evaluations: Array<{ kind: string; reasonCodes: string[] }> };
      expect(body.evaluations).toEqual([
        expect.objectContaining({
          kind: "unknown_fail_closed",
          reasonCodes: ["incomplete_batch_gate_evidence"],
        }),
      ]);
    }

    const staleEpoch = validBatchProof({
      verdict: "passed",
      quarantineVersion: `active_quarantine.v1:${"d".repeat(64)}`,
    });
    const response = await buildApp(
      new EvaluationProjectionPool(ORG, [], [], [staleEpoch], [], [], [quarantine]).asPgPool(),
    ).request(listEndpoint());
    expect(await response.json()).toEqual({ latestEvaluationId: null, evaluations: [] });
  });

  it("reconstructs ordered W0 survivors and transitive holds from the exact group-bound spec DAG", async () => {
    const node = validBatchNode();
    const signal = { ...policySignal(), groupId: nodeGroupId(node) };
    const pool = new EvaluationProjectionPool(
      ORG,
      [{ id: "42", orgId: ORG, projectId: PROJECT, ts: new Date("2026-07-15T12:00:00.000Z"), payload: signal }],
      [],
      [],
      [node],
      [
        { spec_id: "A", depends_on: [] },
        { spec_id: "B", depends_on: [] },
        { spec_id: "C", depends_on: ["B"] },
      ],
    );
    const response = await buildApp(pool.asPgPool()).request(listEndpoint());
    const body = (await response.json()) as { evaluations: Array<Record<string, unknown>> };

    expect(body.evaluations).toEqual([
      expect.objectContaining({
        kind: "member_failure",
        nodeId: node.node_id,
        memberSetHash: node.member_key,
        proofReuseKey: null,
        eligibleMemberIds: ["A"],
        members: [
          expect.objectContaining({ ordinal: 0, specId: "A", runId: "run-a", disposition: "admit" }),
          expect.objectContaining({ ordinal: 1, specId: "B", runId: "run-b", disposition: "exclude" }),
          expect.objectContaining({ ordinal: 2, specId: "C", runId: "run-c", disposition: "hold" }),
        ],
      }),
    ]);
  });

  it("maps W0 member policy without fabricating a per-member finding map", async () => {
    const pool = new EvaluationProjectionPool(
      ORG,
      [{ id: "41", orgId: ORG, projectId: PROJECT, ts: new Date("2026-07-15T12:00:00.000Z"), payload: policySignal() }],
      [],
    );
    const response = await buildApp(pool.asPgPool()).request(listEndpoint());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      latestEvaluationId: W0_EVALUATION,
      evaluations: [
        {
          evaluationId: W0_EVALUATION,
          groupId: W0_GROUP,
          kind: "member_failure",
          observedAt: "2026-07-15T12:00:00.000Z",
          source: "merge.signal.classified",
          sourceId: "41",
          nodeId: null,
          memberSetHash: null,
          proofReuseKey: null,
          members: [
            {
              ordinal: 0,
              specId: "B",
              runId: null,
              branch: null,
              headSha: null,
              disposition: "exclude",
              findingIds: [],
              reasonCodes: ["audit_policy"],
            },
          ],
          findingIds: ["finding-b"],
          reasonCodes: ["audit_policy"],
          eligibleMemberIds: [],
        },
      ],
    });
  });

  it("returns unknown-by-absence, rejects invalid limits, and conceals cross-org detail", async () => {
    const pool = new EvaluationProjectionPool(ORG, [], []);
    const empty = await buildApp(pool.asPgPool()).request(listEndpoint());
    const invalid = await buildApp(pool.asPgPool()).request(listEndpoint(101));
    const crossOrg = await buildApp(pool.asPgPool(), { ...alice, orgId: "org_other" }).request(
      detailEndpoint(W0_EVALUATION),
    );
    const missing = await buildApp(pool.asPgPool()).request(detailEndpoint(W0_EVALUATION));

    expect(await empty.json()).toEqual({ latestEvaluationId: null, evaluations: [] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_limit", min: 1, max: 100 });
    expect(crossOrg.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await crossOrg.json()).toEqual({ error: "merge_queue_evaluation_not_found" });
    expect(await missing.json()).toEqual({ error: "merge_queue_evaluation_not_found" });
  });

  it("does not reveal a project whose scoped org does not match", async () => {
    const pool = new EvaluationProjectionPool("org_other", [], [validDecision()]);
    const response = await buildApp(pool.asPgPool()).request(listEndpoint());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "merge_queue_evaluations_not_found" });
    expect(pool.projectionQueries).toEqual([]);
  });
});
