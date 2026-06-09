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

  // STEP 1 — RESEARCH (+ ground it: an ungrounded result fails LOUD here).
  const research = await deps.researcher.research(request);
  assertGroundedResearch(research, request.stack);

  // STEP 2 — AUTHOR the spec set, then materialize the project graph via the
  // EXISTING greenfield derive (the template build IS a Tanren project).
  const capture = authorTemplateBuildCapture(request, research);
  const derive = deps.derive ?? deriveProductGraph;
  const derived: DeriveResult = await derive(deps.pool, {
    orgId,
    capture,
    actor: deps.actor,
    ...deps.deriveOptions,
  });

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

  return { template, projectId: derived.projectId, proof, researchSources: research.researchSources };
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
