// rv-21 — the Forge interview → DesignContract synthesis consumer, proven END-TO-END
// through the MOUNTED onboarding HTTP routes against a REAL, RLS-enforcing PostgreSQL.
//
// POSITIVE: drive multiple interview rounds through POST .../interview/round with an
// injected strict-schema answerer for a DESIGN-LIGHT, NON-WEB project (a CLI tool), then
// POST .../interview/derive. Prove:
//   - the answerer's EARLY completion claim is CORRECTED (round.complete stays false with
//     typed missing areas) until the capture is actually complete;
//   - the derived, project-scoped, versioned DesignContractV1's digest matches the stored
//     HEAD (rv-13 load returns the exact same contract);
//   - EVERY persisted persona + behavior is covered by the contract's persona/behavior refs;
//   - each behavior ref resolves to the newly-created behavior identity AND its immutable
//     current rv-1 revision.
//
// NEGATIVE CONTROL: an answerer returns complete:true while omitting the design seed AND
// naming an unknown persona; the round returns complete:false with typed missing/invalid
// areas, and the direct derive returns a typed 409 WITHOUT creating any repository,
// project, or design-contract row — no captured reference silently dropped.

import { migrate, resetSystemPool, runWithOrgScope, setSystemPool } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { designContractDigest } from "../src/engine/design/designContract.js";
import type { InterviewAnswerer, InterviewRoundOutput } from "../src/engine/forge/interview/index.js";
import { DesignContractStore } from "../src/engine/repositories/designContracts.js";
import { systemActor } from "../src/engine/state/actor.js";
import {
  FakeRepoCreateHttp,
  mountRv21OnboardingApp,
  seedRv21DeployConnection,
} from "./helpers/rv21OnboardingHarness.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_rv21_interview";
const OWNER = "cat-cave";
const STATIC_TOKEN_REF = `credential/github/org/${ORG}/default`;

