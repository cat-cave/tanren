// PER-FRAGMENT AUTHORING DAG (docs/roadmap/templating-system.md — F2).
//
// When `selectFragmentConfig` returns `{ kind: "missing-fragments", missing }`,
// the derive spawns ONE authoring run PER missing fragment. Each authoring run
// produces a validated `Fragment` the org's `fragments` table persists; the
// unified library loader picks it up on the retry.
//
// THE DAG SHAPE per fragment: PLAN (the `FragmentSpec` IS the plan) → WRITE (the
// `FragmentAuthorer` seam iterates on a body; each VALIDATE rejection feeds back
// as `previousAttempt`; UNBOUNDED while making progress, halts at a FIXED POINT
// — no iteration cap, per the timeout-eradication doctrine) → VALIDATE (parse
// body via `interpretOrgFragment`, run BOTH the isolated + full-library smoke
// compositions; pass ⇒ persist as validated ATOMICALLY). On fixed-point failure
// `failedIds` lets `resolveFragmentConfig` halt loud with
// `FragmentAuthoringFailedError` — NEVER silent-skip.

import type { ActorContext } from "../../../auth/schemas.js";
import { canonicalizeBodySignature } from "./canonicalizeBody.js";
import { deriveImplicitDependsOn } from "./implicitDependsOn.js";
export { deriveImplicitDependsOn } from "./implicitDependsOn.js";
import { loadFragmentLibrary } from "./library/index.js";
import { deriveRuntimeLanguage, unsupportedRuntimeLanguageReason } from "./runtimeLanguage.js";
import { runRuntimeValiditySmoke, type RuntimeValiditySmokeDeps } from "./runtimeValiditySmoke.js";
import {
  runFullLibrarySmokeComposition,
  runSmokeComposition,
  type SmokeFailed,
  type SmokeOk,
} from "./smokeComposition.js";
import { type Fragment, type FragmentLibrary } from "./types.js";
import type { FragmentSpec } from "./selectFragmentConfig.js";
import {
  type FragmentOp,
  interpretOrgFragment,
  FragmentBodyParseError,
  type OrgFragmentSource,
  parseFragmentBody,
} from "./unifiedLibrary.js";
import { type CaptureLifecycle } from "../../forge/interview/types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("fragment-authoring");

// ── Public seam ─────────────────────────────────────────────────────────────

// F2 prompt-hardening context types (extracted to keep this file under the 500-line cap).
export type { PriorFragment, ProductContext } from "./fragmentAuthoringContextTypes.js";
import type { PriorFragment, ProductContext } from "./fragmentAuthoringContextTypes.js";

/** Input the derive hands the authoring runner. */
export interface FragmentAuthoringInput {
  orgId: string;
  actor: ActorContext;
  missing: readonly FragmentSpec[];
  lifecycle: CaptureLifecycle;
  /** OPTIONAL semi-structured product context. Passed through to each per-fragment
   * writer prompt so the writer can make domain-informed defaults. Absent ⇒ the
   * prompt omits the product-context section cleanly (v50 tests, non-derive
   * callers). */
  productContext?: ProductContext;
}

/** What the authoring runner returns to the derive. */
export interface FragmentAuthoringResult {
  /** The augmented library (bundled core + the freshly-authored org fragments).
   * `derive.ts` retries `selectFragmentConfig` against this library. */
  library: FragmentLibrary;
  /** Ids the authoring runner could not produce a valid fragment for. The derive
   * halts loud (FragmentAuthoringFailedError) when this is non-empty. */
  failedIds: string[];
  /** Per-fragment-id: the LAST writer rejection captured at the fixed point. The
   * derive surfaces this in the 409 body so the operator sees WHY F2 halted (v66 fix). */
  failureReasons: Record<string, string>;
}

export type FragmentAuthoring = (input: FragmentAuthoringInput) => Promise<FragmentAuthoringResult>;

// ── The single-fragment authoring loop ──────────────────────────────────────

