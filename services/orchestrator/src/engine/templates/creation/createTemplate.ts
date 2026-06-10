// The TEMPLATE-CREATION META-FLOW (docs/roadmap/templating-system.md §2) — the
// `createTemplate(request)` orchestration. Given a stack/capability request (an
// operator ask, or the no-match "would-create" case from selection), it runs the
// five-step meta-DAG and registers a VALIDATED template — or fails LOUD without
// publishing.
//
//   1. RESEARCH    — web-research current best practice + tooling (research.ts).
//   2. AUTHOR       — emit the template-build spec set as an InterviewCapture
//                     (specAuthoring.ts), then materialize the project graph via
//                     the EXISTING `deriveProductGraph` (the greenfield derive).
//   3. BUILD        — drive that project through the EXISTING spec-loop/DagWalker
//                     (buildDriver.ts seam) to the conforming template repo.
//   4. VALIDATE     — run the EXISTING `runValidationHarness` (positive + NEGATIVE
//                     controls + auditor) over the built repo → TemplateValidationProof.
//   5. PUBLISH      — ONLY if `templateValidates(proof)`: register it in the
//                     `TemplateStore` (status `validated`, manifest with the proof +
//                     provenance + channel) + emit `template.registered`. An invalid
//                     template is NOT registered — a LOUD finding, never a publish.
//
// REUSE, don't reinvent: research + build are SEAMS onto live infra; spec
// authoring feeds `deriveProductGraph`; validation is `runValidationHarness`;
// publish is the wave-1 `TemplateStore`. This module is ONLY the orchestration +
// the fail-closed publish gate.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import type { EventStore } from "../../eventStore.js";
import { deriveProductGraph, type DeriveInput, type DeriveResult } from "../../forge/interview/derive.js";
import { TemplateStore, type Template } from "../../repositories/templates.js";
import {
  type TemplateChannel,
  type TemplateManifestV1,
  type TemplateProvenance,
  type TemplateValidationProof,
} from "../manifest.js";
import { buildNegativeControlPlan } from "../negativeControls.js";
import { runValidationHarness } from "../validationHarness.js";
import { templateValidates } from "../validationProof.js";
import { type BuiltTemplate, TemplateBuildFailedError, type TemplateBuildDriver } from "./buildDriver.js";
import {
  assertGroundedResearch,
  type TemplateCreationRequest,
  type TemplateResearch,
  type TemplateResearcher,
} from "./research.js";
import { authorTemplateBuildCapture, capabilitiesFor } from "./specAuthoring.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("template-creation");

// The injected collaborators the meta-flow drives. Everything live is a SEAM so
// the orchestration is exercised end-to-end against stubs (a stubbed research +
// a stubbed loop) — the wave's test contract. The `deriveOptions` carry the live
// derive's repo-creation + deploy plumbing (the same `deriveProductGraph` the
// greenfield route uses); a test passes an explicit `repoUrl` instead.
export interface CreateTemplateDeps {
  pool: pg.Pool;
  events: EventStore;
  actor: ActorContext;
  // Step 1: the research seam.
  researcher: TemplateResearcher;
  // Step 3: the build-driver seam (drives the derived project's DAG).
  buildDriver: TemplateBuildDriver;
  // The derive plumbing (repo creation + deploy provisioning) the template-build
  // project is created with — the SAME knobs `deriveProductGraph` takes for a
  // greenfield project. Tests pass `{ repoUrl, deploy?, prepareDeploy? }`.
  deriveOptions: Omit<DeriveInput, "orgId" | "capture" | "actor">;
  // Step 2's project-graph materialization. DEFAULTS to the real
  // `deriveProductGraph` (the greenfield derive — the reuse the wave mandates); a
  // test injects a stub so the orchestration is exercised without the full
  // entity-creation DB path. The default is the live function — this seam is for
  // test isolation, not an alternate production path.
  derive?: (pool: pg.Pool, input: DeriveInput) => Promise<DeriveResult>;
  // The clock — passed so the proof's validatedAt is deterministic in tests.
  now: () => Date;
  // The harness/positive-control timeout.
  timeoutMs: number;
}

// The outcome of a successful creation: the registered template + the run/project
// it was built by + the proof. The caller (the API route / the no-match hook)
// reports this back. A FAILED validation does NOT return this — it throws
// `TemplateValidationFailedError` (the fail-closed gate).
export interface CreateTemplateResult {
  template: Template;
  projectId: string;
  proof: TemplateValidationProof;
  researchSources: ReadonlyArray<string>;
}

// Thrown when the built template did NOT pass validation — the fail-closed publish
// gate (templating-system.md §2.4/§5). The proof is attached so the caller can
// surface EXACTLY which control failed (a no-op typecheck → typecheck unproven).
// An invalid template is never registered; this is the LOUD finding instead.
export class TemplateValidationFailedError extends Error {
  readonly proof: TemplateValidationProof;
  // Named `requestedStack` (not `stack`) so it does not shadow `Error.stack`.
  readonly requestedStack: string;
  readonly projectId: string;
  constructor(stack: string, projectId: string, proof: TemplateValidationProof) {
    super(
      `template "${stack}" (project ${projectId}) FAILED validation — not published. ` +
        `positiveControlsPassed=${String(proof.positiveControlsPassed)}, ` +
        `auditorClean=${String(proof.auditorClean)}, ` +
        `negativeControls=${JSON.stringify(proof.negativeControls)}`,
    );
    this.name = "TemplateValidationFailedError";
    this.proof = proof;
    this.requestedStack = stack;
    this.projectId = projectId;
  }
}

