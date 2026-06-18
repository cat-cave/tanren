// The LIVE `createTemplateFlow` assembly (templating-system.md §2) — the wiring
// that turns the route's `CreateTemplateFlow` seam into a REAL, mountable
// capability. It composes, from the boot-time orchestrator infra, the full
// `CreateTemplateDeps` the creation meta-flow runs on:
//
//   - the LIVE research seam (`buildTemplateResearcher`) — a real model with web
//     access on an allocated runner, grounded with `provenance.researchSources`;
//   - the LIVE build-driver seam (`buildRunLoopBuildDriver`) — drives the derived
//     template-build project's DAG to convergence through the SAME walker + run
//     worker, then clones the converged conforming tree for validation;
//   - the LIVE auditor (`buildTemplateAuditor`) over the existing audit pass runner;
//   - the EXISTING validation harness + registry store + `deriveProductGraph`
//     (the greenfield derive — repo creation + deploy provisioning + autonomous
//     project config), reused verbatim.
//
// REUSE, not reinvent: every heavy piece is the production infra already assembled
// for the run worker / Forge surfaces / greenfield onboarding. This module is ONLY
// the glue that hands `createTemplate` its live collaborators per request. The
// fail-closed publish gate + the five §2 steps live inside `createTemplate`.

import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { Allocator, CommandSubstrate, SecretStore } from "../../engine/contracts/index.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import { buildDagWalker, PgDagReadModel } from "../../engine/dag/walker.js";
import { PgEventStore } from "../../engine/eventStore.js";
import type { AuditPassRunner } from "../../engine/forge/audits/index.js";
import {
  preflightGreenfieldDeploy,
  prepareGreenfieldDeploy,
  createGreenfieldRepository,
} from "../projects/greenfield.js";
import type { ForgeAnswererInfra } from "../../engine/forge/providerFactory.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { buildTemplateResearcher } from "../../engine/templates/creation/liveResearch.js";
import { buildRunLoopBuildDriver } from "../../engine/templates/creation/liveBuildDriver.js";
import { buildLiveTemplateBuildRecovery } from "../../engine/templates/creation/liveRecovery.js";
import { buildCreationUpgrade } from "../../engine/templates/creation/creationUpgrade.js";
import { resolveConvergedProjectFacts } from "../../engine/templates/creation/convergedFacts.js";
import { buildTemplateAuditor } from "../../engine/templates/creation/liveAuditor.js";
import {
  createTemplate,
  isProofFresh,
  maybeCreateTemplateForNoMatch,
  type CreateTemplateDeps,
  type TemplateCreationRequest,
  type CreateTemplateResult,
} from "../../engine/templates/index.js";
import { TemplateStore } from "../../engine/repositories/index.js";
import type { SelectedTemplate, TemplateRegistryQuery } from "../../engine/forge/interview/templateSelection.js";
import type { CaptureLifecycle } from "../../engine/forge/interview/types.js";
import type { CreateTemplateFlow } from "./index.js";
import { createLogger } from "../../engine/observability/logger.js";

const log = createLogger("template-creation");

// The deploy provider a template-build project provisions. A template REPO does not
// ship a deployed product, but the greenfield derive REQUIRES a deploy dependency
// (the apex/greenfield contract). When the request carries an EXPLICIT
// `deployProviderKind` — the operator's already-linked, preflighted derive choice —
// it is AUTHORITATIVE: the build provisions THAT provider, never one re-guessed. The
// no-match onboarding path always supplies it (the derive requires an explicit deploy
// provider, guaranteed linked), so the template build never demands a provider the org
// has not linked. Only the standalone operator create route (which may pass a free-form
// `deployTarget` with no explicit providerKind) falls back to the target-string
// heuristic. We NEVER let that heuristic shadow an explicit choice, and never silently
// default to flyio when an explicit, linked provider was supplied.
export function deployDependencyFor(request: TemplateCreationRequest): { providerKind: string; name: string } {
  const name = `tmpl-${request.stack}`.slice(0, 80);
  if (request.deployProviderKind !== undefined) {
    return { providerKind: request.deployProviderKind, name };
  }
  const target = (request.deployTarget ?? "").toLowerCase();
  const providerKind = target.includes("vercel") ? "deploy.vercel" : "deploy.flyio";
  return { providerKind, name };
}

