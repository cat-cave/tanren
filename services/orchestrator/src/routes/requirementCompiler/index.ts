/**
 * in-5: the requirement-compiler HTTP surface — the CALLABLE PRODUCER.
 *
 * `POST /:orgId/projects/:projectId/specs/:specId/compile-integration-requirements`
 * loads the spec's acceptance criteria + the project's HEAD DesignContract,
 * invokes the requirement-compiler LLM actor (the allocating Forge adapter —
 * same infra every Forge surface uses), validates + persists the compiled
 * `IntegrationRequirementV1` set org-scoped into `integration_requirements`
 * (migration 0043, FORCE RLS), and emits `integration.requirement.derived` per
 * requirement. The provisioner (in-8..12) reads the persisted set.
 *
 * PRODUCER DISCIPLINE (trap #1 — dead production trigger): the route IS the real
 * producer — an operator / dashboard / curl call drives it. There is no phantom
 * event listener; the wake is the HTTP request. The compile is intentionally
 * ON-DEMAND (a spec is compiled when an operator asks) rather than eagerly
 * auto-triggered; the automatic trigger (wire into the deriving/active lifecycle)
 * is the follow-up that builds on this callable surface.
 *
 * FAIL-CLOSED: a missing spec (404), a missing DesignContract (409 — the compile
 * REQUIRES the design intent, never a silent compile from G/W/T alone), or a
 * malformed LLM result (502 — `MalformedRequirementCompilerResultError`) all
 * surface explicitly. The 502 carries the per-candidate validation issues so the
 * operator sees WHICH field(s) the LLM got wrong.
 *
 * ORG-SCOPED (RLS): every read/write runs on the request's scoped pool — the
 * spec read, the contract read, the requirement persist, and the event append all
 * carry the request's `app.current_org_id` GUC. An off-scope actor gets 403 before
 * any query; a same-org-but-wrong-project read returns the typed empty state.
 */

import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import { runWithOrgScope } from "@tanren/db";
import { DesignContractStore } from "../../engine/repositories/designContracts.js";
import {
  IntegrationRequirementStore,
  type CompiledRequirementRecord,
} from "../../engine/repositories/integrationRequirements.js";
import { SpecStore } from "../../engine/repositories/specs.js";
import type { RequirementCompilerActor } from "../../engine/workflow/requirementCompiler/requirementCompiler.js";
import {
  createRequirementCompilerActor,
  MalformedRequirementCompilerResultError,
} from "../../engine/workflow/requirementCompiler/requirementCompiler.js";
import { forgeAllocatingAnswererAdapter, type ForgeAnswererInfra } from "../../engine/forge/providerFactory.js";
import type { RequirementCompilerAnswer } from "../../engine/answerers/schemas/requirementCompiler.js";
import { PgEventStore, type EventStore } from "../../engine/eventStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

export interface RequirementCompilerRouteOptions {
  pool: pg.Pool;
  /**
   * The allocating Forge infra (shared across every Forge surface). Production builds
   * the adapter via `forgeAllocatingAnswererAdapter`; tests inject an `answererFactory`
   * to bypass the real provider. Exactly one of `forgeInfra` / `answererFactory` is
   * required (validated at construction).
   */
  forgeInfra?: ForgeAnswererInfra;
  /** Test-only override — bypasses the allocating adapter entirely. */
  answererFactory?: (target: { orgId: string; projectId: string }) => RequirementCompilerActor;
  /** Injected for tests; production uses the sole `PgEventStore(pool)`. */
  eventStore?: EventStore;
}

