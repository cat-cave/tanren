// Tests for the template-MAINTENANCE wave (docs/roadmap/templating-system.md §4):
//   1. the CHANNEL POLICY — lts rejects a pre-release bump, nightly accepts it;
//      lts re-checks monthly, nightly nightly (the cadence difference).
//   2. the DEGRADED-MARKING (freshness) — a proof past the horizon / an open P0/P1
//      degrades; a fresh green proof does not.
//   3. the NIGHTLY→LTS GRADUATION GATE — green+aged ⇒ eligible; not-green / not-aged
//      / unvalidated ⇒ not.
//   4. the MAINTENANCE PASS over a registry — a re-validated GREEN template refreshes
//      its validationProof; a planted REGRESSION marks the template degraded + files a
//      regression finding (NOT shipped).
//
// The loop is driven against an in-memory template store + a SCRIPTED revalidator
// (no live runner, no harness), mirroring the scheduledAudits stub-pool pattern. The
// finding-routing reuse is asserted by spying the auto-route deps the loop hands the
// scheduled-audit hand-off.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  channelAcceptsVersion,
  CHANNEL_CADENCE_MS,
  eligibleToGraduate,
  graduationDecision,
  isPrerelease,
  proofExpired,
  runMaintenancePass,
  shouldDegrade,
  TemplateMaintenanceLoop,
  templateValidates,
  type MaintainableTemplate,
  type TemplateManifestV1,
  type TemplateRevalidator,
  type TemplateValidationProof,
} from "../src/engine/templates/index.js";
import type { Template } from "../src/engine/repositories/templates.js";
import type { AutoRouteDeps } from "../src/engine/forge/inbox/engine.js";
import { createDeterministicTriageAnswerer } from "./fixtures/forge/deterministicTriageAnswerer.js";

// ---- proof fixtures --------------------------------------------------------

function greenProof(validatedAt: string): TemplateValidationProof {
  return {
    positiveControlsPassed: true,
    negativeControls: { typecheck: "proven", lint: "proven", test: "proven", mutation: "n/a" },
    auditorClean: true,
    validatedAt,
    validatedSha: "a".repeat(40),
  };
}

function redProof(validatedAt: string): TemplateValidationProof {
  // typecheck regressed to a no-op (the v29 mode) — a DECLARED control unproven.
  return {
    positiveControlsPassed: true,
    negativeControls: { typecheck: "unproven", lint: "proven", test: "proven", mutation: "n/a" },
    auditorClean: true,
    validatedAt,
    validatedSha: "b".repeat(40),
  };
}

function manifest(channel: "lts" | "nightly", proof: TemplateValidationProof | null): TemplateManifestV1 {
  return {
    version: 1,
    stack: "ts-pnpm",
    capabilities: {
      runtime: "node",
      packageManager: "pnpm",
      gates: ["tier-1", "tier-2", "tier-3"],
      bdd: true,
      mutation: false,
      junit: true,
    },
    channel,
    templateVersion: "1.0.0",
    provenance: { researchSources: ["https://nodejs.org/en/about/releases"] },
    validationProof: proof,
  };
}

// ====================================================================================
// 1. Channel policy
// ====================================================================================

describe("channel policy — which versions each channel accepts + cadence", () => {
  it("lts REJECTS a pre-release bump; nightly ACCEPTS it", () => {
    // A semver pre-release suffix.
    expect(channelAcceptsVersion("lts", "20.0.0-rc.1")).toBe(false);
    expect(channelAcceptsVersion("nightly", "20.0.0-rc.1")).toBe(true);
    // A pre-release WORD label (date-nightly).
    expect(channelAcceptsVersion("lts", "2026-06-09-nightly")).toBe(false);
    expect(channelAcceptsVersion("nightly", "2026-06-09-nightly")).toBe(true);
  });

  it("lts ACCEPTS a stable release; nightly accepts it too", () => {
    expect(channelAcceptsVersion("lts", "20.11.0")).toBe(true);
    expect(channelAcceptsVersion("lts", "v18.20.0")).toBe(true);
    expect(channelAcceptsVersion("nightly", "20.11.0")).toBe(true);
  });

  it("isPrerelease reads a generic, stack-agnostic pre-release marker (no semver parse)", () => {
    expect(isPrerelease("1.2.3")).toBe(false);
    // a dash in a non-version prefix is not a pre-release
    expect(isPrerelease("my-stack-1.0")).toBe(false);
    expect(isPrerelease("1.2.3-beta")).toBe(true);
    expect(isPrerelease("3.0.0-alpha.2")).toBe(true);
    expect(isPrerelease("nightly-2026.06")).toBe(true);
    expect(isPrerelease("2.0.0-canary")).toBe(true);
  });

  it("nightly re-checks faster than lts (the cadence difference)", () => {
    expect(CHANNEL_CADENCE_MS.nightly).toBeLessThan(CHANNEL_CADENCE_MS.lts);
    expect(CHANNEL_CADENCE_MS.nightly).toBe(24 * 60 * 60_000);
    expect(CHANNEL_CADENCE_MS.lts).toBe(30 * 24 * 60 * 60_000);
  });
});