// Run the full creation meta-flow. Returns the registered template on success;
// throws LOUD on an ungrounded research (UngroundedResearchError), a failed build
// (TemplateBuildFailedError, from the driver), or a failed validation
// (TemplateValidationFailedError) — never publishes a degraded/unvalidated template.
export async function createTemplate(
  deps: CreateTemplateDeps,
  request: TemplateCreationRequest,
): Promise<CreateTemplateResult> {
  const orgId = requireOrg(deps.actor);

  // STEP 1 — RESEARCH (+ ground it: an ungrounded result fails LOUD here). Wrap the
  // whole flow so a failure at ANY step emits a DURABLE `template.creation.failed`
  // (LOUD — paired with the caller's fail-closed halt), then re-throws. The build
  // project does not exist until step 2, so a pre-derive failure is recorded against
  // a project-less event with the requesting org/stack as the durable record.
  let research: TemplateResearch;
  try {
    research = await deps.researcher.research(request);
    assertGroundedResearch(research, request.stack);
  } catch (error) {
    await emitCreationFailed(deps, orgId, request.stack, undefined, error);
    throw error;
  }

  // STEP 2 — AUTHOR the spec set, then materialize the project graph via the
  // EXISTING greenfield derive (the template build IS a Tanren project). The derive
  // runs with `scaffoldOrigin: "template_build"` — this IS the ONE legitimate
  // from-scratch authoring (it authors the TEMPLATE itself, validated below before
  // any project seeds from it). No `templateRegistryQuery` (nothing to select).
  const capture = authorTemplateBuildCapture(request, research);
  const derive = deps.derive ?? deriveProductGraph;
  let derived: DeriveResult;
  try {
    derived = await derive(deps.pool, {
      orgId,
      capture,
      actor: deps.actor,
      scaffoldOrigin: "template_build",
      ...deps.deriveOptions,
    });
  } catch (error) {
    await emitCreationFailed(deps, orgId, request.stack, undefined, error);
    throw error;
  }

  // DURABLE: the no-match → creation record (templating-system.md §3). The build
  // project now exists, so these carry it. `no_match` records that this stack had no
  // validated template (creation was triggered); `started` opens the meta-flow. Both
  // are project-scoped events on the template-BUILD project — never a vanishing log.
  await deps.events.append({
    projectId: derived.projectId,
    eventType: "template.selection.no_match",
    payload: { orgId, stack: request.stack, query: JSON.stringify(capabilitiesFor(request, research)) },
  });
  await deps.events.append({
    projectId: derived.projectId,
    eventType: "template.creation.started",
    payload: { orgId, stack: request.stack },
  });

  // From here a failure carries the build project id on `template.creation.failed`.
  try {
    return await buildValidatePublish(deps, request, research, derived, orgId);
  } catch (error) {
    await emitCreationFailed(deps, orgId, request.stack, derived.projectId, error);
    throw error;
  }
}

// Steps 3–5 (build · validate · publish) — split out so `createTemplate` stays the
// orchestration + the durable-event envelope. Throws LOUD on a failed build / failed
// validation (the fail-closed publish gate); the caller's wrapper emits the durable
// `template.creation.failed`. On success emits `template.creation.published` +
// `template.registered` and returns the registered template.
async function buildValidatePublish(
  deps: CreateTemplateDeps,
  request: TemplateCreationRequest,
  research: TemplateResearch,
  derived: DeriveResult,
  orgId: string,
): Promise<CreateTemplateResult> {
  // STEP 3 — BUILD: drive the derived project's DAG through the existing loop. A
  // driver that returns no conforming repo / commit did not converge — a LOUD
  // failure (the harness cannot validate a non-repo), never a silent "validate it
  // anyway".
  const built = await deps.buildDriver.build({ orgId, projectId: derived.projectId });
  if (built.repoRef === "" || built.builtSha === "") {
    // The build driver allocated nothing usable, but still hand its `release` a chance
    // (idempotent no-op when nothing was allocated) before failing.
    await built.release();
    throw new TemplateBuildFailedError(derived.projectId, "the build driver returned no repo ref / commit");
  }

  // STEP 4 — VALIDATE over the allocated validation runner. RELEASE it in a `finally`
  // (pass OR fail) so the validation runner is never LEAKED (audit §3.11/4 — the
  // creation flow owns the teardown). The release is best-effort (never throws), so it
  // cannot mask a validation result.
  let proof: TemplateValidationProof;
  try {
    proof = await validateBuilt(deps, request, research, built);
  } finally {
    await built.release();
  }

  // THE FAIL-CLOSED GATE: only a template whose proof validates may publish.
  if (!templateValidates(proof)) {
    throw new TemplateValidationFailedError(request.stack, derived.projectId, proof);
  }

  // STEP 5 — PUBLISH: register the validated template + emit template.registered.
  const manifest = buildManifest(request, research, proof, derived.projectId);
  const template = await TemplateStore.create(
    deps.pool,
    { orgId, repoRef: built.repoRef, manifest, status: "validated" },
    { kind: "operator" },
  );
  await deps.events.append({
    projectId: derived.projectId,
    eventType: "template.registered",
    payload: {
      templateId: template.id,
      orgId,
      repoRef: template.repoRef,
      stack: manifest.stack,
      channel: manifest.channel,
      status: template.status as "draft" | "validated" | "degraded" | "official",
    },
  });
  // DURABLE: the just-in-time creation PUBLISHED a validated template — the gated
  // project scaffold now seeds from it (templating-system.md §3). Paired with the
  // no_match/started events for the full no-match→published trail.
  await deps.events.append({
    projectId: derived.projectId,
    eventType: "template.creation.published",
    payload: { orgId, stack: request.stack, templateId: template.id, repoRef: template.repoRef },
  });

  return { template, projectId: derived.projectId, proof, researchSources: research.researchSources };
}

