// DERIVE TRANSACTIONAL ROLLBACK — Option A from task #78. The greenfield derive
// creates an external project repo before persisting the durable project DB row
// that anchors a resume. If a later step fails, that repository can be stranded
// as an operator-visible orphan that the next retry collides on.
//
// THE FIX: the repository create REGISTERS a typed compensation on a LIFO stack.
// If derive throws afterward, the stack is walked before the original error is
// re-raised. This module deliberately makes no claim about provider-resource
// teardown; the removed legacy deploy-app destroy callback is not emulated here.
//
// DOCTRINE:
//   1. The repository create MUST register its compensation synchronously after
//      success. Forgetting to register is a wiring bug.
//   2. A compensation is IDEMPOTENT — the underlying `deleteRepo` primitive
//      treats a 404 as success — so the walker may safely run twice if
//      something exotic happens (a finally-in-finally pattern).
//   3. The walker NEVER hides the original failure. The original `Error` re-raises
//      verbatim; rollback gaps (a compensation that ALSO failed) ride on the
//      raised error's `cause`/`compensationFailures` so they reach the operator.
//   4. A SUCCESSFUL derive does NOT rollback — the durable project row is the
//      completion anchor; the resources it carries are no longer "tentative."
//
// SCOPE: this module is the pure data-structure + walker. The compensation
// function itself (`deleteRepo`) is wired by the route layer where the GitHub
// client lives.

import { createLogger } from "../../observability/logger.js";
import { GreenfieldRepoNotEmptyError, type CreatedRepository } from "../../contracts/codeHostTypes.js";

const log = createLogger("derive-compensation");

/**
 * The KIND tag carried on every registered compensation, used for observability
 * + the rollback-gap error message so a failing compensation names what it
 * tried to roll back ("the project repo at cat-cave/linkly").
 */
// `github.repo` — the forge project repo.
export type CompensationKind = "github.repo";

/**
 * The COMPENSATION CALLBACK for a github repo create. The route layer wires this
 * against `CodeHost.deleteRepo` (the GitHub impl maps to `DELETE /repos/{o}/{n}`);
 * tests inject a fake against an in-memory fixture. IDEMPOTENT per the contract —
 * a target that no longer exists is a successful no-op (404 → success).
 */
export type DeleteRepositoryCallback = (target: { owner: string; name: string }) => Promise<void>;

/**
 * One registered rollback step. The compensation closure captures whatever it
 * needs to undo the create; the engine reasons only about the kind + label.
 */
export interface DeriveCompensationStep {
  kind: CompensationKind;
  /** Human-readable label for logs + the rollback-gap error (e.g. `cat-cave/linkly`). */
  label: string;
  /** The rollback. Idempotent — a 404 (already-gone) MUST be a successful no-op. */
  rollback: () => Promise<void>;
}

/**
 * A compensation that ran during rollback but FAILED. Surfaced on the derive
 * error so the operator knows EXACTLY which resource the rollback could not
 * remove (and must hand-delete). Never silently swallowed.
 */
export interface CompensationFailure {
  kind: CompensationKind;
  label: string;
  error: unknown;
}

/**
 * The compensation stack the derive registers steps onto. It remains a LIFO
 * primitive even though the current clean-replaced derive registers one repo.
 */
export interface DeriveCompensation {
  /**
   * Register a rollback for a JUST-CREATED external resource. Call IMMEDIATELY
   * after the create succeeds — a create that throws should not be registered
   * (there is nothing to roll back). The rollback runs in LIFO order on a derive
   * failure, and never on success.
   */
  register(step: DeriveCompensationStep): void;
  /**
   * Walk every registered compensation in LIFO order. Each runs to completion
   * (a failure does NOT stop the walk — every other step still gets a chance to
   * clean up its resource). Returns the list of compensations that failed so the
   * caller can surface the rollback gap on the re-raised error.
   *
   * NEVER called from the derive's success path — the project DB row is the
   * durable completion anchor and the resources are no longer tentative.
   */
  rollback(): Promise<CompensationFailure[]>;
  /** The currently-registered step count (for observability / debugging). */
  pendingCount(): number;
}

/**
 * Build a fresh, empty compensation stack. Each derive invocation builds its
 * own — they are NOT shared across invocations (a recursive derive would build
 * its own atomic unit).
 */