/** The infra `mountFeatureRoutes` assembles the live create flow from. */
export interface CreateTemplateFlowDeps {
  // The request-org-scoping pool (RLS bounds every read/write to the request org).
  pool: pg.Pool;
  secrets: SecretStore;
  allocator: Allocator;
  ssh: CommandSubstrate;
  identitySecretRef: string;
  // The greenfield repo-creation path (the template repo is authored off an empty
  // repo, exactly like a greenfield product) — the shared GitHub HTTP client the
  // repo-create `CodeHost` is constructed from (decomposition PR-3).
  githubHttp: GitHubHttpClient;
  githubAppMinter: GithubAppTokenMinter;
  // The shared Forge answerer infra (the research model call rides it).
  forgeInfra: ForgeAnswererInfra;
  // The REAL scheduled-audit pass runner (the convergence auditor reuses it).
  auditPassRunner: AuditPassRunner;
  // The DEFAULT GitHub owner new template repos are created under (the org's
  // connected owner) when the request does not name one. A template must land in a
  // real repo, never a silent skip — an absent owner on both is a LOUD failure.
  repoOwner?: string;
  // The convergence poll cadence (the DAG drives asynchronously). There is NO
  // whole-build wall-clock deadline — a build that is still progressing polls
  // indefinitely; it fails LOUD only on a genuine deadlock (blocked + no progress).
  convergence?: { pollIntervalMs: number };
}

const DEFAULT_CONVERGENCE = { pollIntervalMs: 15_000 };

// Assemble the full `CreateTemplateDeps` the creation meta-flow runs on, for one
// (org, actor, request). The SINGLE place the live collaborators are wired — reused
// by BOTH the route flow AND the selection no-match seam, so creation behaves
// identically whether an operator triggers it or a no-match onboarding does.
export function buildCreateTemplateDeps(
  deps: CreateTemplateFlowDeps,
  input: { orgId: string; actor: ActorContext; request: TemplateCreationRequest },
): CreateTemplateDeps {
  const convergence = deps.convergence ?? DEFAULT_CONVERGENCE;
  const { orgId, actor, request } = input;

  // STEP 1 seam — the LIVE researcher (org-scoped target; no project yet, so
  // credentials resolve from the org defaults — like the greenfield interview).
  const researcher = buildTemplateResearcher(deps.forgeInfra, { orgId });

  // STEP 3 seam — the LIVE build driver over the real walker + run worker. The walker
  // self-wires its org-scoped ancestor-stack resolver from the pool (no host integration
  // builder — the jj-local cutover removed the synthesized integration ref).
  const walker = buildDagWalker(deps.pool, {});
  const readModel = new PgDagReadModel(deps.pool);
  const buildDriver = buildRunLoopBuildDriver({
    pool: deps.pool,
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
    walker,
    loadSnapshot: (projectId) => readModel.loadSnapshot(projectId),
    resolveConverged: (facts) => resolveConvergedProjectFacts(deps.pool, facts),
    auditorFor: (target) =>
      buildTemplateAuditor({ passRunner: deps.auditPassRunner, orgId: target.orgId, projectId: target.projectId }),
    convergence,
  });

  // The derive plumbing — the SAME greenfield repo-creation + deploy provisioning
  // the onboarding route wires, so the template-build project is a real autonomous
  // (native_queue + auto) Tanren project off an empty repo. The repo owner is the
  // request's owner (operator/onboarding) over the org default — absent on BOTH is a
  // LOUD failure (a template must land in a real repo, never a silent skip).
  const owner = request.owner ?? deps.repoOwner;
  if (owner === undefined || owner === "") {
    throw new Error("template creation requires a GitHub owner (request.owner or a configured org owner)");
  }
  const deploy = deployDependencyFor(request);
  // SELF-RECOVERY seam (templating-system.md §2): the template-build derive is bound to
  // a deterministic slug, so a re-trigger RESUMES the SAME (possibly stranded) build. The
  // recovery DETECTS a bound, not-yet-validated build with terminally-blocked spec(s) and
  // AUTO-REQUEUES them (reset → `open`, re-driven from scratch), BOUNDED (a loud terminal
  // failure after the cap) — so a stranded build NEVER needs manual DB clearing.
  const recovery = buildLiveTemplateBuildRecovery(deps.pool, actor);
  // CREATION-TIME UPGRADE seam (environment-management.md §4.5/§7 P1): the once-at-birth,
  // gated `just upgrade` node so a freshly-created template starts near-latest (defeats the
  // model's training-cutoff version freeze). Inserts the SAME gated DAG node the periodic
  // generator does, depending on the build specs — the build's convergence drive runs it
  // through the full gate; a project with no upgrade verb skips loud.
  const creationUpgrade = buildCreationUpgrade({ pool: deps.pool });

  return {
    pool: deps.pool,
    events: new PgEventStore(deps.pool),
    actor,
    researcher,
    buildDriver,
    recovery,
    creationUpgrade,
    deriveOptions: {
      owner,
      autonomy: "auto",
      deploy,
      preflightDeploy: (pf) => preflightGreenfieldDeploy(deps.pool, pf.orgId, pf.providerKind, actor.userId),
      prepareDeploy: (pd) =>
        prepareGreenfieldDeploy({
          pool: deps.pool,
          secrets: deps.secrets,
          orgId: pd.orgId,
          actorId: actor.userId,
          projectKey: pd.projectKey,
          projectName: pd.projectName,
          deploy: pd,
        }),
      createRepository: (repoInput) =>
        createGreenfieldRepository({
          pool: deps.pool,
          secrets: deps.secrets,
          githubHttp: deps.githubHttp,
          orgId,
          githubAppMinter: deps.githubAppMinter,
          input: repoInput,
        }),
    },
    now: () => new Date(),
  };
}

