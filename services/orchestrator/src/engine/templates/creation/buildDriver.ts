// Template-creation STEP 3 — BUILD (docs/roadmap/templating-system.md §2.3).
//
// Drive the template-build spec set (authored in step 2 + materialized into a
// project graph by `deriveProductGraph`) through the EXISTING spec-loop /
// DagWalker to author the conforming template repo. We do NOT reinvent the loop:
// the template build is just a Tanren project, so the SAME run machinery that
// builds any project builds the template. This module is the SEAM onto that
// machinery + the typed handoff the validation step (step 4) needs.
//
// The seam is injected so the creation orchestration is testable without a live
// run + real runner: tests inject a stub driver that returns a built handle; the
// real implementation kicks off + awaits the project's DAG via the run path and
// returns the resulting repo ref + commit sha + an allocated runner the harness
// validates over. A throw is a LOUD failure (a template that did not build cannot
// be validated/published) — never a silent "built, somehow".

import type { CiConfigV1 } from "../../ci/index.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import type { TemplateAuditor } from "../validationHarness.js";

// The result of building a template project to completion: the conforming repo it
// produced + the validated commit + the live runner context the validation
// harness runs over (the built workspace, the scratch root, the resolved CI
// config, the auditor seam). The driver owns allocating + bootstrapping the
// runner from the built repo — the validation step just consumes this handle.
export interface BuiltTemplate {
  // The conforming template repo ref the build produced (owner/repo or clone url) —
  // persisted as the registry row's `repoRef`.
  repoRef: string;
  // The exact commit the build converged on — the proof is anchored on this sha.
  builtSha: string;
  // The live command substrate (SSH) the validation harness runs over.
  ssh: CommandSubstrate;
  // The allocated runner the built repo is checked out + bootstrapped on.
  target: RunnerHandle;
  // The bootstrapped template workspace on the runner (positive controls run here).
  workspacePath: string;
  // Where the negative-control scratch copies are made (reaper-protected, torn down
  // with the run).
  scratchRoot: string;
  // The resolved `.tanren/ci.yml` config for the built template (the harness reads
  // its tiers/bootstrap).
  config: CiConfigV1;
  // The build's optional non-default build step (`just build` by convention).
  buildStep?: { name: string; run: string };
  // The auditor seam over the built template (the spec-loop auditor at the real
  // call site; a stub in tests).
  auditor: TemplateAuditor;
  // RELEASE the validation runner — the allocator teardown for the runner this handle
  // was allocated on. The creation flow MUST call this in a `finally` after validation
  // (pass OR fail) so the validation runner is never LEAKED (the audit §3.11/4 finding:
  // `engine/templates/**` had zero `allocator.release`). Idempotent + best-effort: a
  // release failure is logged, never thrown (it must not mask a validation result). A
  // test stub that allocated nothing supplies a no-op.
  release: () => Promise<void>;
}

// The BUILD SEAM. Given the derived template-build project id (+ its org), drive
// it to a converged conforming repo and return the validation handle. The real
// implementation runs the project's DAG through the existing run path; tests inject
// a stub. A throw (build failed / did not converge) is LOUD — the creation flow
// aborts WITHOUT publishing.
export interface TemplateBuildDriver {
  build(input: { orgId: string; projectId: string; runId?: string }): Promise<BuiltTemplate>;
}

// Thrown when the build driver could not produce a converged conforming repo. A
// LOUD failure surfaced by the creation flow — never a quiet "publish anyway".
export class TemplateBuildFailedError extends Error {
  readonly projectId: string;
  constructor(projectId: string, cause: string) {
    super(`template build did not converge for project ${projectId}: ${cause}`);
    this.name = "TemplateBuildFailedError";
    this.projectId = projectId;
  }
}