// ====================================================================================
// 2. Degraded marking (freshness)
// ====================================================================================

describe("degraded marking — freshness horizon + open P0/P1", () => {
  const now = new Date("2026-06-09T00:00:00.000Z");

  it("a fresh green proof does NOT degrade", () => {
    // 1 day old
    const proof = greenProof("2026-06-08T00:00:00.000Z");
    expect(proofExpired(proof, now)).toBe(false);
    expect(shouldDegrade({ proof, openBlockingFindings: 0, now })).toBe(false);
  });

  it("a proof past the freshness horizon DEGRADES", () => {
    // ~5 months old > 45-day horizon
    const proof = greenProof("2026-01-01T00:00:00.000Z");
    expect(proofExpired(proof, now)).toBe(true);
    expect(shouldDegrade({ proof, openBlockingFindings: 0, now })).toBe(true);
  });

  it("an open P0/P1 finding DEGRADES even on a fresh proof", () => {
    const proof = greenProof("2026-06-08T00:00:00.000Z");
    expect(shouldDegrade({ proof, openBlockingFindings: 1, now })).toBe(true);
  });

  it("a null proof (unvalidated) is fail-closed: degraded", () => {
    expect(proofExpired(null, now)).toBe(true);
    expect(shouldDegrade({ proof: null, openBlockingFindings: 0, now })).toBe(true);
  });

  it("an undateable validatedAt is fail-closed: expired", () => {
    const proof = { ...greenProof("not-a-date"), validatedAt: "not-a-date" };
    expect(proofExpired(proof, now)).toBe(true);
  });

  it("a tight horizon override expires a younger proof", () => {
    // 1 day old, checked against a 12h horizon
    const proof = greenProof("2026-06-08T00:00:00.000Z");
    expect(proofExpired(proof, now, 12 * 60 * 60_000)).toBe(true);
  });
});

// ====================================================================================
// 3. Nightly→lts graduation gate
// ====================================================================================

describe("nightly→lts graduation gate — green + aged ⇒ eligible", () => {
  const now = new Date("2026-06-09T00:00:00.000Z");

  it("a GREEN proof aged past the window is ELIGIBLE", () => {
    // > 7-day window
    const proof = greenProof("2026-05-01T00:00:00.000Z");
    expect(eligibleToGraduate({ proof, now })).toBe(true);
    expect(graduationDecision({ proof, now }).reason).toBeUndefined();
  });

  it("a GREEN proof that has NOT aged is NOT eligible (not-aged)", () => {
    // 1 day old < 7-day window
    const proof = greenProof("2026-06-08T00:00:00.000Z");
    const decision = graduationDecision({ proof, now });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("not-aged");
  });

  it("a RED proof is NOT eligible regardless of age (validation-not-green)", () => {
    // old but RED
    const proof = redProof("2026-01-01T00:00:00.000Z");
    expect(templateValidates(proof)).toBe(false);
    const decision = graduationDecision({ proof, now });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("validation-not-green");
  });

  it("a null proof is NOT eligible (unvalidated)", () => {
    expect(graduationDecision({ proof: null, now }).reason).toBe("unvalidated");
  });

  it("a tight aging override graduates a younger green proof", () => {
    // 1 day old, checked against a 1-min aging window
    const proof = greenProof("2026-06-08T00:00:00.000Z");
    expect(eligibleToGraduate({ proof, now, agingMs: 60_000 })).toBe(true);
  });
});