// Build the LIVE `CreateTemplateFlow` the route mounts. Each invocation assembles
// the per-request live collaborators and runs the creation meta-flow.
export function buildCreateTemplateFlow(deps: CreateTemplateFlowDeps): CreateTemplateFlow {
  return async (input: {
    orgId: string;
    actor: ActorContext;
    request: TemplateCreationRequest;
  }): Promise<CreateTemplateResult> => createTemplate(buildCreateTemplateDeps(deps, input), input.request);
}

// The SELECTION → JUST-IN-TIME CREATION wiring (templating-system.md §3, the "no
// match → trigger creation" branch). The selection layer (`selectTemplate`) is pure
// (no creation dependency); this builds the `createForNoMatch` seam it invokes when no
// validated template matches.
//
// SYNCHRONOUS CREATE-THEN-SEED (the doctrine cutover — replaces the deleted
// async-fire-and-forget bypass): template creation drives a real build to convergence
// — and the project scaffold GATES on it. There is NO whole-build wall-clock deadline
// (a build runs until it converges or genuinely deadlocks; only PER-step timeouts
// bound a hang). The seam runs to completion and returns a SEED:
//   1. FAST existing-match check (a query) — a pre-existing validated/official match
//      seeds THIS derive immediately (the steady-state path, no build).
//   2. On NO match, run the creation meta-flow SYNCHRONOUSLY
//      (`maybeCreateTemplateForNoMatch`: research → author → build → validate-with-
//      NEGATIVE-controls → publish) and return the freshly-published template as the
//      SEED — THIS derive seeds from it (the project never proceeds from-scratch). A
//      creation FAILURE PROPAGATES (the meta-flow throws): `selectTemplate` re-throws
//      it as a LOUD `TemplateRequiredError` halt — never a silent from-scratch.
//
// The earlier "fire detached, return undefined, derive proceeds from-scratch this
// run, template built for the NEXT run" design IS the bypass this deletes: it let a
// project DAG scaffold against a non-template base. The cost (the derive HTTP request
// now blocks on a multi-minute-to-hour build) is the correct trade — the alternative
// is the very non-template scaffold the doctrine forbids. The onboarding route runs
// the derive on its own request lifecycle; a future async-job carrier can move the
// wait off the HTTP request without re-introducing the from-scratch proceed.
//
// `repoOwner` is the REAL repo owner threaded from the derive request — without it
// the create path had no owner and silently no-op'd. It is folded onto the creation
// request so `buildCreateTemplateDeps` resolves a real owner.
//
// `templateRegistryQuery` is the SAME org-scoped query the derive path runs, so the
// no-match check and the selection share one scoping. No circular import: this
// composes the creation module + the selection types, neither of which depends on it.
export function buildCreateForNoMatch(
  deps: CreateTemplateFlowDeps,
  ctx: {
    orgId: string;
    actor: ActorContext;
    templateRegistryQuery: TemplateRegistryQuery;
    repoOwner: string;
    // The operator's EXPLICIT, already-linked deploy provider from the derive request.
    // Threaded verbatim so the template build provisions against the SAME provider the
    // operator named (guaranteed linked by the derive preflight) — never a provider
    // re-guessed from the lifecycle string that defaults to an unlinked `deploy.flyio`.
    // The greenfield/apex derive always supplies it; only a deploy-less derive omits it
    // (then the build falls back to the `deployTarget` heuristic).
    deployProviderKind?: "deploy.vercel" | "deploy.flyio";
  },
): (lifecycle: CaptureLifecycle) => Promise<SelectedTemplate | undefined> {
  return async (lifecycle: CaptureLifecycle): Promise<SelectedTemplate | undefined> => {
    const request: TemplateCreationRequest = {
      ...requestFromLifecycle(lifecycle),
      owner: ctx.repoOwner,
      ...(ctx.deployProviderKind === undefined ? {} : { deployProviderKind: ctx.deployProviderKind }),
    };
    const createDeps = buildCreateTemplateDeps(deps, { orgId: ctx.orgId, actor: ctx.actor, request });

    // 1. FAST existing-match check (no build). A pre-existing validated/official
    //    template seeds THIS derive synchronously — the common steady-state path.
    const existing = await findExistingValidatedTemplate(deps, ctx, request);
    if (existing !== undefined) return existing;

    // 2. NO match → run creation SYNCHRONOUSLY and SEED from the published template.
    //    The build GATES the project scaffold. A failure PROPAGATES so selection halts
    //    LOUD (`TemplateRequiredError`) — the project never proceeds from-scratch. The
    //    `maybeCreateTemplateForNoMatch` hook re-checks the registry (it may have been
    //    populated by a concurrent create) then runs the fail-closed creation gate.
    const decision = await maybeCreateTemplateForNoMatch(createDeps, request);
    if (!decision.created) {
      const proof = decision.template.manifest.validationProof;
      if (proof === null) {
        // A matched template with no proof is not seedable — return nothing so
        // selection halts loud (`TemplateRequiredError`), never a from-scratch seed.
        log.warn("no-match hook returned an unproven template (no validationProof)", { stack: request.stack });
        return undefined;
      }
      return { templateRef: decision.template.id, repoRef: decision.template.repoRef, validationProof: proof };
    }
    // CREATED + PUBLISHED: seed THIS derive from the freshly-validated template.
    const created = decision.result;
    return {
      templateRef: created.template.id,
      repoRef: created.template.repoRef,
      validationProof: created.proof,
    };
  };
}

