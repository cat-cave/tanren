// Template-creation STEP 1 — the LIVE research seam impl (templating-system.md §2.1).
//
// `WebResearchTemplateResearcher` is the REAL `TemplateResearcher` the creation
// flow runs in production. It reasons out the CURRENT best-practice tooling +
// lifecycle for a requested stack with a real model that has WEB ACCESS, and
// records the sources it grounded the decisions on (`provenance.researchSources`).
//
// REUSE, not reinvent: the model call rides the SAME transport every other Forge
// ideation surface uses — an `AnswererAdapter<TemplateResearch>` built from the
// boot-time `ForgeAnswererInfra` via `forgeAllocatingAnswererAdapter` (allocate a
// short-lived runner → resolve the org/project LLM credential + forge routing →
// run ONE structured call → release). The runner the agent runs on can reach the
// web (WebSearch/WebFetch), so the model performs live research and returns the
// grounded decision set + the urls it consulted. There is NO deterministic
// fallback (the §8a invariant): an org with no resolvable LLM credential hard-fails
// the allocate/resolve, and an ungrounded result (no sources) fails LOUD at the
// `assertGroundedResearch` boundary the orchestration enforces.
//
// STACK-AGNOSTIC by construction: the prompt hands the model the requested
// capability brief (the `TemplateCreationRequest`) and asks it to research that
// stack; Tanren names no stack and branches on none — a never-seen stack flows
// through identically.

import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import {
  type ForgeAnswererInfra,
  type ForgeAnswererTarget,
  forgeAllocatingAnswererAdapter,
} from "../../forge/providerFactory.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { type AnswererRetryOptions, withAnswererRetry } from "./answererRetry.js";
import { ResearchOutput } from "./researchSchema.js";
import type { TemplateCreationRequest, TemplateResearch, TemplateResearcher } from "./research.js";

// The structured-output schema name the model emits under (mirrors the Forge
// interview/audit answerer naming convention).
const RESEARCH_SCHEMA_NAME = "tanren.template_research.v1";

// The default per-call HANG bound: template research reads several web sources and
// reasons over them. This is the hang-detector, NOT a terminal verdict — codex
// latency is variable and a slow-but-working call legitimately takes minutes (live:
// 168-282s observed). The prior 180s ceiling fast-killed a healthy-just-slow call;
// 300s clears that real latency ceiling with headroom while still bounding a genuine
// hang. A call that exceeds even this is RETRIED (withAnswererRetry), not terminal.
const DEFAULT_RESEARCH_TIMEOUT_MS = 300_000;

export interface WrapProviderResearcherOptions {
  // Bounds the one research model call (the per-call HANG detector). Defaults to 300s.
  timeoutMs?: number;
  // Transient-failure retry policy for the (pre-build, synchronous) research answerer
  // call. A timeout / transient transport / network blip RETRIES (bounded + backoff)
  // instead of failing the whole derive; only a persistent failure surfaces loud.
  // Tests inject a no-op `sleep` so the bounded retries run instantly. Defaults to
  // the 4-attempt recoverable curve (withAnswererRetry).
  retry?: AnswererRetryOptions;
}