// ====================================================================================
// 4. Maintenance pass + loop over a registry
// ====================================================================================

// A scripted revalidator: returns a chosen proof for the (only) template.
function scriptedRevalidator(proof: TemplateValidationProof): TemplateRevalidator {
  return { revalidate: async () => proof };
}

const maintainable: MaintainableTemplate = {
  id: "template_x",
  orgId: "org_1",
  repoRef: "cat-cave/ts-pnpm",
  manifest: manifest("nightly", greenProof("2026-04-01T00:00:00.000Z")),
};

describe("runMaintenancePass — green refresh vs planted regression", () => {
  it("a GREEN re-validation produces a refreshed proof + NO finding", async () => {
    const fresh = greenProof("2026-06-09T12:00:00.000Z");
    const outcome = await runMaintenancePass(scriptedRevalidator(fresh), maintainable);
    expect(outcome.validated).toBe(true);
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.nextManifest.validationProof).toEqual(fresh);
  });

  it("a planted REGRESSION (unproven gate) → not validated + ONE stable-keyed finding", async () => {
    const red = redProof("2026-06-09T12:00:00.000Z");
    const outcome = await runMaintenancePass(scriptedRevalidator(red), maintainable);
    expect(outcome.validated).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0]!;
    // A regressed template is a BLOCKING defect on the shared P0–P3 ladder ⇒ P0.
    expect(finding.severity).toBe("P0");
    // Stable key so re-running maintenance upserts the SAME candidate (idempotent).
    expect(finding.externalId).toBe(`template-maintenance:${maintainable.id}`);
    expect(finding.body).toContain("typecheck");
  });
});

// ---- the loop drives the registry: refresh green / degrade+file red ----

// An in-memory template registry the loop reads/writes through the store SQL the
// loop calls. We key on the SQL the TemplateStore issues (DISTINCT org_ids, list,
// updateManifest), plus the inbox upsert path the regression finding routes through.
function registryPool(template: Template): {
  pool: pg.Pool;
  current: () => Template;
  candidates: () => Map<string, Record<string, unknown>>;
} {
  let row: Template = template;
  const candidates = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, Record<string, unknown>>();

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();

    // ---- transaction control (org-scope helpers issue these) ----
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL app.current_org_id")) {
      return { rows: [], rowCount: 0 };
    }

    // ---- templates ----
    if (sql.includes("SELECT DISTINCT org_id FROM templates")) {
      return { rows: [{ org_id: row.orgId }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM templates ORDER BY created_at DESC")) {
      return { rows: [templateRow(row)], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE templates SET manifest")) {
      // updateManifest → params [id, manifestJson, channel, status]
      const manifestJson = JSON.parse(String(params[1])) as TemplateManifestV1;
      const status = String(params[3]) as Template["status"];
      row = { ...row, manifest: manifestJson, channel: manifestJson.channel, status };
      return { rows: [templateRow(row)], rowCount: 1 };
    }

    // ---- inbox source find-or-create (the regression-finding routing) ----
    if (sql.startsWith("SELECT") && sql.includes("FROM inbox_sources WHERE org_id")) {
      const list = [...sources.values()].filter((s) => s.org_id === params[0]);
      return { rows: list, rowCount: list.length };
    }
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, , enabled, autoRoute] = params as (string | null)[];
      const src = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: {},
        enabled,
        auto_route: autoRoute,
      };
      sources.set(String(id), src);
      return { rows: [src], rowCount: 1 };
    }

    // ---- existing-specs read (DiscoveryStore.listExistingSpecs) ----
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return { rows: [], rowCount: 0 };
    }

    // ---- candidate upsert ----
    if (sql.startsWith("INSERT INTO candidates")) {
      const [
        id,
        sourceId,
        orgId,
        projectId,
        externalId,
        title,
        body,
        severity,
        status,
        triage,
        sourceName,
        sourceKind,
      ] = params as (string | null)[];
      const key = `${sourceId}::${externalId}`;
      const cid = String(id);
      const candidate = {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status,
        triage: JSON.parse(String(triage)),
        resolved_spec_id: null,
        source_name: sourceName,
        source_kind: sourceKind,
      };
      candidates.set(key, candidate);
      return { rows: [candidate], rowCount: 1 };
    }
    // Any other read: empty.
    return { rows: [], rowCount: 0 };
  };

  const pool = {
    query: (text: string, params?: unknown[]) => query(text, params),
    connect: async () => ({ query, release() {} }),
  } as unknown as pg.Pool;
  return { pool, current: () => row, candidates: () => candidates };
}

