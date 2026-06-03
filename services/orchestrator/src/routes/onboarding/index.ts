// P3-0015 greenfield-onboarding HTTP routes (vision interview → derive).
//
//   POST /:orgId/onboarding/interview/round
//     Body: { round, answer, capture }. Runs ONE interview round over the
//     injectable answerer and returns the next question + the updated capture.
//     Persists nothing — the surface re-submits the running capture (pause/
//     resume = stash it client-side), so there is no interview-session table.
//
//   POST /:orgId/onboarding/interview/derive
//     Body: { capture, repoUrl? }. On completion, derives the product graph —
//     project + personas/behaviors/milestones/specs — through the existing
//     P2A-0018/0013 creation paths and returns the new project + derived ids.
//     The DAG is then read back via the existing P3-0013 project-DAG endpoint.
//
// The answerer is resolved per-request from the request's org via
// `answererFactory(target)` — production wires `buildForgeInterviewAnswererFactory`
// (a REAL provider answerer that derives personas/behaviors/milestones with a
// model); tests inject a fake. Greenfield onboarding has no project yet, so the
// answerer resolves the ORG's default LLM credential. There is no deterministic
// fallback (§8a). Mounted on the same `/orgs` base as the other product routes.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import {
  deriveFromCapture,
  InterviewCapture,
  runRound,
  type InterviewAnswerer,
} from "../../engine/forge/interview/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecNotFoundError,
} from "../../engine/workflow/projectSpec.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface OnboardingRoutesOptions {
  pool: pg.Pool;
  // The interview answerer factory, called per-request with the request's org so
  // the answerer resolves the org's default `forge`/LLM credential (greenfield —
  // no project exists yet). Production passes `buildForgeInterviewAnswererFactory`
  // (a real provider answerer); tests pass a fake. REQUIRED — no fallback.
  answererFactory: (target: ForgeAnswererTarget) => InterviewAnswerer;
}

const RoundBody = z
  .object({
    round: z.number().int().min(1).max(100),
    answer: z.string().max(8000).default(""),
    capture: InterviewCapture.default(InterviewCapture.parse({})),
  })
  .strict();

const DeriveBody = z
  .object({
    capture: InterviewCapture,
    repoUrl: z.string().min(1).max(400).optional(),
    // GREENFIELD AUTONOMY: how the derived project is governed at creation. When
    // `auto`/`simulated`, the project lands ALREADY autonomous (a `native_queue`
    // merge engine + the matching review policy) so the DagWalker can advance it
    // off an empty repo with NO follow-up PATCH. Absent or `human` ⇒ the schema's
    // safe defaults (human review, `not_configured` merge), unchanged — the
    // brownfield/managed default.
    autonomy: z.enum(["auto", "simulated", "human"]).optional(),
  })
  .strict();

export function createOnboardingRoutes(options: OnboardingRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.post("/:orgId/onboarding/interview/round", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = RoundBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_round", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await runRound({ pool: options.pool, answerer: options.answererFactory({ orgId }) }, parsed.data);
      return c.json(result, 200);
    } catch (error) {
      return c.json({ error: "interview_round_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/onboarding/interview/derive", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = DeriveBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_derive", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await deriveFromCapture(
        { pool: options.pool },
        {
          orgId,
          capture: parsed.data.capture,
          actor: { ...actor, orgId },
          ...(parsed.data.repoUrl === undefined ? {} : { repoUrl: parsed.data.repoUrl }),
          ...(parsed.data.autonomy === undefined ? {} : { autonomy: parsed.data.autonomy }),
        },
      );
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_dependency_not_found", message: error.message }, 404);
      }
      return c.json({ error: "interview_derive_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
