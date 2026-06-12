// Template-creation STEP 2 — SPEC AUTHORING (docs/roadmap/templating-system.md §2.2).
//
// Turn the research (step 1) into a template-build SPEC SET. The key insight that
// keeps this wave from reinventing the loop: a template build is JUST A TANREN
// PROJECT whose product is a conforming scaffold repo. So spec authoring emits an
// `InterviewCapture` — the SAME structured capture the greenfield interview
// produces — and hands it to the EXISTING `deriveProductGraph`, which builds the
// project graph (scaffold/build/deploy foundation + feature specs) the DagWalker
// then drives. We author NO new spec-creation path; we shape the capture.
//
// The capture encodes the FULL feature set the template must bake (the full-bar
// doctrine): the scaffold (justfile + `.tanren/ci.yml` per the contract), the
// format/lint/real-typecheck/test gates, BDD + mutation when researched, 3-tier
// CI + JUnit + deploy hooks, docs, and the `.tanren/template.yml` manifest +
// validation probes. The lifecycle (the load-bearing architecture output) comes
// straight from the researched lifecycle — so the run materializes the contract
// files deterministically (the v27 fix), no hardcoded stack.
//
// STACK-AGNOSTIC: every command/feature flag comes from the research, never a
// hardcoded pnpm/tsc assumption — a never-seen stack flows through identically.

import {
  type CaptureBehavior,
  type CaptureLifecycle,
  type InterviewCapture,
  emptyCapture,
} from "../../forge/interview/types.js";
import type { TemplateCapabilities } from "../manifest.js";
import type { TemplateCreationRequest, TemplateResearch } from "./research.js";

// Build the `CaptureLifecycle` (the architecture step's load-bearing output) from
// the researched lifecycle + the request's stack label. 1:1 with the researched
// commands — the run materializes the justfile/ci.yml from this deterministically.
function lifecycleFor(request: TemplateCreationRequest, research: TemplateResearch): CaptureLifecycle {
  return {
    stack: request.stack,
    bootstrap: research.lifecycle.bootstrap,
    tier1: research.lifecycle.tier1,
    tier2: research.lifecycle.tier2,
    tier3: research.lifecycle.tier3,
    build: research.lifecycle.build,
    deploy: research.lifecycle.deploy,
    // Project the researched `upgrade` verb onto the template's lifecycle so the build
    // materializes the `upgrade` justfile target. Absent ⇒ "" (a loud STUB target).
    upgrade: research.lifecycle.upgrade ?? "",
    // Project the researched toolchain (mise tool→version) onto the template's
    // lifecycle so the build materializes a `mise.toml`. Absent ⇒ empty (no mise.toml).
    toolchain: research.lifecycle.toolchain ?? {},
  };
}

// The full-bar feature behaviors the template build must satisfy — each becomes a
// feature spec under the derived DAG, so the spec-loop authors the conforming repo
// piece by piece. Authored from the RESEARCHED tooling: a gate the research said
// the stack lacks is not specced (the template won't claim a capability it doesn't
// bake). BDD/mutation behaviors are added only when researched.
function featureBehaviors(research: TemplateResearch, request: TemplateCreationRequest): CaptureBehavior[] {
  const persona = "template-consumer";
  const behaviors: CaptureBehavior[] = [];
  /* eslint-disable unicorn/no-thenable */
  // `then` is the BDD Given/When/Then field name on CaptureBehavior (mirrors the
  // behavior row); the thenable-object lint does not apply to a BDD spec field.
  const add = (title: string, given: string, when: string, then: string): void => {
    behaviors.push({ persona, title, given, when, then });
  };
  /* eslint-enable unicorn/no-thenable */

  if (research.tooling.typecheck) {
    add(
      "real typecheck gate",
      "the conforming repo",
      "`just tier-1` runs the typecheck over the project sources",
      "a real type error FAILS the gate (no no-op typecheck over zero files — the v29 lesson)",
    );
  }
  if (research.tooling.lint) {
    add(
      "format + lint gate",
      "the conforming repo",
      "`just tier-1` runs the formatter-check + linter",
      "a lint violation FAILS the gate and `just format` is wired",
    );
  }
  if (research.tooling.test) {
    const junit = research.tooling.junit
      ? " and writes a machine-readable JUnit report to the JUNIT_REPORT_PATH convention"
      : "";
    add(
      "test gate with reporting",
      "the conforming repo",
      "`just tier-2` runs the test suite",
      `a broken behavior FAILS the gate${junit}`,
    );
  }
  if (research.tooling.bdd ?? request.bdd) {
    add(
      "behavior-driven specs",
      "the conforming repo",
      "a behavior spec is added",
      "the BDD harness runs it as part of the test tier",
    );
  }
  if (research.tooling.mutation) {
    add(
      "mutation gate",
      "the conforming repo",
      `the mutation step (\`${research.tooling.mutationStep ?? "just mutation"}\`) runs`,
      "a surviving mutant FAILS the gate (the seeded mutant is KILLED)",
    );
  }
  // The merge tier (tier-3) + the template manifest + validation probes are
  // always part of the bar.
  add(
    "merge tier + template manifest",
    "the conforming repo",
    "`just tier-3` runs the pre-merge checks and `.tanren/template.yml` is authored",
    "tier-3 is green and the manifest declares the baked capabilities + provenance",
  );
  return behaviors;
}

