// Contract test for the template REGISTRY operator routes. Proves the app-layer
// behavior independent of the DB: org-access authz (cross-org 403, write needs
// admin), the fail-loud manifest parse (a malformed `.tanren/template.yml` is a
// 400, never a half-registered template), and the register → list → get → status
// happy path wiring. The DB-level RLS org scoping is proven separately against a
// real Postgres in templateRegistry.integration.test.ts; here a tiny in-memory pg
// substitute covers only the templates SQL shapes the store emits.

import { Hono } from "hono";
import type pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createTemplateRoutes, type CreateTemplateFlow } from "../src/routes/templates/index.js";
import { type CreateTemplateResult, TemplateValidationFailedError } from "../src/engine/templates/index.js";

const ORG = "org_acme";
const OTHER_ORG = "org_other";

const admin: ActorContext = {
  userId: "u_admin",
  orgId: ORG,
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};
const member: ActorContext = {
  userId: "u_mem",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

// A tiny in-memory templates table. Interprets only the four SQL shapes
// TemplateStore emits (INSERT RETURNING / SELECT by id / SELECT all / capability
// SELECT / UPDATE status RETURNING). RLS is not modeled here — that is the
// integration test's job; this fake serves the route-wiring + authz assertions.
class TemplatesPool {
  readonly rows: Array<Record<string, unknown>> = [];

  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("INSERT INTO templates")) {
      const [id, orgId, repoRef, manifest, status, channel] = params as string[];
      const row = {
        id,
        org_id: orgId,
        repo_ref: repoRef,
        manifest: JSON.parse(manifest),
        status,
        channel,
        created_at: new Date(),
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT") && sql.includes("WHERE id = $1")) {
      const row = this.rows.find((r) => r["id"] === params[0]);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.startsWith("UPDATE templates SET status")) {
      const row = this.rows.find((r) => r["id"] === params[0]);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row["status"] = params[1];
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM templates")) {
      // list / listByCapabilities — return all (capability filtering is exercised
      // against a real DB in the integration test).
      return { rows: [...this.rows], rowCount: this.rows.length };
    }
    throw new Error(`unhandled SQL in TemplatesPool: ${sql}`);
  }

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

function harness(who?: ActorContext) {
  const pool = new TemplatesPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return who as ActorContext;
        },
      } as never,
      localDevActor: who,
    }),
  );
  app.route("/orgs", createTemplateRoutes({ pool: pool.asPgPool() }));
  return { app, pool };
}

const VALID_MANIFEST = `version: 1
stack: "ts"
capabilities:
  runtime: "node"
  packageManager: "pnpm"
  framework: "next"
  gates:
    - "tier-1"
  bdd: true
  mutation: false
  junit: true
channel: "lts"
templateVersion: "1.0.0"
provenance:
  researchSources:
    - "seed"
validationProof: null
`;

function req(app: Hono<ActorContextEnv>, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness(admin);
});

describe("template registry routes — org scope + fail-loud parse", () => {
  it("registers a template (201), then lists + gets it", async () => {
    const created = await req(h.app, "POST", `/orgs/${ORG}/templates`, {
      repoRef: "cat-cave/ts",
      manifestYaml: VALID_MANIFEST,
    });
    expect(created.status).toBe(201);
    const { template } = (await created.json()) as { template: { id: string; orgId: string; status: string } };
    expect(template.orgId).toBe(ORG);
    expect(template.status).toBe("draft");

    const listed = await req(h.app, "GET", `/orgs/${ORG}/templates`);
    expect(listed.status).toBe(200);
    const { templates } = (await listed.json()) as { templates: unknown[] };
    expect(templates).toHaveLength(1);

    const got = await req(h.app, "GET", `/orgs/${ORG}/templates/${template.id}`);
    expect(got.status).toBe(200);
  });

  it("transitions status via PATCH", async () => {
    const created = await req(h.app, "POST", `/orgs/${ORG}/templates`, {
      repoRef: "cat-cave/ts",
      manifestYaml: VALID_MANIFEST,
    });
    const { template } = (await created.json()) as { template: { id: string } };
    const patched = await req(h.app, "PATCH", `/orgs/${ORG}/templates/${template.id}/status`, { status: "validated" });
    expect(patched.status).toBe(200);
    const { template: updated } = (await patched.json()) as { template: { status: string } };
    expect(updated.status).toBe("validated");
  });

  it("rejects a malformed manifest with a loud 400 (never half-registers)", async () => {
    const bad = VALID_MANIFEST.replace('channel: "lts"', 'channel: "stable"');
    const res = await req(h.app, "POST", `/orgs/${ORG}/templates`, { repoRef: "x", manifestYaml: bad });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_manifest");
    // nothing persisted
    expect(h.pool.rows).toHaveLength(0);
  });

  it("denies a cross-org caller (403) on read", async () => {
    const res = await req(h.app, "GET", `/orgs/${OTHER_ORG}/templates`);
    expect(res.status).toBe(403);
  });

  it("denies a non-admin member on write (403), allows on read", async () => {
    const m = harness(member);
    const write = await req(m.app, "POST", `/orgs/${ORG}/templates`, {
      repoRef: "x",
      manifestYaml: VALID_MANIFEST,
    });
    expect(write.status).toBe(403);
    const read = await req(m.app, "GET", `/orgs/${ORG}/templates`);
    expect(read.status).toBe(200);
  });

  it("denies an unauthenticated caller", async () => {
    const anon = harness();
    const res = await req(anon.app, "GET", `/orgs/${ORG}/templates`);
    expect([401, 403]).toContain(res.status);
  });
});

