// DERIVE TRANSACTIONAL ROLLBACK — Option A from task #78. The greenfield derive
// creates several external resources (the template seed repo + the project repo +
// the deploy app) before persisting the durable project DB row that anchors a
// resume. If ANY step after a successful external create fails, the resources
// it produced are stranded as operator-visible orphans that the next retry then
// collides on (apex v62 — the operator hand-deleted `cat-cave/linkly` to get
// past a 422 on the template repo create).
//
// THE FIX: derive runs ATOMICALLY across its external resources. Each successful
// create REGISTERS a compensation (a typed rollback function) on a LIFO stack;
// if the derive throws anywhere after that, the stack is WALKED in reverse and
// every compensation fires before the original error is re-raised. The operator
// sees the original failure verbatim — but the side effects are gone, so a clean
// retry succeeds without manual cleanup.
//
// DOCTRINE:
//   1. Every external create that happens in derive MUST register a compensation
//      synchronously after success. Forgetting to register is a wiring bug.
//   2. A compensation is IDEMPOTENT — the underlying `deleteRepo` / `destroyApp`
//      primitives treat a 404 as success — so the walker may safely run twice if
//      something exotic happens (a finally-in-finally pattern).
//   3. The walker NEVER hides the original failure. The original `Error` re-raises
//      verbatim; rollback gaps (a compensation that ALSO failed) ride on the
//      raised error's `cause`/`compensationFailures` so they reach the operator.
//   4. A SUCCESSFUL derive does NOT rollback — the durable project row is the
//      completion anchor; the resources it carries are no longer "tentative."
//
// SCOPE: this module is the pure data-structure + walker. The compensation
// functions themselves (the `deleteRepo` / `destroyApp` callbacks) are wired by
// the route layer where the GitHub HTTP client + the deploy provisioner live.

import { createLogger } from "../../observability/logger.js";

const log = createLogger("derive-compensation");

/**
 * The KIND tag carried on every registered compensation, used for observability
 * + the rollback-gap error message so a failing compensation names what it
 * tried to roll back ("the project repo at cat-cave/linkly").
 */
// `github.repo` — a forge repo (project repo or template seed repo).
// `deploy.app` — a deploy provider app (Fly / Vercel).
export type CompensationKind = "github.repo" | "deploy.app";

/**
 * The COMPENSATION CALLBACK for a github repo create. The route layer wires this
 * against `CodeHost.deleteRepo` (the GitHub impl maps to `DELETE /repos/{o}/{n}`);
 * tests inject a fake against an in-memory fixture. IDEMPOTENT per the contract —
 * a target that no longer exists is a successful no-op (404 → success).
 */
export type DeleteRepositoryCallback = (target: { owner: string; name: string }) => Promise<void>;

/**
 * The COMPENSATION CALLBACK for a deploy app provision. The route layer wires
 * this against `DeployProvisioner.destroyApp` (which delegates to Fly / Vercel
 * delete primitives); tests inject a fake. IDEMPOTENT per the contract — a
 * target that no longer exists is a successful no-op.
 *
 * Carries BOTH `appId` and `appName` because the two providers key on
 * different attributes: Vercel's DELETE goes to `/v9/projects/{id}` (id), Fly's
 * to `/v1/apps/{name}` (name). Fly's `listApps` returns `appId: app.id ?? app.name`,
 * which is typically the distinct internal id (e.g. `fly_app_1`), so a synthesis
 * that filled `name` from `appId` would route the DELETE at the wrong path —
 * Fly would 404 and the per-provider arm would swallow it as "already-gone
 * success" (audit finding D4, the regression PR #711 reintroduced once it
 * dropped the listApps gate).
 */
export type DestroyDeployAppCallback = (target: {
  providerKind: "deploy.vercel" | "deploy.flyio";
  appId: string;
  appName: string;
}) => Promise<void>;

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
 * The compensation stack the derive registers steps onto. LIFO walk — the last
 * resource created is the first one undone (which matches the natural ordering
 * for cleanup: e.g. destroy the deploy app before deleting the project repo).
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
