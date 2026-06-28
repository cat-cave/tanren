// MATERIALIZE-COMPOSED-TEMPLATE — the single seam that pushes a fragment-composed
// VFS directly into the project repo as its initial content
// (docs/roadmap/templating-system.md).
//
// THE ONE PATH (PR-G — task #77, v62 finding). `selectFragmentConfig` resolves a
// `TemplateConfig` from the captured lifecycle; `composeTemplate(config, library)`
// assembles the VFS; this module PUSHES every composed file to the EXISTING project
// repo's default branch (the project repo has already been created by the derive's
// `resolveOrCreateGreenfieldRepo` step). No intermediate `tanren-tmpl-<slug>` seed
// repo is created — the composed VFS IS the project's initial state.
//
// COLLAPSE RATIONALE (PR-G). The pre-PR-G path created a per-stack template seed
// repo (`cat-cave/tanren-tmpl-<slug>`), pushed the composed VFS into it, then had
// the run path CLONE that seed repo into the project's workspace as a separate
// step. With fragments-as-primitive, the composed VFS IS the initial project state
// — the intermediate template repo was dead weight that added latency, created
// orphan repos when derive failed partway, and complicated the transactional
// rollback machinery (task #78, PR #695). The single intended path is now:
//   create project repo → compose VFS → push VFS directly to project repo.
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

// The plumbing the materializer needs to PUSH every composed file. Injected by the
// route layer (the GitHub HTTP client + App-token resolver live there); the engine
// layer (and tests) only sees the typed shape.
export interface MaterializeDeps {
  /**
   * Push ONE composed-VFS file to the PROJECT repo's default branch. Production
   * wires this to a contents-API PUT (see `buildLiveMaterializeTemplate` — the
   * same shape `FetchConfigInjectionGitHub.commitFile` already uses for the
   * brownfield config injector). Returns the resulting commit SHA so the
   * materializer can log its progress.
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
 * What materialize returns — the durable evidence a project was seeded from a
 * composed template. Persisted onto `projects.config.templateRef` so the
 * decision is OBSERVABLE on the project config (the run path no longer clones a
 * separate seed repo — the project repo already carries the composed files).
 *
 * `templateRef` is OPAQUE (`tanren://composed/<slug>@<contentHash>`): two
 * composes of the same config at different times share the same content hash
 * and thus the same ref; a fragment change forces a new hash. There is NO
 * `repoRef` field — no per-stack `tanren-tmpl-<slug>` GitHub repo exists. The
 * project repo IS the artifact.
 */
export interface SeededTemplate {
  /** `tanren://composed/<slug>@<sha256-prefix>` — opaque identifier; no repo
   * exists at this ref. The hash prefix is over the composed VFS's sorted
   * (path, content) bytes (deterministic — same input ⇒ same ref). */
  templateRef: string;
  /** ISO-8601 timestamp at which the seed was composed + pushed. */
  validatedAt: string;
}

/** The materializer input — what derive.ts gives the seam per call. */
export interface MaterializeInput {
  /** The composer config the VFS will be built from (curated lookup or
   * lifecycle-derived synthesis — `selectFragmentConfig` produced it). */
  config: TemplateConfig;
  /** The captured lifecycle that produced `config`. Carried through for the
   * observability log line. */
  lifecycle: CaptureLifecycle;
  /** The JUST-CREATED project repo the composed VFS is pushed into. The derive
   * creates this via `input.createRepository` (the `CodeHost.createRepo` seam)
   * BEFORE calling materialize, so the materializer's only job is the push. */
  projectRepo: {
    repoUrl: string;
    defaultBranch: string;
    fullName: string;
  };
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
 * `mountFeatureRoutes` with a contents-API `pushFile`. Tests construct it with
 * an in-memory fake.
 *
 * Flow:
 *   1. `composeTemplate(input.config, library)` — assemble the VFS in memory. A
 *      compose failure throws loud (the config references a broken fragment +
 *      the validation gate should have caught it).
 *   2. Push every composed file to the project repo's default branch in stable
 *      path order. The contents-API PUT is idempotent on a re-attach (it reads
 *      the existing blob SHA and updates).
 *   3. Return a `SeededTemplate` with the content hash + the ISO timestamp.
 */
export function buildMaterializeTemplate(deps: MaterializeDeps): MaterializeTemplate {
  return async (input: MaterializeInput): Promise<SeededTemplate> => {
    const { config, projectRepo } = input;
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

    // STEP 2 — PUSH every composed file to the project repo's default branch.
    const flat = vfs.toFlatMap();
    const paths = Object.keys(flat);
    for (const path of paths) {
      const content = flat[path] ?? "";
      await deps.pushFile({
        repoUrl: projectRepo.repoUrl,
        defaultBranch: projectRepo.defaultBranch,
        path,
        content,
        message: `tanren compose: ${path}`,
      });
    }

    const contentHash = vfs.hash().slice(0, 16);
    const validatedAt = clock().toISOString();
    log.info("composed + materialized template directly into project repo", {
      configSlug: config.slug,
      stack: input.lifecycle.stack,
      projectRepo: projectRepo.fullName,
      files: paths.length,
      contentHash,
    });

    return {
      templateRef: `tanren://composed/${config.slug}@${contentHash}`,
      validatedAt,
    };
  };
}