// The CREATION META-DAG trigger endpoint (wave 4): POST .../templates/create.
// Mounted only when a `createTemplateFlow` is injected; here we inject a stub so
// the route wiring + the fail-closed 422 surface are proven (the live flow is
// exercised end-to-end in templateCreation.test.ts).
function createHarness(flow: CreateTemplateFlow, who: ActorContext = admin) {
  const pool = new TemplatesPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return who;
        },
      } as never,
      localDevActor: who,
    }),
  );
  app.route("/orgs", createTemplateRoutes({ pool: pool.asPgPool(), createTemplateFlow: flow }));
  return { app, pool };
}

const CREATE_REQUEST = { stack: "ts-pnpm", runtime: "node", packageManager: "pnpm" };

// A flow that must never be reached (authz/validation rejects before it runs).
const unreachableFlow: CreateTemplateFlow = async () => {
  throw new Error("should not be called");
};

// A flow that publishes a validated template.
const publishingFlow: CreateTemplateFlow = async () =>
  ({
    template: { id: "template_x", orgId: ORG, repoRef: "cat-cave/ts", status: "validated", channel: "lts" },
    projectId: "project_x",
    researchSources: ["https://example.test/a"],
  }) as unknown as CreateTemplateResult;

// A flow whose template FAILED validation (the fail-closed gate fires).
const failingFlow: CreateTemplateFlow = async () => {
  throw new TemplateValidationFailedError("ts-pnpm", "project_x", {
    positiveControlsPassed: true,
    negativeControls: { typecheck: "unproven", lint: "proven", test: "proven", mutation: "n/a" },
    auditorClean: true,
    validatedAt: "2026-06-09T12:00:00.000Z",
    validatedSha: "f".repeat(40),
  });
};

describe("template creation trigger route — POST .../templates/create", () => {
  it("triggers the flow + returns 201 with the published template", async () => {
    const ch = createHarness(publishingFlow);
    const res = await req(ch.app, "POST", `/orgs/${ORG}/templates/create`, CREATE_REQUEST);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { template: { status: string }; projectId: string };
    expect(body.template.status).toBe("validated");
    expect(body.projectId).toBe("project_x");
  });

  it("surfaces a failed validation as a LOUD 422 (the fail-closed gate — never a publish)", async () => {
    const ch = createHarness(failingFlow);
    const res = await req(ch.app, "POST", `/orgs/${ORG}/templates/create`, CREATE_REQUEST);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("template_validation_failed");
  });

  it("denies a non-admin member (403)", async () => {
    const ch = createHarness(unreachableFlow, member);
    const res = await req(ch.app, "POST", `/orgs/${ORG}/templates/create`, CREATE_REQUEST);
    expect(res.status).toBe(403);
  });

  it("rejects a malformed create request (400)", async () => {
    const ch = createHarness(unreachableFlow);
    const res = await req(ch.app, "POST", `/orgs/${ORG}/templates/create`, { stack: "ts-pnpm" });
    expect(res.status).toBe(400);
  });
});