/** What a single `FragmentAuthorer` call sees. */
export interface FragmentAuthorerInput {
  /** The slot the fragment must fill. */
  spec: FragmentSpec;
  /** The captured lifecycle (for context — the authorer may use it to ground its
   * choices, e.g. read the stack/deploy commands to make sane defaults). */
  lifecycle: CaptureLifecycle;
  /** When set, the previous attempt's body + why it was rejected. Drives the
   * writer-rework loop: the next attempt is informed by what failed. Absent on
   * the first attempt. */
  previousAttempt?: { bodyTs: string; rejection: string };
  /** OPTIONAL: the prior validated fragments in the org — the writer renders them
   * as a "these worked before, follow the shape" section so a subsequent slot
   * aligns structurally with what has previously validated. Absent / empty ⇒ the
   * section is omitted. */
  priorFragments?: readonly PriorFragment[];
  /** OPTIONAL: the semi-structured product context (acceptance criteria + personas
   * + behaviors) the derive path threads through so the writer makes
   * domain-informed defaults. */
  productContext?: ProductContext;
}

/** What a `FragmentAuthorer` returns. */
export interface FragmentAuthorerOutput {
  /** The fragment's TS source — a default-exported `Fragment` object whose
   * `apply()` body uses ONLY the constrained-subset operations
   * `unifiedLibrary.ts` parses. */
  bodyTs: string;
}

/** The seam the wiring layer fills — production calls an LLM-backed authorer; the
 * in-memory authorer (`buildInMemoryFragmentAuthorer`) below is the deterministic
 * test seam. */
export type FragmentAuthorer = (input: FragmentAuthorerInput) => Promise<FragmentAuthorerOutput>;

/** The persistence seam — production wires this to `FragmentsStore.createValidated`
 * under an org-scoped `QueryClient`. Tests inject an in-memory map.
 *
 * ATOMIC by contract (audit finding H2 — task #150): the single `createValidated`
 * call inserts the row with `status='validated'` + `validated_at=now()` in ONE
 * transaction. A throw between the previous two-step insert-as-draft +
 * markValidated pattern could leave an orphaned draft row that the loader
 * silently ignored; this seam eliminates that race by construction. */
export interface FragmentPersistence {
  createValidated(input: {
    orgId: string;
    spec: FragmentSpec;
    bodyTs: string;
    contract: FragmentSpec["requiredContract"];
    dependsOn: readonly string[];
  }): Promise<{ fragmentId: string }>;
}

/** Length ceiling for the per-attempt `bodyPreview` field. The Zod schema mirrors
 * this constant (`FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX`); centralized here
 * so the emit site + the tests import ONE symbol. */
export const FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX = 500;

/** What the writer-rework loop decided after one iteration. */
export type FragmentAuthoringAttemptDecision = "continue" | "converged" | "halted_fixed_point";

/** The event-stream seam — wire to the durable event store so authoring runs are
 * observable. Tests use a noop. */
export interface FragmentAuthoringEvents {
  emit(
    event:
      | { kind: "fragment.authoring.started"; orgId: string; fragmentId: string; spec: FragmentSpec }
      | {
          kind: "fragment.authoring.attempt";
          orgId: string;
          fragmentId: string;
          attempt: number;
          bodyPreview: string;
          canonicalSignature: string;
          rejection: string;
          decision: FragmentAuthoringAttemptDecision;
        }
      | { kind: "fragment.authoring.succeeded"; orgId: string; fragmentId: string; attempts: number }
      | { kind: "fragment.authoring.failed"; orgId: string; fragmentId: string; reason: string; attempts: number },
  ): Promise<void>;
}

/** Dependencies the runner is built with. */
export interface FragmentAuthoringDeps {
  authorer: FragmentAuthorer;
  persistence: FragmentPersistence;
  events: FragmentAuthoringEvents;
  /** OPTIONAL: the seam that surfaces prior VALIDATED fragments for the caller's
   * org so the F2 writer prompt renders a "these have worked before" section.
   * Production wires this to `FragmentsStore.listValidatedByOrg` under an
   * org-scoped `QueryClient`; tests / callers with no prior context leave it
   * undefined ⇒ the writer prompt omits the section cleanly. Returning `[]` is
   * equivalent to omitting the seam. */
  priorFragmentsLookup?: (orgId: string) => Promise<readonly PriorFragment[]>;
  /** Optional runtime-validity smoke deps. When absent, the runtime-validity
   * step is SKIPPED with an explicit log — the composition-validity smokes
   * still run. Production wires the real pnpm/bundle subprocess seams here so
   * the writer's declared deps are proved resolvable BEFORE the fragment
   * persists; tests either omit this (skip the runtime step entirely) or wire
   * a fake invoker to assert the pipeline behavior. */
  runtimeValiditySmoke?: RuntimeValiditySmokeDeps;
}

/** Build the authoring runner. The returned function processes the missing list
 * sequentially: an authoring failure on one fragment doesn't stop the others
 * (they may be independent), so the caller sees the full failedIds list at the
 * end rather than the first-failure short-circuit. */
