// MATERIALIZE-COMPOSED-TEMPLATE — the single seam that turns a fragment-composed
// VFS into a real seed repo a project can be cloned/seeded from
// (docs/roadmap/templating-system.md).
//
// THE ONE PATH. `selectFragmentConfig` resolves a `TemplateConfig` from the
// captured lifecycle; `composeTemplate(config, library)` assembles the VFS; this
// module CREATES the seed repo + PUSHES every composed file. The returned
// `SeededTemplate` is the durable evidence the project will seed from.
//
// VALIDATION POSTURE. A composed template is "validated by construction" — the
// composer's `assertBaseInvariantsHeld` post-process re-checks every
// `BASE_PROTECTED_FILES` path, `processCiYml` throws when no fragment declared a
// test runner, and the dogfood snapshot test in CI catches a fragment regression
// at PR time. Per-fragment authoring runs (F2 — `selectFragmentConfig` returning a
// `missing-fragments` decision) validate each new fragment in isolation via PR-D's
// harness BEFORE it lands in the org store, so an authored fragment is provably
// valid by the time the compose runs over it.

import { composeTemplate } from "./compose.js";
import { type FragmentLibrary, type TemplateConfig, type VirtualFileSystem } from "./types.js";
import { loadFragmentLibrary } from "./library/index.js";
import type { CaptureLifecycle } from "../../forge/interview/types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("template-fragments-materialize");

// The plumbing the materializer needs to actually CREATE + PUSH. Both are injected
// by the route layer (the GitHub HTTP client + App-token resolver live there); the
// engine layer (and tests) only sees the typed shapes.
export interface MaterializeDeps {
  /**
   * Create a fresh template repo on the forge. Reuses the SAME `createRepository`
   * primitive the greenfield route calls (the `CodeHost.createRepo` seam). The
   * returned `repoUrl` is the HTTPS clone URL + `defaultBranch` is the branch
   * `auto_init` seeded.
   */
  createTemplateRepo: (input: {
    owner: string;
    name: string;
    description: string;
    private: boolean;
  }) => Promise<{ repoUrl: string; defaultBranch: string; fullName: string }>;
  /**
   * Push ONE file to the template repo's default branch. Production wires this to a
   * contents-API PUT (see `buildLiveMaterializeTemplate` — the same shape
   * `FetchConfigInjectionGitHub.commitFile` already uses for the brownfield config
   * injector). Returns the resulting commit SHA so the FINAL SHA of the push set
   * can ride on the seeded-template record as `validatedSha`.
   */
  pushFile: (input: {
    repoUrl: string;
    defaultBranch: string;
    path: string;
    content: string;
    message: string;
  }) => Promise<{ commitSha: string }>;
}

/**
 * What materialize returns — the durable evidence a project is seeded from a
 * composed template. Persisted onto `projects.config.templateRef` so the run path
 * clones from `repoRef` (workspace/templateSeed.ts) before the writer starts.
 *
 * Replaces the previous `SelectedTemplate` shape from the now-deleted
 * `templateSelection.ts`. The doctrine-collapse removed the registry-of-templates
 * concept entirely — there are only fragments + composed seeds — so the proof
 * narrative collapses too: a seed is provably valid by COMPOSITION (the composer's
 * post-process invariants) + by ANCESTRY (every fragment was validated in
 * isolation before reaching the library), not by a runtime negative-control sweep.
 */
export interface SeededTemplate {
  /** Stable identifier the project records on its config. Form:
   * `tanren://composed/<slug>@<sha>` so two seeds of the same config at different
   * times are distinguishable. */
  templateRef: string;
  /** GitHub `<owner>/<name>` of the seed repo the run path clones from. */
  repoRef: string;
  /** ISO timestamp at which the seed was composed + pushed. */
  validatedAt: string;
  /** The final commit SHA on the seed repo's default branch (the deterministic
   * head of the materialize push set). */
  validatedSha: string;
}