export function newDeriveCompensation(): DeriveCompensation {
  const stack: DeriveCompensationStep[] = [];
  return {
    register(step: DeriveCompensationStep): void {
      stack.push(step);
    },
    pendingCount(): number {
      return stack.length;
    },
    async rollback(): Promise<CompensationFailure[]> {
      const failures: CompensationFailure[] = [];
      // LIFO walk — pop until empty. Each compensation runs in its own try/catch so
      // a failure does not halt the rest of the walk (every other resource still
      // gets a chance to be cleaned up). A failure is recorded LOUD onto the failure
      // list + a warn log; never silently swallowed.
      while (stack.length > 0) {
        const step = stack.pop();
        if (step === undefined) break;
        try {
          await step.rollback();
        } catch (error) {
          failures.push({ kind: step.kind, label: step.label, error });
          log.warn(
            `derive compensation FAILED for ${step.kind} ${step.label} — rollback gap surfaced ` +
              `on the derive error; the resource may be orphaned and need manual cleanup`,
            { kind: step.kind, label: step.label },
            error,
          );
        }
      }
      return failures;
    },
  };
}

/**
 * The error the derive throws when its rollback walked some compensations + at
 * least one of those FAILED. The original failure is preserved as `cause` so an
 * `instanceof` chain walker still recovers the root cause; the `compensationFailures`
 * field names every resource the rollback could not undo. The route layer maps
 * this onto a single LOUD response so the operator sees both the original error
 * + the rollback gap (never the original buried behind a generic 500).
 */
export class DeriveRollbackError extends Error {
  readonly compensationFailures: ReadonlyArray<CompensationFailure>;
  constructor(originalError: unknown, compensationFailures: ReadonlyArray<CompensationFailure>) {
    const original = originalError instanceof Error ? originalError.message : String(originalError);
    const gaps = compensationFailures
      .map((f) => `${f.kind}=${f.label} (${f.error instanceof Error ? f.error.message : String(f.error)})`)
      .join(", ");
    super(
      `derive failed (${original}); transactional rollback walked but ${String(compensationFailures.length)} ` +
        `compensation(s) FAILED — the following resources may be orphaned: ${gaps}`,
    );
    this.name = "DeriveRollbackError";
    if (originalError instanceof Error) this.cause = originalError;
    this.compensationFailures = compensationFailures;
  }
}

// GREENFIELD RE-ATTACH GUARD (apex v84) — lives with the compensation semantics
// because it decides the ONE case that registers NO delete compensation: a re-attach.
// On a `RepositoryAlreadyExistsError` the derive may RE-ATTACH to the existing repo,
// but ONLY when it is the stranded, empty `auto_init` seed a crashed prior attempt
// left. A repo already full of a PRIOR run's `tanren compose:` history must NOT be
// silently reused: pushing THIS run's compose commits on top produces a cross-run
// BASE DIVERGENCE that later fails "prepare clean PR branch" with an opaque
// `WorkspaceCommandError`. We never auto-clean/force-reset a repo we did not create
// THIS run (that would destroy operator data).

/**
 * Resolve the RE-ATTACH target for a greenfield repo that already exists (a
 * `RepositoryAlreadyExistsError` on create + no bound project). Runs the emptiness
 * probe and returns the re-attach `CreatedRepository` ONLY when the repo is the bare
 * `auto_init` seed; throws {@link GreenfieldRepoNotEmptyError} when it already carries
 * content. A missing probe (while a create is wired) is a loud WIRING BUG — never a
 * silent fall-through to the unguarded reuse.
 */
export async function resolveGreenfieldReattach(
  owner: string,
  slug: string,
  deterministicRepoUrl: string,
  probeRepoBareAutoInit: ((target: { owner: string; name: string }) => Promise<boolean>) | undefined,
): Promise<CreatedRepository> {
  if (probeRepoBareAutoInit === undefined) {
    throw new Error("greenfield re-attach requires a repo-emptiness probe (probeRepoBareAutoInit) but none was wired");
  }
  if (!(await probeRepoBareAutoInit({ owner, name: slug }))) {
    throw new GreenfieldRepoNotEmptyError(owner, slug);
  }
  // The stranded-empty case: re-attach. The caller registers NO compensation.
  return { fullName: `${owner}/${slug}`, repoUrl: deterministicRepoUrl, defaultBranch: "main" };
}