function templateRow(t: Template): Record<string, unknown> {
  return {
    id: t.id,
    org_id: t.orgId,
    repo_ref: t.repoRef,
    manifest: t.manifest,
    status: t.status,
    channel: t.channel,
  };
}

// The deterministic triage answerer auto-routes a scheduled-audit (system) source's
// finding — the same fixture the scheduledAudits tests drive. autoRoute is left
// undefined: the finding rests `auto_routed` in the inbox (no DAG commit needed to
// prove the regression was filed, not shipped).
const noAutoRoute = undefined as unknown as AutoRouteDeps;

function makeLoop(pool: pg.Pool, now: () => number): TemplateMaintenanceLoop {
  return new TemplateMaintenanceLoop({
    pool,
    revalidator: { revalidate: async () => greenProof(new Date(now()).toISOString()) },
    answererFactory: () => createDeterministicTriageAnswerer(),
    autoRoute: noAutoRoute,
    now,
  });
}

describe("TemplateMaintenanceLoop.tick — refresh green, degrade+file red", () => {
  // A clock far past the template's last validatedAt so it is DUE.
  const nowMs = Date.parse("2026-06-09T00:00:00.000Z");

  it("a GREEN re-validation refreshes the proof + keeps the template validated (NOT degraded)", async () => {
    const seed: Template = {
      id: "template_x",
      orgId: "org_1",
      repoRef: "cat-cave/ts-pnpm",
      // last validated 2026-04-01 — well past the nightly (24h) cadence ⇒ due
      manifest: manifest("nightly", greenProof("2026-04-01T00:00:00.000Z")),
      status: "validated",
      channel: "nightly",
    };
    const reg = registryPool(seed);
    const loop = makeLoop(reg.pool, () => nowMs);
    const results = await loop.tick();

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("validated");
    expect(results[0]!.filedFinding).toBe(false);
    // The persisted proof was refreshed to the new validatedAt.
    expect(reg.current().status).toBe("validated");
    expect(reg.current().manifest.validationProof?.validatedAt).toBe(new Date(nowMs).toISOString());
  });

  it("a RED re-validation marks the template DEGRADED + files a regression finding (NOT shipped)", async () => {
    const seed: Template = {
      id: "template_x",
      orgId: "org_1",
      repoRef: "cat-cave/ts-pnpm",
      manifest: manifest("nightly", greenProof("2026-04-01T00:00:00.000Z")),
      status: "validated",
      channel: "nightly",
    };
    const reg = registryPool(seed);
    const loop = new TemplateMaintenanceLoop({
      pool: reg.pool,
      // The harness now reports a regression (typecheck went no-op).
      revalidator: { revalidate: async () => redProof(new Date(nowMs).toISOString()) },
      answererFactory: () => createDeterministicTriageAnswerer(),
      autoRoute: noAutoRoute,
      now: () => nowMs,
    });
    const results = await loop.tick();

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("degraded");
    expect(results[0]!.validated).toBe(false);
    expect(results[0]!.filedFinding).toBe(true);
    // The registry row is DEGRADED — selection (which filters degraded) stops choosing it.
    expect(reg.current().status).toBe("degraded");
    // A regression candidate was routed into the inbox (the DAG re-entry hand-off),
    // keyed on the stable maintenance externalId.
    const routed = [...reg.candidates().values()];
    expect(routed).toHaveLength(1);
    expect(String(routed[0]!.external_id)).toContain("template-maintenance:template_x");
  });

  it("a template whose proof is still within its channel cadence is NOT re-validated (not due)", async () => {
    const seed: Template = {
      id: "template_y",
      orgId: "org_1",
      repoRef: "cat-cave/ts-pnpm",
      // validated 1 hour ago — well within the nightly (24h) cadence.
      manifest: manifest("nightly", greenProof(new Date(nowMs - 60 * 60_000).toISOString())),
      status: "validated",
      channel: "nightly",
    };
    const reg = registryPool(seed);
    const loop = makeLoop(reg.pool, () => nowMs);
    const results = await loop.tick();
    expect(results).toHaveLength(0);
  });
});