// Render the research brief the model researches against. Capability-shaped: the
// stack label + the runtime/pkg-mgr/framework/deploy target + the full-bar
// feature asks (BDD/mutation default-on). The model is INSTRUCTED to ground every
// decision in live web sources and to return the urls it consulted — an empty
// `researchSources` is rejected downstream (the grounding gate). No stack literal
// appears here; the brief is assembled from the request fields verbatim.
export function buildResearchPrompt(request: TemplateCreationRequest): string {
  const lines: string[] = [
    "You are researching CURRENT best-practice tooling + project lifecycle for a software (or non-software) project stack so Tanren can scaffold a validated, conforming template for it.",
    "",
    "Use live web research (search + fetch authoritative, recent sources) to decide the modern, well-supported toolchain for THIS stack. Do not answer from memory alone — ground every decision in sources you consulted and RETURN their urls in researchSources (at least one; an ungrounded answer is rejected).",
    "",
    "The requested stack (treat these as an opaque brief, never assume a default stack):",
    `- stack label: ${request.stack}`,
    `- runtime: ${request.runtime}`,
    `- package/dependency manager: ${request.packageManager}`,
    ...(request.framework === undefined ? [] : [`- framework: ${request.framework}`]),
    ...(request.deployTarget === undefined ? [] : [`- deploy target: ${request.deployTarget}`]),
    `- behavior-driven specs (BDD) wanted: ${String(request.bdd ?? true)}`,
    `- mutation testing wanted: ${String(request.mutation ?? true)}`,
    ...(request.note === undefined || request.note.trim() === "" ? [] : [`- operator note: ${request.note}`]),
    "",
    "Decide the concrete `just`-target lifecycle commands for this stack (bootstrap / tier1 / tier2 / tier3 / build / deploy), filling each with the ACTUAL command(s) for the researched toolchain. tier1 is the fast format+lint+typecheck gate, tier2 the test gate, tier3 the pre-merge/e2e gate.",
    // FRESH-REPO-SAFE BOOTSTRAP (apex v34) — mirror the interview architecture step
    // (forge/interview/prompt.ts): `bootstrap` runs on a COLD CHECKOUT of a from-scratch
    // template-build repo that has NO committed lockfile yet, so the FIRST bootstrap must
    // be a plain install that GENERATES the lockfile (e.g. `pnpm install`), never a
    // frozen/locked install that PRESUMES a committed lockfile. A `--frozen-lockfile`
    // (or `npm ci` / `cargo build --locked` / `uv sync --frozen`) here fails the cold
    // bootstrap before any lockfile exists (ERR_PNPM_NO_LOCKFILE), stranding the scaffold.
    // The generated lockfile is committed in the scaffold so later/CI installs reproduce.
    "`bootstrap` MUST be a FRESH-REPO-SAFE plain install that WRITES the lockfile on a from-scratch repo (e.g. 'pnpm install' | 'cargo fetch' | 'uv sync'). Do NOT use a frozen/locked install ('--frozen-lockfile' / 'npm ci' / 'cargo build --locked' / 'uv sync --frozen'): this template-build repo is a COLD CHECKOUT with NO committed lockfile yet, so a frozen/locked install fails the first bootstrap before any lockfile exists. The generated lockfile is committed in the scaffold so later/CI installs are reproducible.",
    // TOOLCHAIN (environment-management.md §3 Layer 1) — mirror the interview
    // architecture step (forge/interview/prompt.ts): the research MUST also declare the
    // tool VERSIONS the stack needs, provisioned at workspace-prep via `mise` in user
    // space (the runner ships NO project toolchain). Without this the template-build
    // project gets an empty toolchain → no `mise.toml` is materialized → `mise install`
    // is skipped → `just bootstrap` fails (`pnpm: not found`). CURRENT/LTS by default
    // (the anti-stale-version rule) — never years-old versions. Tanren names no tool.
    "Decide the project TOOLCHAIN in `toolchain`: a list of { name, version } entries the researched stack needs (the runtime + package manager + any pinned tools), so Tanren can provision it via mise before bootstrap. Each `name` is a `mise` tool name (node/pnpm/python/go/rust/…); each `version` is a version string. Use CURRENT/LTS versions a fresh project would adopt TODAY (e.g. [{ name: 'node', version: '24' }, { name: 'pnpm', version: '11' }] | [{ name: 'python', version: '3.14' }] | [{ name: 'rust', version: 'stable' }, { name: 'go', version: '1.23' }]) — NEVER years-old versions — unless the brief explicitly calls for a legacy/pinned/nightly toolchain. Omit `toolchain` (or leave it empty) ONLY for a stack with NO tool mise can provision (a pure-shell / system-package stack that provisions inside its own bootstrap).",
    // LATEST-BY-DEFAULT (environment-management.md §4.5/§7 — the anti-stale-version
    // doctrine). A model has a TRAINING CUTOFF: the versions it remembers are already
    // stale by the time a template is created. Without this guidance a fresh template
    // freezes the cutoff's versions into EVERY project seeded from it forever (apex
    // finding: a live run pinned node 24 + pnpm 10 when pnpm 11 was current). The
    // anti-stale rule is GENERIC — Tanren names no version; the model picks the latest.
    // The non-opinionated doctrine still holds: a deliberately-pinned legacy/specific
    // version is allowed WHEN THE BRIEF REQUIRES IT.
    "VERSIONS — CHOOSE THE LATEST STABLE. For the toolchain (language/runtime/package-manager versions) AND for every dependency, choose the LATEST STABLE release. Do NOT pin to the versions from your training cutoff — assume NEWER versions exist than the ones you remember, and research the current latest. Pin an older / specific / legacy / nightly version ONLY when the project (the brief / operator note) explicitly requires it.",
    // UPGRADE VERB — environment-management.md §4.5/§7 P1. The `upgrade` verb is the
    // generic anti-stale LEVER: a freshly-created template runs it once (creation-time
    // upgrade) and the ongoing generator runs it periodically. Tanren names no command —
    // the project authors the stack-specific one. CRITICAL (Part 3): the verb must cover
    // BOTH the TOOLCHAIN (the mise pins) AND the dependencies — `pnpm update --latest`
    // alone bumps deps but leaves the `mise.toml` node/pnpm pins stale.
    "Decide the project's `upgrade` verb in `upgrade`: the SINGLE command that bumps EVERYTHING to latest — BOTH the declared TOOLCHAIN (the mise-pinned runtime/package-manager versions in `mise.toml`) AND the dependencies. For a mise stack this means bumping the `mise.toml` pins to latest then re-installing AND bumping deps, e.g. 'mise upgrade --bump && mise install && pnpm update --latest' | 'mise upgrade --bump && mise install && cargo update' | 'mise upgrade --bump && mise install && uv lock --upgrade'. A deps-only command (e.g. a bare 'pnpm update --latest') is WRONG — it leaves the toolchain pins stale. Omit `upgrade` ONLY for a stack with genuinely nothing to upgrade (a pure-prose stack); a stack with a toolchain or deps MUST declare it.",
    "Decide which full-bar gates this stack supports (typecheck / lint / test / mutation / junit / bdd) — only mark a gate present if the researched toolchain genuinely provides it (a gate that is green-by-accident must NOT be claimed). When mutation is present, give the concrete mutation command in mutationStep.",
    // TEST-REPORT CONVENTION — mirror the interview architecture step
    // (forge/interview/prompt.ts): a tier that runs tests should write a
    // machine-readable report to a known path, so the gate verdict is parseable.
    "A tier that runs tests should write a machine-readable report to a known path (the test-report convention) — include the report flag/path in the tier command (e.g. a junit reporter writing to 'reports/junit.xml') when the researched test runner supports it.",
    "Summarize the rationale (the chosen tooling + why) in `summary`.",
  ];
  return lines.join("\n");
}

