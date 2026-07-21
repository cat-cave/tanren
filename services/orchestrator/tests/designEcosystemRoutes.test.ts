// ds-8 command/public route gates driven through the real Hono route factories.

import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  DesignEcosystemError,
  type DesignEcosystemResult,
} from "../src/engine/design/system/designEcosystemService.js";
import type { DesignPublicationV1 } from "../src/engine/design/system/designEcosystemContracts.js";
import { createDesignEcosystemRoutes, createDesignPublicRoutes } from "../src/routes/designStudio/ecosystem.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const ADMIN: ActorContext = {
  userId: "admin_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};
const MEMBER: ActorContext = {
  userId: "member_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function appFor(actor: ActorContext, result?: DesignEcosystemResult) {
  const service = {
    execute: vi.fn<(input: unknown) => Promise<DesignEcosystemResult>>(
      async () => result ?? { kind: "share_created" as const, shareId: "share_a", publicationId: "pub_a" },
    ),
    readPublic: vi.fn<(publicationId: string) => Promise<DesignPublicationV1>>(async () => ({
      version: 1 as const,
      schemaVersion: "design_publication.v1" as const,
      publicationId: "pub_a",
      publicSlug: "console",
      releaseDigest: DIGEST,
      manifestDigest: DIGEST,
      safePreviewDigest: DIGEST,
      license: "MIT",
      attribution: { notice: "example" },
      state: "published" as const,
    })),
  };
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  const options = { pool: {} as pg.Pool, service };
  app.route("/v1/orgs", createDesignEcosystemRoutes(options));
  app.route("/v1", createDesignPublicRoutes(options));
  return { app, service };
}

describe("Design ecosystem production command route", () => {
  it("requires an org admin and nonblank Idempotency-Key before dispatch", async () => {
    const member = appFor(MEMBER);
    const denied = await member.app.request("/v1/orgs/org_a/design-ecosystem/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "x" },
      body: JSON.stringify({ type: "revoke_publication", publicationId: "pub_a" }),
    });
    expect(denied.status).toBe(403);
    expect(member.service.execute).not.toHaveBeenCalled();

    const admin = appFor(ADMIN);
    const missing = await admin.app.request("/v1/orgs/org_a/design-ecosystem/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "revoke_publication", publicationId: "pub_a" }),
    });
    expect(missing.status).toBe(400);
    expect(admin.service.execute).not.toHaveBeenCalled();
  });

  it("rejects an unknown/blank bearer body before the service can persist anything", async () => {
    const { app, service } = appFor(ADMIN);
    const response = await app.request("/v1/orgs/org_a/design-ecosystem/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "redeem-a" },
      body: JSON.stringify({
        type: "redeem_share",
        grantId: "grant_a",
        publicationId: "pub_a",
        releaseDigest: DIGEST,
        bearerToken: "  ",
        grantExpiresAt: "2030-01-01T00:00:00.000Z",
      }),
    });
    expect(response.status).toBe(400);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("maps an expired/revoked redemption to opaque 404 and never reflects the bearer", async () => {
    const { app, service } = appFor(ADMIN);
    service.execute.mockRejectedValueOnce(new DesignEcosystemError("not_found", "share token unavailable"));
    const bearer = "bearer-value-never-in-response-0123456789";
    const response = await app.request("/v1/orgs/org_a/design-ecosystem/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "redeem-b" },
      body: JSON.stringify({
        type: "redeem_share",
        grantId: "grant_a",
        publicationId: "pub_a",
        releaseDigest: DIGEST,
        bearerToken: bearer,
        grantExpiresAt: "2030-01-01T00:00:00.000Z",
      }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(bearer);
  });

  it("serves the sanitized projection only; it has no public byte/download surface", async () => {
    const { app } = appFor(ADMIN);
    const response = await app.request("/v1/public/design-system-releases/pub_a");
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("safePreviewDigest");
    expect(body).not.toMatch(/artifactId|objectStore|download|orgId/iu);
    expect((await app.request("/v1/public/design-system-releases/pub_a/download")).status).toBe(404);
  });
});
