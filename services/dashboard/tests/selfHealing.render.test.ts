// cspell:ignore rproof
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_healing",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};
const PROJECT = {
  projectId: "project_healing",
  name: "healing fixture",
  repoUrl: "https://example.com/healing.git",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};
const LOOP_ID = "iloop_cosmetic";

// A COSMETIC fix: merged + deployed + reachable are green, but the production
// symptom re-verification FAILED and the resolution is blocked — the badges must
// stay split (demo green, symptom red), never collapsed into one green.
const COSMETIC_BADGES = {
  gate: "passed",
  merged: "passed",
  deploy: "bound",
  demo: "reachable",
  symptom: "failed",
  source: "absent",
};

function funnelResponse() {
  return {
    version: "v1",
    orgId: ORG.id,
    funnel: {
      counts: { opened: 3, reproduced: 2, fixed: 2, merged: 1, deployed: 1, symptom_verified: 0, source_closed: 0 },
      loops: [
        {
          loopId: LOOP_ID,
          projectId: PROJECT.projectId,
          state: "needs_attention",
          severity: "high",
          fingerprint: "fp_cosmetic",
          furthestStage: "deployed",
          hasProof: true,
          terminal: "blocked",
          badges: COSMETIC_BADGES,
        },
      ],
      totalLoops: 3,
    },
  };
}

function proofResponse() {
  return {
    version: "v1",
    orgId: ORG.id,
    projectId: PROJECT.projectId,
    loopId: LOOP_ID,
    proofs: [
      {
        id: "rproof_blocked_1",
        terminal: "blocked",
        sealedAt: "2026-07-16T12:00:00.000Z",
        verification: { valid: true, divergedAt: null, recomputedProofHash: "sha256:abc" },
        proof: {
          version: "tanren-resolution-proof.v1",
          terminal: "blocked",
          issueLoopId: LOOP_ID,
          proofHash: "sha256:abcdef0123456789",
          badges: COSMETIC_BADGES,
          evidence: {
            sections: {
              issue_loop: {
                issueLoopId: LOOP_ID,
                fingerprint: "fp_cosmetic",
                sourceRevision: "rev-1",
                providerObjectId: "gh-issue-7",
              },
              triage: { taskId: "task_1", status: "completed" },
              spec_origins: [{ id: "so_1", specId: "spec_1", role: "primary", attemptNumber: 1, ordinal: 0 }],
              merge: { mergeSha: "deadbeefcafe0001", authorityAuditId: "audit_1" },
              deployment: {
                releaseInstanceId: "rel_1",
                artifactDigest: "sha256:artifact",
                url: "https://live.example.com",
                state: "live",
              },
              baseline: { verificationRunId: "run_base", artifactDigest: null, classification: "product_failure" },
              counterfactual: null,
              production_symptom: {
                verificationRunId: "run_prod",
                classification: "product_failure",
                outcome: "failed",
                artifactDigest: "sha256:artifact",
                probedUrl: "https://live.example.com",
                assertions: [{ id: "assert_1", outcome: "failed" }],
              },
              resolution_decision: { decisionId: "dec_1", decision: "blocked", authorityVersion: "v1" },
              source_sync: null,
            },
          },
        },
      },
    ],
  };
}

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "csrf", expiresAt: "2030-01-01" }), {
        status: 200,
      });
    }
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (url.endsWith(`/orgs/${ORG.id}/projects`)) {
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    }
    if (url.endsWith(`/v1/orgs/${ORG.id}/self-healing/funnel`)) {
      return new Response(JSON.stringify(funnelResponse()), { status: 200 });
    }
    if (url.includes(`/issue-loops/${LOOP_ID}/proof`)) {
      return new Response(JSON.stringify(proofResponse()), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("self-healing overview screen", () => {
  it("renders the real org-scoped funnel with a symptom-verified drop-off", async () => {
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const response = await app.request("/self-healing");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("how issues close themselves");
    // The funnel counts came from the real client parse of the orchestrator JSON.
    expect(html).toContain('data-stage="deployed"');
    expect(html).toContain('data-stage="symptom_verified"');
    expect(html).toMatch(/data-stage="symptom_verified"[\s\S]*?data-count="0"/u);
    // The loop row links into the project-scoped detail route.
    expect(html).toContain(`/self-healing/projects/${PROJECT.projectId}/loops/${LOOP_ID}`);
  });
});

describe("self-healing loop-detail badges", () => {
  it("shows the symptom badge FAILED while the demo badge stays PASS — six independent fields", async () => {
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const response = await app.request(`/self-healing/projects/${PROJECT.projectId}/loops/${LOOP_ID}`);
    const html = await response.text();

    expect(response.status).toBe(200);

    // The six badges are SEPARATE DOM fields, each with its own tone.
    for (const key of ["gate", "merged", "deploy", "demo", "symptom", "source"]) {
      expect(html).toContain(`data-badge="${key}"`);
    }

    // THE decisive invariant: symptom is red (fail) WHILE demo is green (pass) —
    // the two are distinct spans, never OR'd into one collapsed green.
    expect(html).toMatch(/data-badge="symptom"[^>]*data-tone="fail"/u);
    expect(html).toMatch(/data-badge="demo"[^>]*data-tone="pass"/u);
    expect(html).toMatch(/data-badge="merged"[^>]*data-tone="pass"/u);
    // The badge values themselves render independently.
    expect(html).toContain("failed");
    expect(html).toContain("reachable");
    // The causal chain marks the failed production symptom re-verify node.
    expect(html).toContain("symptom-failed");
    expect(html).toContain("production symptom re-verify");
  });
});