/** The materializer input — what derive.ts gives the seam per call. */
export interface MaterializeInput {
  /** The composer config the seed will be built from (curated lookup or
   * lifecycle-derived synthesis — `selectFragmentConfig` produced it). */
  config: TemplateConfig;
  /** The captured lifecycle that produced `config`. Carried through for the repo
   * description + observability. */
  lifecycle: CaptureLifecycle;
  /** The GitHub owner the seed repo will be created under (the derive request's
   * owner — `mountFeatureRoutes` threads it from the auth context). */
  owner: string;
  /** Override the production bundled library (e.g. inject a unified library that
   * combines bundled + org-scoped fragments per F2's `loadFragmentLibrary(orgId)`).
   * When omitted, the bundled library is used. */
  library?: FragmentLibrary;
  /** Compose-time clock (injectable for deterministic tests). */
  now?: () => Date;
}

/** The seam shape the derive layer holds — a callback the route wiring fills. */
export type MaterializeTemplate = (input: MaterializeInput) => Promise<SeededTemplate>;

/**
 * Build the LIVE compose+materialize seam. Production wires this in
 * `mountFeatureRoutes` with the App-token-scoped `createTemplateRepo` + a
 * contents-API `pushFile`. Tests construct it with in-memory fakes.
 *
 * Flow:
 *   1. `composeTemplate(input.config, library)` — assemble the VFS. A compose
 *      failure throws loud (the config references a broken fragment + the
 *      validation gate should have caught it).
 *   2. Create the seed repo via `deps.createTemplateRepo`.
 *   3. Push every composed file to the default branch in stable path order.
 *   4. Return a `SeededTemplate` with the head SHA + the ISO timestamp.
 */
export function buildMaterializeTemplate(deps: MaterializeDeps): MaterializeTemplate {
  return async (input: MaterializeInput): Promise<SeededTemplate> => {
    const { config, owner } = input;
    const clock = input.now ?? (() => new Date());

    // STEP 1 — COMPOSE.
    const library = input.library ?? loadFragmentLibrary();
    let vfs: VirtualFileSystem;
    try {
      vfs = await composeTemplate(config, library);
    } catch (cause) {
      const err = new Error(`composeTemplate failed for config "${config.slug}": ${String(cause)}`);
      if (cause instanceof Error) err.cause = cause;
      throw err;
    }

    // STEP 2 — CREATE REPO.
    const repoName = templateRepoName(config.slug);
    const created = await deps.createTemplateRepo({
      owner,
      name: repoName,
      description: `Tanren composed template (${input.lifecycle.stack}) — generated by the fragment composer`,
      private: true,
    });

    // STEP 3 — PUSH every composed file.
    const flat = vfs.toFlatMap();
    const paths = Object.keys(flat);
    let lastCommitSha = "";
    for (const path of paths) {
      const content = flat[path] ?? "";
      const result = await deps.pushFile({
        repoUrl: created.repoUrl,
        defaultBranch: created.defaultBranch,
        path,
        content,
        message: `tanren compose: ${path}`,
      });
      lastCommitSha = result.commitSha;
    }

    const validatedAt = clock().toISOString();
    const validatedSha = lastCommitSha === "" ? "compose" : lastCommitSha;
    log.info("composed + materialized template", {
      configSlug: config.slug,
      stack: input.lifecycle.stack,
      repoFullName: created.fullName,
      files: paths.length,
      validatedSha,
    });

    return {
      templateRef: `tanren://composed/${config.slug}@${validatedSha}`,
      repoRef: created.fullName,
      validatedAt,
      validatedSha,
    };
  };
}

// Project the config slug onto a forge-safe repo name, hard-capping at 80 chars
// (GitHub's repo-name cap is 100; we leave headroom for any future suffixes).
function templateRepoName(slug: string): string {
  const base = `tanren-tmpl-${slug}`.toLowerCase().replaceAll(/[^a-z0-9-]+/gu, "-");
  return base.slice(0, 80);
}
