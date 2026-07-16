// in-2: decode + visible UI for integration-contract panel on overview.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeIntegrationCatalog,
  decodeValidateFail,
  decodeValidateOk,
  type IntegrationContractCatalog,
  type IntegrationValidateOk,
} from "../src/api/integrationContracts.js";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};

const CATALOG: IntegrationContractCatalog = {
  missionNodeId: "in-2",
  version: 1,
  planes: ["control", "product"],
  directions: ["inbound", "outbound", "bidirectional"],
  environments: ["test", "preview", "production"],
  criticalities: ["merge_required", "release_required", "best_effort"],
  controlCapabilities: ["control.notify", "control.inbox", "deploy.release"],
  productCapabilities: ["messaging.send", "errors.capture", "auth.oauth"],
  controlBindingKinds: ["control.notify.bot_token_ref"],
  productBindingKinds: ["product.messaging.relay_binding_id"],
  allBindingKinds: ["control.notify.bot_token_ref", "product.messaging.relay_binding_id"],
  domainTag: "integration_requirement.v1",
  mediaType: "application/vnd.tanren.integration-requirement.v1+json",
};

const VALIDATE_OK: IntegrationValidateOk = {
  ok: true,
  missionNodeId: "in-2",
  orgId: "org_acme",
  persisted: true,
  requirementDigest: `sha256:${"11".repeat(32)}`,
  artifact: {
    digest: `sha256:${"22".repeat(32)}`,
    byteSize: 128,
    mediaType: "application/vnd.tanren.integration-requirement.v1+json",
  },
  capability: "messaging.send",
  plane: "product",
  direction: "outbound",
  criticality: "release_required",
};

const VALIDATE_CONTROL: IntegrationValidateOk = {
  ...VALIDATE_OK,
  capability: "control.notify",
  plane: "control",
  criticality: "best_effort",
  requirementDigest: `sha256:${"33".repeat(32)}`,
  artifact: {
    digest: `sha256:${"44".repeat(32)}`,
    byteSize: 96,
    mediaType: "application/vnd.tanren.integration-requirement.v1+json",
  },
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

let catalogMode: "ok" | "down" = "ok";
/** R3: captures every validate request body the dashboard issues. */
const validateCalls: Array<{ requirement?: unknown; persist?: boolean }> = [];

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), {
        status: 200,
      });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (url.includes("integration-contracts/catalog")) {
      if (catalogMode === "down") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(CATALOG), { status: 200 });
    }
    if (url.includes("integration-contracts:validate")) {
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
      validateCalls.push({ requirement: body.requirement, persist: body.persist });
      const req = body.requirement as { plane?: string; bindingOutputs?: Array<{ kind: string }> };
      const kinds = req?.bindingOutputs?.map((b) => b.kind) ?? [];
      if (req?.plane === "product" && kinds.some((k) => k.startsWith("control."))) {
        return new Response(
          JSON.stringify({
            ok: false,
            missionNodeId: "in-2",
            errors: [
              {
                path: "bindingOutputs[0].kind",
                code: "binding_plane_mismatch",
                message: "control binding on product plane",
              },
            ],
          }),
          { status: 422 },
        );
      }
      if (req?.plane === "control") {
        // R3: mirror the honest persisted state the server would return.
        return new Response(JSON.stringify({ ...VALIDATE_CONTROL, persisted: body.persist === true }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ...VALIDATE_OK, persisted: body.persist === true }), {
        status: 200,
      });
    }
    if (/\/orgs\/[^/]+\/budget(\?|$)/u.test(url)) {
      return new Response(JSON.stringify({ ceilingUsd: 100, period: "monthly" }), { status: 200 });
    }
    if (url.includes("/projects")) {
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  catalogMode = "ok";
  validateCalls.length = 0;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("decode integration contracts", () => {
  it("accepts strict catalog + validate ok/fail", () => {
    expect(decodeIntegrationCatalog(CATALOG)?.missionNodeId).toBe("in-2");
    expect(decodeValidateOk(VALIDATE_OK)?.requirementDigest).toMatch(/^sha256:/u);
    expect(
      decodeValidateFail({
        ok: false,
        missionNodeId: "in-2",
        errors: [{ path: "x", code: "y", message: "z" }],
      })?.errors[0]?.code,
    ).toBe("y");
  });

  it("rejects wrong mission node", () => {
    expect(decodeIntegrationCatalog({ ...CATALOG, missionNodeId: "in-1" })).toBeUndefined();
    expect(decodeValidateOk({ ...VALIDATE_OK, missionNodeId: "gv-4" })).toBeUndefined();
  });
});

describe("IntegrationContractPanel on overview (visible UI)", () => {
  it("renders live catalog + product/control/cross-plane outcomes", async () => {
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain('data-in2="panel"');
    expect(html).toContain("integration contracts (in-2)");
    expect(html).toContain('data-in2="catalog"');
    expect(html).toContain("integration_requirement.v1");
    expect(html).toContain('data-in2="sample-product"');
    expect(html).toContain('data-in2="sample-control"');
    expect(html).toContain('data-in2="sample-cross-plane"');
    expect(html).toContain("binding_plane_mismatch");
    expect(html).toContain('data-in2-state="invalid"');
  });

  it("overview samples validate with persist:false (zero CAS writes on page load)", async () => {
    const app = await build();
    await app.request("/overview");
    // R3: every live sample from the overview read path must opt out of persistence.
    expect(validateCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of validateCalls) {
      expect(call.persist).toBe(false);
    }
  });

  it("panel renders the honest checked-not-persisted state for samples", async () => {
    const app = await build();
    const html = await (await app.request("/overview")).text();
    // R3: persisted:false samples render the explicit "not persisted" marker,
    // never a false "durable CAS artifact" claim.
    expect(html).toContain("checked · not persisted");
  });

  it("renders loud unavailable when catalog upstream fails", async () => {
    catalogMode = "down";
    const app = await build();
    const html = await (await app.request("/overview")).text();
    expect(html).toContain('data-in2="panel"');
    expect(html).toContain("catalog unavailable");
  });
});