// The SYNCHRONOUS existing-match check the no-match seam runs before creation — the
// SAME capability query the no-match hook uses internally, lifted out so a registry
// HIT seeds THIS derive without ever triggering a build. Returns the `SelectedTemplate`
// to seed from, or `undefined` (no existing FRESH validated match → just-in-time
// creation). Org-scoped by `deps.pool` (the request-scoped pool), so RLS bounds the
// candidates.
//
// PROOF-FRESHNESS PARITY with `selectTemplate` (templateSelection.ts): the registry
// `statuses` filter does NOT enforce the 30-day freshness re-check, so a `validated`-
// status template whose proof has gone STALE (>30 days) would otherwise be re-seeded
// here — the exact stale seed `selectTemplate` rejects at its decision boundary. We
// apply `isProofFresh` so a stale match falls THROUGH to creation (which publishes a
// fresh proof), never seeds off a stale template.
async function findExistingValidatedTemplate(
  deps: CreateTemplateFlowDeps,
  _ctx: { orgId: string; actor: ActorContext },
  request: TemplateCreationRequest,
): Promise<SelectedTemplate | undefined> {
  const now = Date.now();
  const matches = await TemplateStore.listByCapabilities(
    deps.pool,
    {
      runtime: request.runtime,
      packageManager: request.packageManager,
      ...(request.framework === undefined ? {} : { framework: request.framework }),
      ...(request.deployTarget === undefined ? {} : { deployTarget: request.deployTarget }),
      statuses: ["validated", "official"],
    },
    { kind: "operator" },
  );
  const template = matches.find((t) => isProofFresh(t.manifest.validationProof, now));
  if (template === undefined) return undefined;
  const proof = template.manifest.validationProof;
  if (proof === null) return undefined;
  return { templateRef: template.id, repoRef: template.repoRef, validationProof: proof };
}

// Map a project's captured LIFECYCLE onto a `TemplateCreationRequest` (the no-match
// path). The capability vocabulary is derived the SAME way selection derives its
// registry query — capability HINTS from the free-form `stack` label tokens (first
// = runtime, second = package manager) + the deploy command's first token. Tanren
// names no stack; a never-seen stack maps through identically. The full-bar
// defaults (bdd/mutation) apply — research re-decides what the stack actually bakes.
function requestFromLifecycle(lifecycle: CaptureLifecycle): TemplateCreationRequest {
  const tokens = lifecycle.stack
    .toLowerCase()
    .split(/[/·\s,-]+/u)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const deployToken = lifecycle.deploy
    .toLowerCase()
    .split(/[/·\s,-]+/u)
    .map((t) => t.trim())
    .find((t) => t !== "");
  return {
    stack: lifecycle.stack,
    runtime: tokens[0] ?? lifecycle.stack,
    packageManager: tokens[1] ?? tokens[0] ?? lifecycle.stack,
    ...(deployToken === undefined ? {} : { deployTarget: deployToken }),
  };
}