// Emit the DURABLE `template.creation.failed` (templating-system.md §3) — the LOUD
// record that a just-in-time creation could not produce a validated template (so the
// caller halts fail-closed; the project NEVER proceeds from-scratch). Best-effort: an
// event-store failure must not mask the original creation error, so it is swallowed
// after a log. The events table scopes every row to a real project (the org_id is
// derived from `projects`), so a PRE-DERIVE failure (research ungrounded — no build
// project yet) is recorded as a LOUD log only; the durable+loud record at that stage
// is the caller's `TemplateRequiredError` halt surfaced by the onboarding route. A
// POST-DERIVE failure (build / validation — the common case) emits the durable event
// against the template-build project.
async function emitCreationFailed(
  deps: CreateTemplateDeps,
  orgId: string,
  stack: string,
  projectId: string | undefined,
  error: unknown,
): Promise<void> {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (projectId === undefined) {
    log.warn(
      "template creation FAILED before the build project existed — no durable event row (the caller's " +
        "TemplateRequiredError halt is the loud record); never a silent from-scratch",
      { orgId, stack, reason },
    );
    return;
  }
  try {
    await deps.events.append({
      projectId,
      eventType: "template.creation.failed",
      payload: { orgId, stack, reason },
    });
  } catch (appendError) {
    log.warn("failed to emit template.creation.failed (the original creation error stands)", { stack }, appendError);
  }
}

// STEP 4 helper: run the validation harness over the built template. The negative
// controls are built from the RESEARCHED tooling (mutationStep only when the
// research baked a mutation gate), so the controls line up 1:1 with the declared
// capabilities (an undeclared gate is recorded `n/a`, not failed).
async function validateBuilt(
  deps: CreateTemplateDeps,
  request: TemplateCreationRequest,
  research: TemplateResearch,
  built: BuiltTemplate,
): Promise<TemplateValidationProof> {
  const negativeControls = buildNegativeControlPlan(
    research.tooling.mutation ? { mutationStep: research.tooling.mutationStep ?? "just mutation" } : {},
  );
  return runValidationHarness({
    ssh: built.ssh,
    target: built.target,
    workspacePath: built.workspacePath,
    scratchRoot: built.scratchRoot,
    config: built.config,
    negativeControls,
    ...(built.buildStep === undefined ? {} : { buildStep: built.buildStep }),
    auditor: built.auditor,
    validatedSha: built.builtSha,
    now: deps.now,
    timeoutMs: deps.timeoutMs,
    // The harness narrates through the run's event sink; the build driver owns the
    // run, so positive/negative gate runs land in its timeline. A project-scoped
    // sink is enough for creation (no per-run wake needed for the harness narration).
    appendEvent: async () => {},
  });
}

// Assemble the validated `.tanren/template.yml` manifest from the request, the
// research (capabilities + provenance), and the proof. `channel` defaults to `lts`
// (nightly is a later maintenance concern). The provenance carries the research
// sources + the run id that built it (the creation meta-DAG's project).
function buildManifest(
  request: TemplateCreationRequest,
  research: TemplateResearch,
  proof: TemplateValidationProof,
  projectId: string,
): TemplateManifestV1 {
  const channel: TemplateChannel = request.channel ?? "lts";
  const provenance: TemplateProvenance = {
    researchSources: [...research.researchSources],
    createdByRunId: projectId,
  };
  return {
    version: 1,
    stack: request.stack,
    capabilities: capabilitiesFor(request, research),
    channel,
    templateVersion: proof.validatedAt.slice(0, 10),
    provenance,
    validationProof: proof,
  };
}

// Org is required — the template is org-scoped (or, later, submitted to cat-cave
// official via a separate review flow). A null org is a LOUD failure, never a
// silent fallback to a default org.
function requireOrg(actor: ActorContext): string {
  if (actor.orgId === null) {
    throw new Error("createTemplate requires an org-scoped actor (actor.orgId is null)");
  }
  return actor.orgId;
}