export function buildFragmentAuthoring(deps: FragmentAuthoringDeps): FragmentAuthoring {
  return async (input: FragmentAuthoringInput): Promise<FragmentAuthoringResult> => {
    const failedIds: string[] = [];
    const failureReasons: Record<string, string> = {};
    const authored: OrgFragmentSource[] = [];

    // Look up prior validated fragments ONCE per authoring run — the list is
    // stable for the duration of this call (the F2 loop is org-scoped, no other
    // writer runs concurrently for the same org). If the seam is absent OR
    // throws (e.g. a transient DB blip), we degrade to an empty list rather than
    // failing the whole authoring run — the prior-fragments context is a
    // hint-shaped enrichment, not load-bearing. A throw is logged as a warning
    // so the operator sees it in the run log.
    let priorFragments: readonly PriorFragment[] = [];
    if (deps.priorFragmentsLookup !== undefined) {
      try {
        priorFragments = await deps.priorFragmentsLookup(input.orgId);
      } catch (err) {
        log.warn("prior fragments lookup threw — proceeding with empty prior context", {
          orgId: input.orgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const spec of input.missing) {
      const outcome = await authorOneFragment({
        spec,
        lifecycle: input.lifecycle,
        orgId: input.orgId,
        deps,
        priorFragments,
        ...(input.productContext === undefined ? {} : { productContext: input.productContext }),
      });
      if (outcome.kind === "ok") {
        authored.push(outcome.source);
      } else {
        failedIds.push(spec.id);
        failureReasons[spec.id] = outcome.reason;
      }
    }

    // Assemble the augmented library: bundled core + every freshly-authored
    // fragment from this run. We don't reach into the DB seam here — the caller's
    // next `selectFragmentConfig` call will go through the unified loader and see
    // these via the DB; but for the IMMEDIATE retry inside the same derive call we
    // construct the library directly from `authored` (avoids a round-trip).
    const library = loadFragmentLibrary();
    for (const source of authored) {
      const fragment = interpretOrgFragment(source);
      if (library.has(fragment.id)) {
        library.replaceForTests(fragment);
      } else {
        library.register(fragment);
      }
    }

    return { library, failedIds, failureReasons };
  };
}

/** Truncate a fragment body to the `bodyPreview` ceiling for the per-attempt
 * event. Under the limit is passed through verbatim; over the limit is sliced
 * to the ceiling with a trailing ellipsis (visible-in-payload marker that the
 * body was cut). Exported for tests + shared by the emit path. */
export function truncateBodyPreview(body: string): string {
  if (body.length <= FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX) return body;
  return `${body.slice(0, FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX)}…`;
}

interface AuthorOneArgs {
  spec: FragmentSpec;
  lifecycle: CaptureLifecycle;
  orgId: string;
  deps: FragmentAuthoringDeps;
  /** Prior validated fragments in the org (looked up once at the top of the run
   * and threaded through). Empty ⇒ the writer prompt omits the section. */
  priorFragments: readonly PriorFragment[];
  /** Optional product context threaded from the derive path (acceptance criteria
   * + personas + behaviors). Absent ⇒ the writer prompt omits the section. */
  productContext?: ProductContext;
}

type AuthorOneOutcome = { kind: "ok"; source: OrgFragmentSource } | { kind: "failed"; reason: string };

async function authorOneFragment(args: AuthorOneArgs): Promise<AuthorOneOutcome> {
  const { spec, lifecycle, orgId, deps, priorFragments, productContext } = args;

  // FAIL-FAST language check (apex v72 fix). A runtime fragment whose target
  // language has no test-file recognizer will never pass the smoke composition —
  // halt LOUD with `unsupported_runtime_language` BEFORE the first LLM call.
  if (spec.kind === "runtime" && deriveRuntimeLanguage(spec.label) === null) {
    const reason = unsupportedRuntimeLanguageReason(spec.label);
    await deps.events.emit({ kind: "fragment.authoring.failed", orgId, fragmentId: spec.id, reason, attempts: 0 });
    return { kind: "failed", reason };
  }

  await deps.events.emit({ kind: "fragment.authoring.started", orgId, fragmentId: spec.id, spec });

  // UNBOUNDED writer-rework loop while the writer is making PROGRESS (the body or
  // the rejection signature keeps changing). The loop stops ONLY at a FIXED POINT
  // (canonical body + identical rejection — no new information). NO iteration cap
  // (the timeout-eradication doctrine: a structural fixed-point is the bound).
  //
  // FIXED-POINT SIGNATURE (audit finding H1): the body is canonicalized before
  // hashing so whitespace/comment-only changes do NOT count as progress. See
  // `canonicalizeBody.ts` — structural (parsed ops) when parseable, lexical
  // fallback otherwise.
  let attempt = 0;
  let previousAttempt: { bodyTs: string; rejection: string } | undefined;
  let lastSignature: string | undefined;
  let lastRejection = "";

  for (;;) {
    attempt += 1;
    let output: FragmentAuthorerOutput;
    try {
      output = await deps.authorer({
        spec,
        lifecycle,
        ...(previousAttempt && { previousAttempt }),
        ...(priorFragments.length > 0 ? { priorFragments } : {}),
        ...(productContext === undefined ? {} : { productContext }),
      });
    } catch (err) {
      lastRejection = err instanceof Error ? err.message : String(err);
      log.warn("fragment authorer threw", { fragmentId: spec.id, attempt, error: lastRejection });
      const signature = `authorer-threw:${lastRejection}`;
      // Fixed point — not making progress; stop the inner loop.
      const isFixedPoint = signature === lastSignature;
      // Emit the per-iteration observability event even on the authorer-throw
      // branch: an operator debugging a stuck LLM sees WHICH iteration threw +
      // whether the loop is about to halt. bodyPreview is empty here (no body
      // was produced); canonicalSignature carries the `authorer-threw:*` marker.
      await deps.events.emit({
        kind: "fragment.authoring.attempt",
        orgId,
        fragmentId: spec.id,
        attempt,
        bodyPreview: "",
        canonicalSignature: signature,
        rejection: lastRejection,
        decision: isFixedPoint ? "halted_fixed_point" : "continue",
      });
      if (isFixedPoint) break;
      lastSignature = signature;
      previousAttempt = { bodyTs: previousAttempt?.bodyTs ?? "", rejection: lastRejection };
      continue;
    }
    const bodyTs = output.bodyTs;

    // VALIDATE.
    const validation = await validateFragmentBody({
      spec,
      bodyTs,
      ...(deps.runtimeValiditySmoke && { runtimeValiditySmoke: deps.runtimeValiditySmoke }),
    });
    const canonicalSignature = canonicalizeBodySignature(bodyTs);
    if (validation.kind === "ok") {
      // Emit the per-iteration observability event for the WINNING attempt
      // BEFORE persist — the timeline reads attempt→succeeded in order, so a
      // subscriber replaying can rebuild the trajectory even if persistence
      // throws after this point (the emit is idempotent-safe by construction).
      await deps.events.emit({
        kind: "fragment.authoring.attempt",
        orgId,
        fragmentId: spec.id,
        attempt,
        bodyPreview: truncateBodyPreview(bodyTs),
        canonicalSignature,
        rejection: "",
        decision: "converged",
      });
      const dependsOn = validation.dependsOn;
      const source: OrgFragmentSource = {
        fragmentId: `${orgId}:${spec.id}:1.0.0`,
        kind: spec.kind,
        label: spec.label,
        version: "1.0.0",
        bodyTs,
        contract: spec.requiredContract,
        dependsOn,
      };
      // ATOMIC persist (audit finding H2 — task #150). Single call, single
      // transaction — the row lands as `status='validated'` or nothing at all.
      // A throw here rolls back; the next attempt sees no orphaned draft.
      await deps.persistence.createValidated({
        orgId,
        spec,
        bodyTs,
        contract: spec.requiredContract,
        dependsOn,
      });
      await deps.events.emit({ kind: "fragment.authoring.succeeded", orgId, fragmentId: spec.id, attempts: attempt });
      return { kind: "ok", source };
    }

    lastRejection = validation.reason;
    const signature = `${canonicalSignature}:${lastRejection}`;
    const isFixedPoint = signature === lastSignature;
    // Emit the per-iteration observability event for the REJECTED attempt with
    // the loop's decision. `continue` ⇒ new information, another iteration
    // runs. `halted_fixed_point` ⇒ same canonical body + rejection, no
    // progress; the outer terminal `fragment.authoring.failed` follows.
    await deps.events.emit({
      kind: "fragment.authoring.attempt",
      orgId,
      fragmentId: spec.id,
      attempt,
      bodyPreview: truncateBodyPreview(bodyTs),
      canonicalSignature,
      rejection: lastRejection,
      decision: isFixedPoint ? "halted_fixed_point" : "continue",
    });
    if (isFixedPoint) {
      // FIXED POINT — canonical body + identical rejection ⇒ no new information.
      // Doctrine: a fixed point is NOT a transient.
      break;
    }
    lastSignature = signature;
    previousAttempt = { bodyTs, rejection: lastRejection };
  }

  await deps.events.emit({
    kind: "fragment.authoring.failed",
    orgId,
    fragmentId: spec.id,
    reason: lastRejection || "authoring did not converge",
    attempts: attempt,
  });
  return { kind: "failed", reason: lastRejection || "no rejection captured" };
}

// ── Validation pipeline ─────────────────────────────────────────────────────

/** Parse + smoke-compose the authored body. A pass proves: the body's structure
 * is the constrained subset; `interpretOrgFragment` builds a real Fragment;
 * that Fragment composes with the bundled library BOTH in isolation AND in the
 * full-library kitchen-sink (audit finding H5); AND — when the runtime-validity
 * seam is wired — the runtime's dependency resolver accepts the composed
 * scaffold (runtime-validity smoke — task added this PR). The persisted
 * `dependsOn` is DERIVED from the parsed ops (audit finding #11) so a fragment
 * that uses node-pnpm-only ops without declaring the runtime dep is caught here
 * rather than silently dropping deps in a later compose. */
async function validateFragmentBody(args: {
  spec: FragmentSpec;
  bodyTs: string;
  runtimeValiditySmoke?: RuntimeValiditySmokeDeps;
}): Promise<SmokeOk | SmokeFailed> {
  // 1) Parse — rejects bodies that step outside the constrained subset. We pull
  // ops separately to derive the implicit dependsOn (audit finding #11) and to
  // build the smoke Fragment with the correct dependsOn so the cross-runtime
  // pre-flight in `composeTemplate` sees the right shape.
  let ops: FragmentOp[];
  try {
    ops = parseFragmentBody(args.bodyTs);
  } catch (err) {
    const reason =
      err instanceof FragmentBodyParseError
        ? `body parse rejected: ${err.message}`
        : `body parse threw: ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "failed", reason };
  }

  // 2) Derive implicit `dependsOn` (audit #11) — see `implicitDependsOn.ts`.
  const derivedDependsOn = deriveImplicitDependsOn(ops, args.spec);

  // 3) Build the Fragment carrying derivedDependsOn so cross-runtime pre-flight sees it.
  let fragment: Fragment;
  try {
    fragment = interpretOrgFragment({
      fragmentId: `validate:${args.spec.id}:1.0.0`,
      kind: args.spec.kind,
      label: args.spec.label,
      version: "1.0.0",
      bodyTs: args.bodyTs,
      contract: args.spec.requiredContract,
      dependsOn: derivedDependsOn,
    });
  } catch (err) {
    const reason =
      err instanceof FragmentBodyParseError
        ? `body parse rejected: ${err.message}`
        : `body parse threw: ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "failed", reason };
  }

  // 4) Smoke-compose in isolation — the minimal config that exercises THIS
  // fragment. Post-compose runtime validators (ci.yml schema, fresh-checkout
  // bootstrap, pnpm non-interactive) run here.
  const isolated = await runSmokeComposition(args.spec, fragment, derivedDependsOn);
  if (isolated.kind !== "ok") return isolated;

  // 5) Full-library smoke — kitchen-sink compose (audit H5 — catches isolated-fine-but-composes-with-conflict).
  const full = await runFullLibrarySmokeComposition(args.spec, fragment, derivedDependsOn);
  if (full.kind !== "ok") return full;

  // 6) Runtime-validity smoke — the final gate; composition-validity ≠ runtime-validity.
  // Materializes the composed VFS + runs the runtime's dep resolver (e.g. pnpm install).
  // Skipped with a log when deps aren't wired (composition-validity tests).
  if (args.runtimeValiditySmoke === undefined) {
    log.info("runtime-validity smoke deps not wired — skipping", { specId: args.spec.id });
    return { kind: "ok", dependsOn: derivedDependsOn };
  }
  const runtime = await runRuntimeValiditySmoke({
    spec: args.spec,
    fragment,
    derivedDependsOn,
    deps: args.runtimeValiditySmoke,
  });
  if (runtime.kind !== "ok") return runtime;
  return { kind: "ok", dependsOn: derivedDependsOn };
}