// The scaffold/architecture design-DNA + identity slug for the template-build
// project. The slug seeds the created repo name (Tanren authors the conforming
// repo off an empty repo, exactly like greenfield). Kept inside the capture's
// length bounds (slug ≤ 80, designDna ≤ 80).
function slugFor(request: TemplateCreationRequest): string {
  const base = `tmpl-${request.stack}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/-+/gu, "-");
  return base.replaceAll(/^-|-$/gu, "").slice(0, 80) || "tmpl-project";
}

// Author the template-build `InterviewCapture` from the research + request. This
// is the WHOLE spec-authoring step: it returns the capture `deriveProductGraph`
// consumes to build the template-build project's DAG (which the DagWalker drives
// in step 3). One persona (the template consumer), the full-bar feature behaviors,
// one delivery interface (the conforming repo), and the load-bearing lifecycle.
export function authorTemplateBuildCapture(
  request: TemplateCreationRequest,
  research: TemplateResearch,
): InterviewCapture {
  const capture = emptyCapture();
  const slug = slugFor(request);
  return {
    ...capture,
    identity: {
      slug,
      pitch: `A validated, conforming Tanren template for the ${request.stack} stack: ${research.summary}`.slice(
        0,
        400,
      ),
      repoHint: "",
    },
    personas: [
      {
        name: "template-consumer",
        description: `A Tanren project that seeds from this ${request.stack} template and expects the full-bar gates already proven.`,
        surface: "repo",
      },
    ],
    behaviors: featureBehaviors(research, request),
    interfaces: [{ name: "conforming-repo", note: "the template repo itself (justfile + .tanren/ci.yml)" }],
    designDna: "full-bar conforming scaffold",
    lifecycle: lifecycleFor(request, research),
    rulesets: [
      "every declared gate must MEANINGFULLY check (a planted defect must fail it) — no green-by-accident gate",
      "the .tanren/ci.yml is the skeleton verbatim; all stack specifics live in the justfile",
    ],
  };
}

// Build the manifest `capabilities` from the research + request — the
// capability-shaped declaration selection later queries. Mirrors exactly what the
// template bakes (a gate the research excluded is not listed in `gates`), so the
// validation harness's negative controls line up 1:1 with the declared
// capabilities. STACK-AGNOSTIC: every field comes from the research/request.
export function capabilitiesFor(request: TemplateCreationRequest, research: TemplateResearch): TemplateCapabilities {
  const gates: string[] = [];
  if (research.tooling.typecheck || research.tooling.lint) gates.push("tier-1");
  if (research.tooling.test) gates.push("tier-2");
  gates.push("tier-3");
  return {
    runtime: request.runtime,
    packageManager: request.packageManager,
    ...(request.framework === undefined ? {} : { framework: request.framework }),
    ...(request.deployTarget === undefined ? {} : { deployTarget: request.deployTarget }),
    gates,
    bdd: research.tooling.bdd ?? request.bdd ?? false,
    mutation: research.tooling.mutation,
    junit: research.tooling.junit,
  };
}