export function createRequirementCompilerRoutes(options: RequirementCompilerRouteOptions): Hono<ActorContextEnv> {
  const forgeInfra = options.forgeInfra;
  const injectedFactory = options.answererFactory;
  if (forgeInfra === undefined && injectedFactory === undefined) {
    throw new Error(
      "createRequirementCompilerRoutes: either forgeInfra (production) or answererFactory (tests) is required",
    );
  }
  // After the guard above, if `injectedFactory` is undefined then `forgeInfra` is
  // defined — but TypeScript cannot narrow across the OR, so the production arm
  // re-checks `forgeInfra !== undefined` explicitly (no unchecked `!` assertion,
  // trap #10).
  const answererFactory: (target: { orgId: string; projectId: string }) => RequirementCompilerActor =
    injectedFactory ??
    ((target) => {
      if (forgeInfra === undefined) {
        throw new Error("createRequirementCompilerRoutes: forgeInfra is required when answererFactory is absent");
      }
      return createRequirementCompilerActor(
        forgeAllocatingAnswererAdapter<RequirementCompilerAnswer>(forgeInfra, target),
      );
    });
  const app = new Hono<ActorContextEnv>();
  const eventStore = options.eventStore ?? new PgEventStore(options.pool);

  app.post("/:orgId/projects/:projectId/specs/:specId/compile-integration-requirements", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    const specId = c.req.param("specId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }

    // The compile runs org-scoped: the spec read, the contract read, the
    // requirement persist, and the event append all carry the request's org GUC.
    // A 404 / 409 / 502 short-circuits BEFORE any persist — no orphan rows.
    try {
      const result = await runWithOrgScope(options.pool, orgId, async (client) => {
        // 1. Load the spec (G/W/T source). SpecStore.get is org-scoped under RLS.
        const spec = await SpecStore.get(client, specId, { kind: "operator" });
        if (spec === undefined || spec.projectId !== projectId) {
          return { kind: "spec_not_found" as const };
        }

        // 2. Load the project's HEAD DesignContract (the intent source). The
        // compile REQUIRES a contract — a missing contract is a 409 (the compile
        // cannot reason over design intent that does not exist), never a silent
        // compile from G/W/T alone. A CORRUPT contract row throws LOUDLY (the
        // store's typed `DesignContractCorruptError`) — never a silent skip.
        const lookup = await DesignContractStore.getLatestState(client, projectId, { kind: "operator" });
        if (lookup.kind === "absent") {
          return { kind: "contract_absent" as const };
        }
        if (lookup.kind === "corrupt") {
          throw lookup.error;
        }
        const contractRecord = lookup.record;

        // 3. Invoke the requirement-compiler actor (the allocating Forge adapter).
        // The actor builds the prompt, calls the LLM, and re-validates every
        // candidate via `parseIntegrationRequirement`. A malformed result throws
        // `MalformedRequirementCompilerResultError` (the route maps it to 502).
        const compilerActor = answererFactory({ orgId, projectId });
        const compiled = await compilerActor.compile({
          projectId,
          specId,
          specTitle: spec.title,
          specDescription: spec.description,
          acceptanceCriteria: spec.acceptanceCriteria,
          designContract: contractRecord.contract,
          designContractVersion: contractRecord.version,
          designContractId: contractRecord.id,
        });

        // 4. Persist the compiled requirements org-scoped. The store's ON
        // CONFLICT DO NOTHING makes a re-compile of the SAME contract idempotent.
        const persisted = await IntegrationRequirementStore.compile(
          client,
          {
            orgId,
            projectId,
            sourceRevisionId: contractRecord.id,
            requirements: compiled.requirements,
          },
          { kind: "operator" },
        );

        // 5. Emit `integration.requirement.derived` for each persisted row.
        // Events append ONLY through the sole PgEventStore (Brief invariant).
        // PROOF = EFFECT: the typed enum values come from the parsed
        // `IntegrationRequirementV1` (the same object persisted to desired_state),
        // NOT from the untyped DB column strings (trap #10 — unchecked cast).
        for (const row of persisted) {
          await eventStore.append({
            orgId,
            projectId,
            specId,
            eventType: "integration.requirement.derived",
            payload: {
              requirementId: row.id,
              capability: row.desiredState.capability,
              plane: row.desiredState.plane,
              direction: row.desiredState.direction,
              criticality: row.desiredState.criticality,
              sourceKind: "design_contract",
              sourceRevisionId: row.sourceRevisionId,
              desiredStateHash: row.sourceDigest,
            },
          });
        }

        return {
          kind: "compiled" as const,
          persisted,
          rationale: compiled.rationale,
          contractVersion: contractRecord.version,
          contractId: contractRecord.id,
        };
      });

      if (result.kind === "spec_not_found") {
        return c.json({ error: "spec_not_found", missionNodeId: "in-5" }, 404);
      }
      if (result.kind === "contract_absent") {
        return c.json(
          {
            error: "design_contract_absent",
            missionNodeId: "in-5",
            message:
              "The project has no HEAD DesignContract. Run the design phase first — the compile requires the design intent.",
          },
          409,
        );
      }

      return c.json({
        ok: true as const,
        missionNodeId: "in-5" as const,
        orgId,
        projectId,
        specId,
        contractVersion: result.contractVersion,
        contractId: result.contractId,
        rationale: result.rationale,
        requirementCount: result.persisted.length,
        requirements: result.persisted.map(serializeRecord),
      });
    } catch (error) {
      // A malformed LLM result → 502 (the upstream LLM produced garbage). The
      // typed error carries the per-candidate validation issues so the operator
      // sees WHICH field(s) were wrong, not a generic "compile failed".
      if (error instanceof MalformedRequirementCompilerResultError) {
        return c.json(
          {
            ok: false as const,
            missionNodeId: "in-5" as const,
            error: "malformed_requirement_compiler_result",
            detail: error.detail,
            projectId: error.projectId,
            specId: error.specId,
          },
          502,
        );
      }
      throw error;
    }
  });
  return app;
}

function serializeRecord(row: CompiledRequirementRecord): Record<string, unknown> {
  return {
    id: row.id,
    capability: row.desiredState.capability,
    plane: row.desiredState.plane,
    direction: row.desiredState.direction,
    criticality: row.desiredState.criticality,
    sourceDigest: row.sourceDigest,
    createdAt: row.createdAt,
  };
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