const actor: ActorContext = {
  userId: "user_rv21",
  orgId: ORG,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

/* eslint-disable unicorn/no-thenable -- Given/When/Then is the captured behavior vocabulary. */
// A DESIGN-LIGHT, NON-WEB project (a CLI log-merger). The design contract's domain is
// "cli-tool" with NO web dimensions (an explicit design-light seed, never a silent
// absence), and it references EVERY captured persona + behavior so coverage is exhaustive.
const POSITIVE_SCRIPT: InterviewRoundOutput[] = [
  { say: "What are we building?", captureDelta: {}, suggestions: [], complete: false },
  {
    say: "Who uses it?",
    captureDelta: { identity: { slug: "logmerge", pitch: "merge and dedupe log streams from the CLI", repoHint: "" } },
    suggestions: [],
    complete: false,
  },
  {
    say: "Walk me through their behaviors.",
    captureDelta: {
      personas: [
        { name: "sre", description: "runs incident triage from a terminal", surface: "cli" },
        { name: "developer", description: "greps local logs while building", surface: "cli" },
      ],
    },
    suggestions: [],
    complete: false,
  },
  {
    // EARLY completion claim — the capture still lacks interfaces / design seed /
    // architecture / lifecycle, so the deterministic gate MUST keep the round incomplete.
    say: "Anything else?",
    captureDelta: {
      behaviors: [
        {
          persona: "sre",
          title: "merge two streams",
          given: "two log files",
          when: "they run logmerge a.log b.log",
          then: "a single time-ordered stream prints",
        },
        {
          persona: "developer",
          title: "dedupe repeats",
          given: "a noisy stream",
          when: "they pass --dedupe",
          then: "consecutive duplicate lines collapse",
        },
      ],
    },
    suggestions: [],
    complete: true,
  },
  {
    say: "What surfaces?",
    captureDelta: { interfaces: [{ name: "cli", note: "a single static binary" }] },
    suggestions: [],
    complete: false,
  },
  {
    say: "Design direction?",
    captureDelta: {
      designContract: {
        domain: "cli-tool",
        identity: "a terse, scriptable command-line surface",
        intent: "output that pipes cleanly and never colorizes when redirected",
        principles: ["exit non-zero on any error"],
        constraints: [],
        personas: ["sre", "developer"],
        behaviors: ["sre::merge two streams", "developer::dedupe repeats"],
        dimensions: [],
      },
    },
    suggestions: [],
    complete: false,
  },
  {
    say: "Confirm the stack.",
    captureDelta: {
      architecture: [{ layer: "cli", choice: "typescript · single binary" }],
      lifecycle: {
        stack: "ts/pnpm",
        bootstrap: "pnpm install",
        tier1: "pnpm lint && pnpm typecheck",
        tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
        tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
        build: "pnpm build",
        deploy: "flyctl deploy",
      },
    },
    suggestions: [],
    complete: false,
  },
  { say: "Ready to derive.", captureDelta: { rulesets: [] }, suggestions: [], complete: true },
];
/* eslint-enable unicorn/no-thenable */

function scriptedAnswerer(script: InterviewRoundOutput[]): InterviewAnswerer {
  return {
    async ask(context) {
      return script[Math.min(context.round - 1, script.length - 1)]!;
    },
  };
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function appUrl(url: string, database: string): string {
  const parsed = new URL(withDatabase(url, database));
  parsed.username = "tanren_app";
  parsed.password = APP_PASSWORD;
  return parsed.toString();
}

describeDb("rv-21 — onboarding interview → DesignContract synthesis (real PostgreSQL, RLS)", () => {
  const database = `tanren_rv21_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let owner: Pool;
  let runtime: Pool;
  let githubHttp: FakeRepoCreateHttp;

  const buildApp = (answerer: InterviewAnswerer) =>
    mountRv21OnboardingApp({ owner, runtime, githubHttp, actor, org: ORG, staticTokenRef: STATIC_TOKEN_REF, answerer });

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(owner);
    runtime = new Pool({ connectionString: appUrl(ADMIN_URL, database) });
    setSystemPool(owner);
    githubHttp = new FakeRepoCreateHttp();
    await owner.query(
      `INSERT INTO users (id, provider, provider_subject, login, email, display_name)
       VALUES ($1, 'local_dev', $1, 'rv21-user', 'rv21@example.com', 'RV21 User')`,
      [actor.userId],
    );
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, $2::jsonb)`,
      [ORG, JSON.stringify({ version: 1, defaultCredentials: { github_token: STATIC_TOKEN_REF } })],
    );
    // Seed the deploy connection + grant (no projects yet — the derive creates the project,
    // and its injected prepareDeploy persists the project-scoped grant selection).
    await seedRv21DeployConnection(runtime, ORG);
  }, 120_000);

  afterAll(async () => {
    resetSystemPool();
    await runtime?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("corrects an early completion claim, then derives a project-scoped versioned DesignContract whose HEAD matches, covers every persona+behavior, and rv-13 can load", async () => {
    const app = buildApp(scriptedAnswerer(POSITIVE_SCRIPT));

    // Drive the rounds. Track the round where the answerer FIRST claimed complete so we can
    // assert the deterministic gate corrected it.
    type RoundBody = {
      capture: unknown;
      complete: boolean;
      completion: { complete: boolean; missing: string[]; invalid: unknown[] };
    };
    let capture: unknown;
    // Round 4 (index 3) claims complete:true while the capture still lacks the design seed
    // / interfaces / architecture / lifecycle — captured here to assert AFTER the loop.
    let earlyClaim: RoundBody | undefined;
    let finalComplete = false;
    for (let round = 1; round <= 20 && !finalComplete; round += 1) {
      const res = await app.request(`/orgs/${ORG}/onboarding/interview/round`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ round, answer: "ok", ...(capture === undefined ? {} : { capture }) }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as RoundBody;
      capture = body.capture;
      if (round === 4) earlyClaim = body;
      finalComplete = body.complete;
    }
    // The answerer's EARLY completion claim was corrected: the round stayed incomplete and
    // surfaced the typed areas still owed.
    expect(earlyClaim?.complete).toBe(false);
    expect(earlyClaim?.completion.complete).toBe(false);
    expect(earlyClaim?.completion.missing).toEqual(
      expect.arrayContaining(["interface", "designSeed", "architecture", "lifecycle"]),
    );
    expect(finalComplete).toBe(true);

    const deriveRes = await app.request(`/orgs/${ORG}/onboarding/interview/derive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture,
        owner: OWNER,
        private: true,
        autonomy: "auto",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });
    expect(deriveRes.status).toBe(201);
    const derived = (await deriveRes.json()) as {
      projectId: string;
      designContract: { id: string; version: number; domain: string; digest: string };
    };
    expect(derived.designContract.domain).toBe("cli-tool");
    expect(derived.designContract.version).toBe(1);
    expect(derived.designContract.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    // rv-13 LOAD — the exact HEAD contract loads under the org scope and its digest equals
    // the derive's returned digest (proof = effect: same contract, same coordinate).
    const projectId = derived.projectId;
    const lookup = await runWithOrgScope(runtime, ORG, (client) =>
      DesignContractStore.getLatestState(client, projectId, systemActor),
    );
    expect(lookup.kind).toBe("found");
    if (lookup.kind !== "found") throw new Error("HEAD contract not found");
    const head = lookup.record;
    expect(head.version).toBe(1);
    expect(designContractDigest(head.contract)).toBe(derived.designContract.digest);

    // COVERAGE — every persisted persona + behavior is referenced by the contract (exact
    // multiset equality, not a subset), and the behavior refs resolve to the newly-created
    // behavior identities + their immutable current rv-1 revisions.
    const graph = await runWithOrgScope(runtime, ORG, async (client) => {
      const personas = await client.query<{ id: string }>("SELECT id FROM personas WHERE project_id = $1", [projectId]);
      const behaviors = await client.query<{ id: string }>(
        "SELECT b.id FROM behaviors b JOIN personas p ON p.id = b.persona_id WHERE p.project_id = $1",
        [projectId],
      );
      return {
        personaIds: personas.rows.map((row) => row.id),
        behaviorIds: behaviors.rows.map((row) => row.id),
      };
    });
    expect(graph.personaIds.length).toBe(2);
    expect(graph.behaviorIds.length).toBe(2);
    expect([...head.contract.personaRefs].sort()).toEqual([...graph.personaIds].sort());
    expect([...head.contract.behaviorRefs].sort()).toEqual([...graph.behaviorIds].sort());

    // Each behavior ref → its immutable current revision (rv-1: active, content-addressed).
    for (const behaviorId of head.contract.behaviorRefs) {
      const revision = await runWithOrgScope(runtime, ORG, (client) =>
        client.query<{ revision_number: number; content_digest: string; status: string }>(
          "SELECT revision_number, content_digest, status FROM behavior_revisions WHERE behavior_id = $1 ORDER BY revision_number DESC LIMIT 1",
          [behaviorId],
        ),
      );
      expect(revision.rowCount).toBe(1);
      expect(revision.rows[0]!.status).toBe("active");
      expect(revision.rows[0]!.revision_number).toBe(1);
      expect(revision.rows[0]!.content_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    }
  });

  it("NEGATIVE CONTROL — an early complete claim that omits the design seed and names an unknown persona: round stays incomplete, direct derive 409s without creating a repository, project, or design-contract row", async () => {
    /* eslint-disable unicorn/no-thenable -- Given/When/Then is the captured behavior vocabulary. */
    // A single-round answerer that claims complete:true while (a) OMITTING the design seed
    // and (b) naming a persona ("ghost") the interview never captured.
    const negativeScript: InterviewRoundOutput[] = [
      {
        say: "All done!",
        captureDelta: {
          identity: { slug: "ghosttool", pitch: "a tool with a dangling reference", repoHint: "" },
          personas: [{ name: "sre", description: "the only real persona", surface: "cli" }],
          behaviors: [
            {
              persona: "ghost",
              title: "haunt the graph",
              given: "an unknown persona",
              when: "the answerer names it",
              then: "the reference dangles",
            },
          ],
          interfaces: [{ name: "cli", note: "" }],
          architecture: [{ layer: "cli", choice: "typescript" }],
          lifecycle: {
            stack: "ts/pnpm",
            bootstrap: "pnpm install",
            tier1: "pnpm lint",
            tier2: "pnpm test",
            tier3: "pnpm build && pnpm test",
            build: "pnpm build",
            deploy: "pnpm publish",
          },
          // NOTE: designContract intentionally OMITTED (the missing design seed).
        },
        suggestions: [],
        complete: true,
      },
    ];
    /* eslint-enable unicorn/no-thenable */
    const app = buildApp(scriptedAnswerer(negativeScript));

    const roundRes = await app.request(`/orgs/${ORG}/onboarding/interview/round`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ round: 1, answer: "" }),
    });
    expect(roundRes.status).toBe(200);
    const round = (await roundRes.json()) as {
      capture: unknown;
      complete: boolean;
      completion: { complete: boolean; missing: string[]; invalid: Array<{ kind: string; ref: string }> };
    };
    // The gate keeps the round incomplete and reports the typed missing + invalid areas.
    expect(round.complete).toBe(false);
    expect(round.completion.missing).toContain("designSeed");
    expect(round.completion.invalid).toContainEqual(expect.objectContaining({ kind: "behaviorPersona", ref: "ghost" }));

    const beforeRepos = githubHttp.createdRepositories.length;
    const deriveRes = await app.request(`/orgs/${ORG}/onboarding/interview/derive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture: round.capture, owner: OWNER, deploy: { providerKind: "deploy.vercel" } }),
    });
    expect(deriveRes.status).toBe(409);
    const body = (await deriveRes.json()) as {
      error: string;
      missing: string[];
      invalid: Array<{ kind: string; ref: string }>;
    };
    expect(body.error).toBe("interview_incomplete");
    expect(body.missing).toContain("designSeed");
    expect(body.invalid).toContainEqual(expect.objectContaining({ kind: "behaviorPersona", ref: "ghost" }));

    // FAIL-CLOSED BEFORE ANY EFFECT — no repository, no project row, no design-contract row.
    expect(githubHttp.createdRepositories.length).toBe(beforeRepos);
    const rows = await owner.query<{ projects: number; contracts: number }>(
      `SELECT
         (SELECT count(*)::int FROM projects WHERE repo_url LIKE '%ghosttool%') AS projects,
         (SELECT count(*)::int FROM design_contracts d JOIN projects p ON p.project_id = d.project_id
            WHERE p.repo_url LIKE '%ghosttool%') AS contracts`,
    );
    expect(rows.rows[0]!.projects).toBe(0);
    expect(rows.rows[0]!.contracts).toBe(0);
  });
});