// Adapt an `AnswererAdapter<ResearchOutput>` into the `TemplateResearcher` seam.
// One structured model call per `research(request)`. The adapter is the Forge
// allocating adapter in production (a real LLM with web access on an allocated
// runner); tests inject a fake adapter to exercise the wrapping without a model.
export function wrapProviderResearcher(
  adapter: AnswererAdapter<ResearchOutput>,
  options: WrapProviderResearcherOptions = {},
): TemplateResearcher {
  const jsonSchema = renderAnswererJsonSchema(ResearchOutput);
  return {
    async research(request: TemplateCreationRequest): Promise<TemplateResearch> {
      // RETRY the (pre-build, synchronous) research answerer call on a TRANSIENT
      // failure — a per-call timeout, a 5xx/network blip, a transient transport
      // error. A slow codex call that trips the hang bound retries (and usually
      // succeeds, the latency being variable) instead of fast-failing the whole
      // derive; only a PERSISTENT failure across the bounded retries surfaces loud.
      const output = await withAnswererRetry(
        () =>
          adapter.runAnswerer({
            prompt: buildResearchPrompt(request),
            timeoutMs: options.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS,
            outputSchema: {
              name: RESEARCH_SCHEMA_NAME,
              jsonSchema,
              parse: (value) => ResearchOutput.parse(value),
            },
          }),
        options.retry,
      );
      return researchFromOutput(output);
    },
  };
}

// Map the model's structured output onto the `TemplateResearch` the orchestration
// consumes. `mutationStep` is carried ONLY when the model declared a mutation gate
// (so the manifest/negative-control wiring stays 1:1 with the declared
// capabilities). The grounding (≥1 source) is asserted at the orchestration
// boundary (`assertGroundedResearch`), not silently defaulted here.
function researchFromOutput(output: ResearchOutput): TemplateResearch {
  // Carry the researched `toolchain` onto the lifecycle ONLY when the model declared a
  // non-empty one (a stack with no mise tool legitimately omits it ⇒ no `mise.toml`).
  // A populated toolchain is what makes the template-build project materialize a
  // `mise.toml` so `mise install` provisions the stack before `just bootstrap`.
  const toolchain = output.lifecycle.toolchain;
  const hasToolchain = toolchain !== undefined && toolchain.length > 0;
  // Carry the researched `upgrade` verb onto the lifecycle ONLY when the model declared a
  // non-empty one. Absent/blank ⇒ no upgrade verb (the template fills the `upgrade` target
  // with a loud STUB and the creation-time upgrade is a loud skip — no Tanren upgrade lever).
  const upgrade = output.lifecycle.upgrade?.trim();
  const hasUpgrade = upgrade !== undefined && upgrade !== "";
  return {
    researchSources: [...output.researchSources],
    lifecycle: {
      bootstrap: output.lifecycle.bootstrap,
      tier1: output.lifecycle.tier1,
      tier2: output.lifecycle.tier2,
      tier3: output.lifecycle.tier3,
      build: output.lifecycle.build,
      deploy: output.lifecycle.deploy,
      ...(hasUpgrade ? { upgrade } : {}),
      ...(hasToolchain ? { toolchain: [...toolchain] } : {}),
    },
    tooling: {
      typecheck: output.tooling.typecheck,
      lint: output.tooling.lint,
      test: output.tooling.test,
      mutation: output.tooling.mutation,
      junit: output.tooling.junit,
      bdd: output.tooling.bdd,
      ...(output.tooling.mutation && output.tooling.mutationStep !== undefined
        ? { mutationStep: output.tooling.mutationStep }
        : {}),
    },
    summary: output.summary,
  };
}

// Build the PRODUCTION researcher from the boot-time Forge infra + the target the
// research runs under (the org creating the template — `projectId` absent, exactly
// like the greenfield interview, so credentials resolve from the org defaults).
// This is the single construction site `createTemplateFlow` wires.
export function buildTemplateResearcher(
  infra: ForgeAnswererInfra,
  target: ForgeAnswererTarget,
  options: WrapProviderResearcherOptions = {},
): TemplateResearcher {
  return wrapProviderResearcher(forgeAllocatingAnswererAdapter<ResearchOutput>(infra, target), options);
}
