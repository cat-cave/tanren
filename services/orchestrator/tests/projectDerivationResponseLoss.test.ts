// Durable derivation response-loss proof. Provider success can race a lost DB
// receipt response; the persisted intent must make the retry reconcile the same
// logical effect rather than create another one.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  type InterviewCapture,
  type PreparedGreenfieldDeploy,
} from "../src/engine/forge/interview/index.js";
import { ProjectDerivationStore } from "../src/engine/repositories/projects.js";
import type { MaterializeTemplate, SeededTemplate } from "../src/engine/templates/index.js";
import { stubPool, successfulBootstrapProject } from "./fixtures/forge/interviewDeriveStub.js";

const ACTOR: ActorContext = {
  userId: "response-loss-test",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};
const CAPTURE: InterviewCapture = {
  ...emptyCapture(),
  identity: { slug: "response-loss", pitch: "Prove exact replay.", repoHint: "" },
  designContract: {
    domain: "proof",
    identity: "an exact replay proof",
    intent: "never duplicate external effects",
    principles: [],
    constraints: [],
    personas: [],
    behaviors: [],
    dimensions: [],
  },
  lifecycle: {
    stack: "ts/pnpm",
    bootstrap: "pnpm install",
    tier1: "pnpm lint",
    tier2: "pnpm test",
    tier3: "pnpm check",
    build: "pnpm build",
    deploy: "flyctl deploy",
    toolchain: [],
  },
};
const SEED: SeededTemplate = {
  templateRef: "tanren://composed/response-loss@1234567890abcdef",
  validatedAt: "2026-07-16T00:00:00.000Z",
};

function deployReceipt(): PreparedGreenfieldDeploy {
  return {
    outcome: {
      status: "provisioned",
      capability: "deploy",
      providerKind: "deploy.flyio",
      action: "provision",
      mode: "greenfield",
      authority: {
        connectionId: "connection_1",
        grantId: "grant_1",
        providerPrincipalId: "account_1",
        authGeneration: 1,
        grantGeneration: 1,
      },
      secretRefNames: ["secret://deploy/flyio/app_once/token"],
      surfaces: { projectConfigKeys: ["deployProvider", "deployAppId"], deployRef: "deploy.flyio:app_once" },
    },
    projectConfig: {
      deployProvider: "deploy.flyio",
      deployAppId: "app_once",
      deployAppName: "response-loss",
    },
  };
}

function interruptNextReceipt(pool: pg.Pool, matches: (sql: string, params: unknown[]) => boolean): () => void {
  const originalQuery = pool.query.bind(pool) as (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number }>;
  const originalConnect = pool.connect.bind(pool);
  let armed = true;
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (armed && matches(sql, params)) {
      armed = false;
      throw new Error("injected response loss before receipt commit");
    }
    return originalQuery(text, params);
  };
  (pool as unknown as { query: typeof query }).query = query;
  (pool as unknown as { connect: () => Promise<{ query: typeof query; release: () => void }> }).connect = async () => ({
    query,
    release() {},
  });
  return () => {
    (pool as unknown as { query: typeof originalQuery }).query = originalQuery;
    (pool as unknown as { connect: typeof originalConnect }).connect = originalConnect;
  };
}

function deriveInput(
  materializeTemplate: MaterializeTemplate,
  createRepository: () => Promise<{
    fullName: string;
    repoUrl: string;
    defaultBranch: string;
  }>,
) {
  return {
    orgId: "org_a",
    capture: CAPTURE,
    actor: ACTOR,
    owner: "cat-cave",
    deploy: { providerKind: "deploy.flyio" as const },
    materializeTemplate,
    bootstrapProject: successfulBootstrapProject,
    createRepository,
  };
}

describe("project derivation — provider response loss at receipt boundaries", () => {
  it("persists template intent first and reconciles the same materialization after response loss", async () => {
    const { pool, state } = stubPool();
    const templateEffects = new Set<string>();
    const deployEffects = new Set<string>();
    let templateCalls = 0;
    let repoEffects = 0;
    const materialize: MaterializeTemplate = async (input) => {
      templateCalls += 1;
      templateEffects.add(input.idempotencyKey ?? "missing");
      return SEED;
    };
    const input = deriveInput(materialize, async () => {
      repoEffects += 1;
      return {
        fullName: "cat-cave/response-loss",
        repoUrl: "https://github.com/cat-cave/response-loss",
        defaultBranch: "main",
      };
    });
    const restore = interruptNextReceipt(pool, (sql) => sql.includes("template_receipt = $3::jsonb"));
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy(effect) {
            deployEffects.add(effect.idempotencyKey ?? "missing");
            return deployReceipt();
          },
        },
        input,
      ),
    ).rejects.toThrow(/response loss before receipt commit/iu);
    restore();

    const projectId = [...state.projects][0];
    if (projectId === undefined) throw new Error("deriving shell was not persisted");
    const interrupted = await ProjectDerivationStore.findForProject(pool, "org_a", projectId);
    if (interrupted === undefined) throw new Error("interrupted derivation missing");
    const decoded = ProjectDerivationStore.decode(interrupted);
    expect(interrupted.templateReceipt).toBeNull();
    expect(decoded.results.template_intent).toMatchObject({
      effect: "template",
      idempotencyKey: expect.stringMatching(/:template$/u),
    });

    await deriveFromCapture(
      {
        pool,
        async prepareDeploy(effect) {
          deployEffects.add(effect.idempotencyKey ?? "missing");
          return deployReceipt();
        },
      },
      input,
    );
    expect(templateCalls).toBe(2);
    expect(templateEffects.size).toBe(1);
    expect(templateEffects.has("missing")).toBe(false);
    expect(deployEffects.size).toBe(1);
    expect(repoEffects).toBe(1);
  });

  it("persists deploy intent first and find-or-create reconciles one app after response loss", async () => {
    const { pool, state } = stubPool();
    const deployEffects = new Set<string>();
    let deployCalls = 0;
    let templateCalls = 0;
    const input = deriveInput(
      async () => {
        templateCalls += 1;
        return SEED;
      },
      async () => ({
        fullName: "cat-cave/response-loss",
        repoUrl: "https://github.com/cat-cave/response-loss",
        defaultBranch: "main",
      }),
    );
    const prepareDeploy = async (effect: { idempotencyKey?: string }) => {
      deployCalls += 1;
      deployEffects.add(effect.idempotencyKey ?? "missing");
      return deployReceipt();
    };
    const restore = interruptNextReceipt(
      pool,
      (sql, params) => sql.includes("result_receipt = jsonb_set") && params[2] === "deploy",
    );
    await expect(deriveFromCapture({ pool, prepareDeploy }, input)).rejects.toThrow(
      /response loss before receipt commit/iu,
    );
    restore();

    const projectId = [...state.projects][0];
    if (projectId === undefined) throw new Error("deriving shell was not persisted");
    const interrupted = await ProjectDerivationStore.findForProject(pool, "org_a", projectId);
    if (interrupted === undefined) throw new Error("interrupted derivation missing");
    const decoded = ProjectDerivationStore.decode(interrupted);
    expect(decoded.results.deploy).toBeUndefined();
    expect(decoded.results.deploy_intent).toMatchObject({
      effect: "deploy",
      idempotencyKey: expect.stringMatching(/:deploy$/u),
    });

    await deriveFromCapture({ pool, prepareDeploy }, input);
    expect(deployCalls).toBe(2);
    expect(deployEffects.size).toBe(1);
    expect(deployEffects.has("missing")).toBe(false);
    expect(templateCalls).toBe(1);
  });
});
