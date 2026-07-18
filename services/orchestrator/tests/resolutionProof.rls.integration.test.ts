// cspell:ignore rproof iloop rdec
// bh-14a live proof: the resolution proof seal fires on the REAL authority path.
// A blocked (cosmetic-fix) walk seals a `blocked` proof; a real fix walked to an
// authorized decision then closed by the REAL source-sync worker seals an
// `authorized_verified_closed` proof. Both are read back through the GET route,
// re-verified against the live evidence, and shown tamper-evident + org-isolated.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createServer, type Server } from "node:http";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResolutionProofStore } from "../src/engine/governance/resolutionProofSealer.js";
import { createResolutionProofRoutes } from "../src/routes/issueLoops/resolutionProof.js";
import { drainSourceClose, PROOF_IDS, seedProofFixture, walkProduction } from "./helpers/resolutionProofFixture.js";

const describeDb = process.env["TANREN_RLS_DB_TEST"] === "1" ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const { org: ORG_ID, otherOrg: OTHER_ORG_ID, project: PROJECT_ID, loop: LOOP_ID, release: RELEASE_ID } = PROOF_IDS;

type ProofRouteEnv = {
  Variables: {
    actor?: {
      userId: string;
      orgId: string | null;
      projectId: string | null;
      scopes: "org:admin"[];
      source: "session";
    };
  };
};

function databaseName(): string {
  return `tanren_resolution_proof_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(database: string, appRole = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (appRole) {
    url.username = "tanren_app";
    url.password = APP_PASSWORD;
  }
  return url.toString();
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describeDb("resolution proof seal — live authority path, tamper-evidence, and RLS", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let server: Server;
  let baseUrl = "";
  let cosmeticFix = true;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
      const body =
        path === "/health"
          ? { status: "healthy" }
          : path === "/symptom"
            ? { status: cosmeticFix ? "still_broken" : "fixed" }
            : { status: "reachable" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("proof fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: databaseUrl(database, true) });
    await seedProofFixture(owner, baseUrl);
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
    await closeServer(server);
  }, 30_000);

  async function proofRoute(): Promise<Response> {
    const router = new Hono<ProofRouteEnv>();
    router.use("*", async (c, next) => {
      c.set("actor", {
        userId: "user_proof_reader",
        orgId: ORG_ID,
        projectId: null,
        scopes: ["org:admin"],
        source: "session",
      });
      await next();
    });
    router.route("/v1/orgs", createResolutionProofRoutes({ pool: app }));
    return router.request(`/v1/orgs/${ORG_ID}/projects/${PROJECT_ID}/issue-loops/${LOOP_ID}/proof`);
  }

  it("uses tanren_app without superuser or RLS-bypass privileges", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("seals both terminals on the real path, keeps badges separate, and reads them through GET", async () => {
    cosmeticFix = true;
    await walkProduction(app, "rjob_proof_cosmetic");
    cosmeticFix = false;
    await walkProduction(app, "rjob_proof_real_fix");
    expect(await drainSourceClose(app)).toBe(true);

    const persisted = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query<{ terminal: string; proof_hash: string }>(
        `SELECT terminal, proof_hash FROM resolution_proofs
          WHERE org_id = $1 AND issue_loop_id = $2 ORDER BY terminal`,
        [ORG_ID, LOOP_ID],
      ),
    );
    expect(persisted.rows.map((row) => row.terminal)).toEqual(["authorized_verified_closed", "blocked"]);

    const events = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query<{ payload: { proofHash: string } }>(
        "SELECT payload FROM events WHERE org_id = $1 AND event_type = 'resolution.proof.sealed' ORDER BY id",
        [ORG_ID],
      ),
    );
    expect(events.rows).toHaveLength(2);
    expect(new Set(events.rows.map((row) => row.payload.proofHash))).toEqual(
      new Set(persisted.rows.map((row) => row.proof_hash)),
    );

    const response = await proofRoute();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      proofs: Array<{
        terminal: string;
        proof: { badges: Record<string, string>; proofHash: string; entries: unknown[] };
        verification: { valid: boolean; divergedAt: string | null };
      }>;
    };
    expect(body.proofs).toHaveLength(2);
    for (const proof of body.proofs) {
      expect(proof.verification).toEqual({ valid: true, divergedAt: null, recomputedProofHash: proof.proof.proofHash });
      expect(proof.proof.entries).toHaveLength(10);
    }
    const blocked = body.proofs.find((proof) => proof.terminal === "blocked")!;
    const closed = body.proofs.find((proof) => proof.terminal === "authorized_verified_closed")!;
    // The decisive negative control: symptom failed WHILE gate/merged/deploy/demo stay green.
    expect(blocked.proof.badges).toEqual({
      gate: "passed",
      merged: "passed",
      deploy: "bound",
      demo: "reachable",
      symptom: "failed",
      source: "absent",
    });
    expect(closed.proof.badges).toEqual({
      gate: "passed",
      merged: "passed",
      deploy: "bound",
      demo: "reachable",
      symptom: "passed",
      source: "verified_closed",
    });
  });

  it("reports the proof invalid when a linked evidence row is tampered", async () => {
    const original = await runWithOrgScope(app, ORG_ID, (client) =>
      client.query<{ url: string }>("SELECT url FROM release_instances WHERE org_id = $1 AND id = $2", [
        ORG_ID,
        RELEASE_ID,
      ]),
    );
    await runWithOrgScope(app, ORG_ID, (client) =>
      client.query("UPDATE release_instances SET url = $3 WHERE org_id = $1 AND id = $2", [
        ORG_ID,
        RELEASE_ID,
        "https://tampered.example/app",
      ]),
    );
    const store = new ResolutionProofStore(app);
    const proofs = await store.listForLoop(ORG_ID, PROJECT_ID, LOOP_ID);
    expect(proofs).toHaveLength(2);
    for (const proof of proofs) {
      expect(proof.verification.valid).toBe(false);
      expect(proof.verification.divergedAt).toBe("deployment");
    }
    // Restore so the immutability + isolation assertions read the sealed truth.
    await runWithOrgScope(app, ORG_ID, (client) =>
      client.query("UPDATE release_instances SET url = $3 WHERE org_id = $1 AND id = $2", [
        ORG_ID,
        RELEASE_ID,
        original.rows[0]?.url ?? baseUrl,
      ]),
    );
    const restored = await store.listForLoop(ORG_ID, PROJECT_ID, LOOP_ID);
    for (const proof of restored) expect(proof.verification.valid).toBe(true);
  });

  it("rejects UPDATE and DELETE on the append-only proof ledger", async () => {
    await expect(
      runWithOrgScope(app, ORG_ID, (client) =>
        client.query("UPDATE resolution_proofs SET terminal = 'blocked' WHERE org_id = $1", [ORG_ID]),
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      runWithOrgScope(app, ORG_ID, (client) =>
        client.query("DELETE FROM resolution_proofs WHERE org_id = $1", [ORG_ID]),
      ),
    ).rejects.toThrow(/immutable/u);
  });

  it("does not expose one org's sealed proofs to another org", async () => {
    const invisible = await runWithOrgScope(app, OTHER_ORG_ID, (client) =>
      client.query("SELECT id FROM resolution_proofs WHERE org_id = $1", [ORG_ID]),
    );
    expect(invisible.rows).toEqual([]);
  });
});
