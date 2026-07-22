// Durable derivation response-loss proof. Provider success can race a lost DB
// receipt response; the persisted intent must make the retry reconcile the same
// logical effect rather than create another one.

import { getOrgScope } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  ProjectDesignElaborationStateUnknownError,
  type InterviewCapture,
  type PreparedGreenfieldDeploy,
} from "../src/engine/forge/interview/index.js";
import { designContractDigest } from "../src/engine/design/designContract.js";
import { ProjectDerivationStore } from "../src/engine/repositories/projects.js";
import type { MaterializeTemplate, SeededTemplate } from "../src/engine/templates/index.js";
import { stubPool, noopComposeDesignSystem, successfulBootstrapProject } from "./fixtures/forge/interviewDeriveStub.js";
import { completeCaptureExtras } from "./fixtures/forge/completeCapture.js";

const ACTOR: ActorContext = {
  userId: "response-loss-test",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};
const CAPTURE: InterviewCapture = {
  ...emptyCapture(),
  ...completeCaptureExtras(),
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
const DESIGN_ANSWER = {
  domain: "proof",
  identity: "an exact replay proof",
  intent: "never repeat an ambiguous design-provider effect",
  principles: [],
  constraints: [],
  dimensions: [
    {
      key: "clarity",
      label: "Clarity",
      intent: "Make the response-loss boundary explicit.",
      guidance: "",
      personaIds: [],
    },
  ],
  coverage: [],
};

// The capture now carries a persona + behavior (rv-21 completeness), so an elaborated
// design must EXHAUSTIVELY cover every behavior. The provider `elaborate` receives the
// plan's `agentInput` (personas + behaviors with their derivation ids), so build the
// coverage from it — a design answer that covers exactly the captured behaviors.
function answerCovering(agentInput: {
  personas: ReadonlyArray<{ id: string }>;
  behaviors: ReadonlyArray<{ id: string; personaId: string }>;
}) {
  return {
    ...DESIGN_ANSWER,
    dimensions: [{ ...DESIGN_ANSWER.dimensions[0]!, personaIds: agentInput.personas.map((persona) => persona.id) }],
    coverage: agentInput.behaviors.map((behavior) => ({
      behaviorId: behavior.id,
      personaId: behavior.personaId,
      dimensionKey: "clarity",
      surface: "clarity surface",
    })),
  };
}

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

function loseNextReceiptResponse(pool: pg.Pool, matches: (sql: string, params: unknown[]) => boolean): () => void {
  const originalQuery = pool.query.bind(pool) as (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number }>;
  const originalConnect = pool.connect.bind(pool);
  let armed = true;
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    const result = await originalQuery(text, params);
    if (armed && matches(sql, params)) {
      armed = false;
      throw new Error("injected response loss after receipt commit");
    }
    return result;
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
    composeDesignSystem: noopComposeDesignSystem,
    createRepository,
  };
}

describe("project derivation — provider response loss at receipt boundaries", () => {
  it("runs design-provider I/O outside the graph transaction and persists its immutable result", async () => {
    const { pool } = stubPool();
    let calls = 0;
    const result = await deriveFromCapture(
      {
        pool,
        async prepareDeploy() {
          return deployReceipt();
        },
      },
      {
        ...deriveInput(
          async () => SEED,
          async () => ({
            fullName: "cat-cave/response-loss",
            repoUrl: "https://github.com/cat-cave/response-loss",
            defaultBranch: "main",
          }),
        ),
        designAgent: {
          async elaborate(agentInput) {
            calls += 1;
            expect(getOrgScope()).toBeUndefined();
            return answerCovering(agentInput);
          },
        },
      },
    );

    expect(result.projectName).toBe("response-loss");
    expect(calls).toBe(1);
    const operation = await ProjectDerivationStore.findForProject(pool, "org_a", result.projectId);
    if (operation === undefined) throw new Error("provider derivation missing");
    const receipts = ProjectDerivationStore.decode(operation).results;
    expect(receipts.design?.contractDigest).toBe(designContractDigest(receipts.design?.contract));
    expect(receipts.graph?.designContract.digest).toBe(receipts.design?.contractDigest);
  });

  it("records the same normalized immutable design result in captured mode", async () => {
    const { pool, state } = stubPool();
    const result = await deriveFromCapture(
      {
        pool,
        async prepareDeploy() {
          return deployReceipt();
        },
      },
      deriveInput(
        async () => SEED,
        async () => ({
          fullName: "cat-cave/response-loss",
          repoUrl: "https://github.com/cat-cave/response-loss",
          defaultBranch: "main",
        }),
      ),
    );
    const operation = await ProjectDerivationStore.findForProject(pool, "org_a", result.projectId);
    if (operation === undefined) throw new Error("captured derivation missing");
    const receipts = ProjectDerivationStore.decode(operation).results;
    expect(receipts.design_intent).toBeUndefined();
    expect(receipts.design?.contract).toEqual(state.designContracts[0]);
    expect(receipts.design?.contractDigest).toBe(designContractDigest(receipts.design?.contract));
    expect(receipts.graph?.designContract.digest).toBe(receipts.design?.contractDigest);
  });

  it("parks an uncommitted design result as state_unknown and never calls the provider twice", async () => {
    const { pool, state } = stubPool();
    let calls = 0;
    const input = {
      ...deriveInput(
        async () => SEED,
        async () => ({
          fullName: "cat-cave/response-loss",
          repoUrl: "https://github.com/cat-cave/response-loss",
          defaultBranch: "main",
        }),
      ),
      designAgent: {
        async elaborate() {
          calls += 1;
          return DESIGN_ANSWER;
        },
      },
    };
    const restore = interruptNextReceipt(
      pool,
      (sql, params) => sql.includes("result_receipt = jsonb_set") && params[2] === "design",
    );
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy() {
            return deployReceipt();
          },
        },
        input,
      ),
    ).rejects.toBeInstanceOf(ProjectDesignElaborationStateUnknownError);
    restore();

    const projectId = [...state.projects][0];
    if (projectId === undefined) throw new Error("deriving shell was not persisted");
    const interrupted = await ProjectDerivationStore.findForProject(pool, "org_a", projectId);
    if (interrupted === undefined) throw new Error("interrupted derivation missing");
    expect(ProjectDerivationStore.decode(interrupted).results).toMatchObject({
      design_intent: { effect: "design", inputDigest: expect.stringMatching(/^sha256:/u) },
    });
    expect(ProjectDerivationStore.decode(interrupted).results.design).toBeUndefined();

    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy() {
            throw new Error("retry must not repeat deploy");
          },
        },
        input,
      ),
    ).rejects.toBeInstanceOf(ProjectDesignElaborationStateUnknownError);
    expect(calls).toBe(1);
  });

  it("reconciles a committed design result after response loss without repeating the provider", async () => {
    const { pool } = stubPool();
    let calls = 0;
    const restore = loseNextReceiptResponse(
      pool,
      (sql, params) => sql.includes("result_receipt = jsonb_set") && params[2] === "design",
    );
    const result = await deriveFromCapture(
      {
        pool,
        async prepareDeploy() {
          return deployReceipt();
        },
      },
      {
        ...deriveInput(
          async () => SEED,
          async () => ({
            fullName: "cat-cave/response-loss",
            repoUrl: "https://github.com/cat-cave/response-loss",
            defaultBranch: "main",
          }),
        ),
        designAgent: {
          async elaborate(agentInput) {
            calls += 1;
            return answerCovering(agentInput);
          },
        },
      },
    );
    restore();

    expect(result.projectName).toBe("response-loss");
    expect(calls).toBe(1);
  });

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
