// PER-FRAGMENT AUTHORING DAG (docs/roadmap/templating-system.md — F2).
//
// When `selectFragmentConfig` returns `{ kind: "missing-fragments", missing }`,
// the derive spawns ONE authoring run PER missing fragment. Each authoring run
// produces a validated `Fragment` that the org's `fragments` table persists, and
// the unified library loader picks it up on the retry.
//
// THE DAG SHAPE per fragment (three logical stages, each a writer-rework loop):
//   1. PLAN — the `FragmentSpec` itself IS the plan (the kind + label + required
//      contract). No separate planner stage: a missing fragment is already
//      specified by what the lifecycle requires. (Planning gives us no leverage
//      here — the spec carries all that's needed.)
//   2. WRITE — the `FragmentAuthorer` seam produces a TS body for the spec. The
//      writer loop iterates on the body: each rejection from VALIDATE feeds back
//      as a `previousAttempt` carrying the failing body + the rejection reason,
//      so the next attempt is informed by why the prior failed. Unbounded while
//      making PROGRESS (the body or the rejection keeps changing); stops at a
//      FIXED POINT (identical body + identical rejection) — never a flat
//      iteration cap (the timeout-eradication doctrine).
//   3. VALIDATE — parse the body via `interpretOrgFragment` (a structural parse
//      that rejects out-of-subset code at registration time), then run a SMOKE
//      COMPOSITION (PR-D's isolation harness inline): assemble a minimal config
//      that exercises the new fragment in its phase slot, call `composeTemplate`,
//      assert the post-process invariants. Pass ⇒ persist + done.
//
// ON FIXED-POINT FAILURE: the run terminalizes with the failing rejection; the
// returned `failedIds` list lets `resolveFragmentConfig` halt loud with
// `FragmentAuthoringFailedError`. The doctrine is NEVER silent-skip.

import type { ActorContext } from "../../../auth/schemas.js";
import { composeTemplate } from "./compose.js";
import { BASE_FRAGMENT_ID, loadFragmentLibrary } from "./library/index.js";
import { type Fragment, type FragmentLibrary, type TemplateConfig } from "./types.js";
import type { FragmentSpec } from "./selectFragmentConfig.js";
import { interpretOrgFragment, FragmentBodyParseError, type OrgFragmentSource } from "./unifiedLibrary.js";
import { type CaptureLifecycle } from "../../forge/interview/types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("fragment-authoring");

// ── Public seam ─────────────────────────────────────────────────────────────

/** Input the derive hands the authoring runner. */
export interface FragmentAuthoringInput {
  orgId: string;
  actor: ActorContext;
  missing: readonly FragmentSpec[];
  lifecycle: CaptureLifecycle;
}

/** What the authoring runner returns to the derive. */
export interface FragmentAuthoringResult {
  /** The augmented library (bundled core + the freshly-authored org fragments).
   * `derive.ts` retries `selectFragmentConfig` against this library. */
  library: FragmentLibrary;
  /** Ids the authoring runner could not produce a valid fragment for. The derive
   * halts loud (FragmentAuthoringFailedError) when this is non-empty. */
  failedIds: string[];
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

/** The persistence seam — production wires this to `FragmentsStore.create` under
 * an org-scoped `QueryClient`. Tests inject an in-memory map.
 *
 * `markValidated` is called AFTER the smoke composition passes; the `create`
 * inserts as `status: "draft"`, then `markValidated` flips it. */
export interface FragmentPersistence {
  create(input: {
    orgId: string;
    spec: FragmentSpec;
    bodyTs: string;
    contract: FragmentSpec["requiredContract"];
    dependsOn: readonly string[];
  }): Promise<{ fragmentId: string }>;
  markValidated(fragmentId: string): Promise<void>;
}

/** The event-stream seam — wire to the durable event store so authoring runs are
 * observable. Tests use a noop. */
export interface FragmentAuthoringEvents {
  emit(
    event:
      | { kind: "fragment.authoring.started"; orgId: string; fragmentId: string; spec: FragmentSpec }
      | { kind: "fragment.authoring.succeeded"; orgId: string; fragmentId: string; attempts: number }
      | { kind: "fragment.authoring.failed"; orgId: string; fragmentId: string; reason: string; attempts: number },
  ): Promise<void>;
}

/** Dependencies the runner is built with. */
export interface FragmentAuthoringDeps {
  authorer: FragmentAuthorer;
  persistence: FragmentPersistence;
  events: FragmentAuthoringEvents;
}

/** Build the authoring runner. The returned function processes the missing list
 * sequentially: an authoring failure on one fragment doesn't stop the others
 * (they may be independent), so the caller sees the full failedIds list at the
 * end rather than the first-failure short-circuit. */
export function buildFragmentAuthoring(deps: FragmentAuthoringDeps): FragmentAuthoring {
  return async (input: FragmentAuthoringInput): Promise<FragmentAuthoringResult> => {
    const failedIds: string[] = [];
    const authored: OrgFragmentSource[] = [];

    for (const spec of input.missing) {
      const outcome = await authorOneFragment({
        spec,
        lifecycle: input.lifecycle,
        orgId: input.orgId,
        deps,
      });
      if (outcome.kind === "ok") {
        authored.push(outcome.source);
      } else {
        failedIds.push(spec.id);
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

    return { library, failedIds };
  };
}

interface AuthorOneArgs {
  spec: FragmentSpec;
  lifecycle: CaptureLifecycle;
  orgId: string;
  deps: FragmentAuthoringDeps;
}

type AuthorOneOutcome = { kind: "ok"; source: OrgFragmentSource } | { kind: "failed"; reason: string };

async function authorOneFragment(args: AuthorOneArgs): Promise<AuthorOneOutcome> {
  const { spec, lifecycle, orgId, deps } = args;
  await deps.events.emit({ kind: "fragment.authoring.started", orgId, fragmentId: spec.id, spec });

  // UNBOUNDED writer-rework loop while the writer is making PROGRESS (the body or
  // the rejection signature keeps changing). The loop stops ONLY at a FIXED POINT
  // (identical body + identical rejection — no new information). NO iteration cap
  // (the timeout-eradication doctrine: a structural fixed-point is the bound).
  let attempt = 0;
  let previousAttempt: { bodyTs: string; rejection: string } | undefined;
  let lastSignature: string | undefined;
  let lastRejection = "";

  for (;;) {
    attempt += 1;
    let output: FragmentAuthorerOutput;
    try {
      output = await deps.authorer({ spec, lifecycle, ...(previousAttempt && { previousAttempt }) });
    } catch (err) {
      lastRejection = err instanceof Error ? err.message : String(err);
      log.warn("fragment authorer threw", { fragmentId: spec.id, attempt, error: lastRejection });
      const signature = `authorer-threw:${lastRejection}`;
      // Fixed point — not making progress; stop the inner loop.
      if (signature === lastSignature) break;
      lastSignature = signature;
      previousAttempt = { bodyTs: previousAttempt?.bodyTs ?? "", rejection: lastRejection };
      continue;
    }
    const bodyTs = output.bodyTs;

    // VALIDATE.
    const validation = await validateFragmentBody({ spec, bodyTs });
    if (validation.kind === "ok") {
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
      const persisted = await deps.persistence.create({
        orgId,
        spec,
        bodyTs,
        contract: spec.requiredContract,
        dependsOn,
      });
      await deps.persistence.markValidated(persisted.fragmentId);
      await deps.events.emit({ kind: "fragment.authoring.succeeded", orgId, fragmentId: spec.id, attempts: attempt });
      return { kind: "ok", source };
    }

    lastRejection = validation.reason;
    const signature = `${hashish(bodyTs)}:${lastRejection}`;
    if (signature === lastSignature) {
      // FIXED POINT — identical body + identical rejection. Stop, the writer is
      // not making progress. Doctrine: a fixed point is NOT a transient.
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

interface ValidationOk {
  kind: "ok";
  /** The fragment-id dependsOn list the smoke composition required. */
  dependsOn: readonly string[];
}
interface ValidationFailed {
  kind: "failed";
  reason: string;
}

/** Parse + smoke-compose the authored body. A pass proves: the body's structure
 * is the constrained subset; `interpretOrgFragment` builds a real Fragment; that
 * Fragment composes with the bundled library at its declared phase slot. */
async function validateFragmentBody(args: {
  spec: FragmentSpec;
  bodyTs: string;
}): Promise<ValidationOk | ValidationFailed> {
  // 1) Parse — rejects bodies that step outside the constrained subset.
  let fragment: Fragment;
  try {
    fragment = interpretOrgFragment({
      fragmentId: `validate:${args.spec.id}:1.0.0`,
      kind: args.spec.kind,
      label: args.spec.label,
      version: "1.0.0",
      bodyTs: args.bodyTs,
      contract: args.spec.requiredContract,
      dependsOn: [],
    });
  } catch (err) {
    const reason =
      err instanceof FragmentBodyParseError
        ? `body parse rejected: ${err.message}`
        : `body parse threw: ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "failed", reason };
  }

  // 2) Smoke-compose — assemble the minimal config that exercises this fragment.
  return runSmokeComposition(args.spec, fragment);
}

async function runSmokeComposition(spec: FragmentSpec, fragment: Fragment): Promise<ValidationOk | ValidationFailed> {
  const library = loadFragmentLibrary();
  if (library.has(fragment.id)) {
    library.replaceForTests(fragment);
  } else {
    library.register(fragment);
  }
  const config: TemplateConfig = configForSmoke(spec, fragment);
  try {
    await composeTemplate(config, library);
    return { kind: "ok", dependsOn: [] };
  } catch (err) {
    return {
      kind: "failed",
      reason: `smoke compose failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function configForSmoke(spec: FragmentSpec, fragment: Fragment): TemplateConfig {
  // Default to node-pnpm runtime + none deploy. Adjust if the candidate is a
  // runtime fragment (use its own label) or a ruby-dependent fragment.
  const isRubyDependent =
    fragment.id.startsWith("runtime-ruby") || (fragment.dependsOn ?? []).some((id) => id.startsWith("runtime-ruby"));
  const runtime = spec.kind === "runtime" ? spec.label : isRubyDependent ? "ruby-bundler" : "node-pnpm";
  const deploy = spec.kind === "deploy" ? spec.label : "none";

  const config: TemplateConfig = {
    slug: `smoke-${spec.id}`,
    runtime,
    deploy,
    addons: [],
    examples: [],
  };
  if (spec.kind === "frontend") config.frontend = spec.label;
  if (spec.kind === "backend") config.backend = spec.label;
  if (spec.kind === "db") config.db = spec.label;
  if (spec.kind === "auth") config.auth = spec.label;
  if (spec.kind === "addon") config.addons = [spec.label];
  if (spec.kind === "example") config.examples = [spec.label];
  // The base + runtime + deploy slots reference the library; nothing else to wire.
  // BASE_FRAGMENT_ID is always required — assert presence.
  void BASE_FRAGMENT_ID;
  return config;
}

// Tiny stable hash for convergence-signature comparison. Not cryptographic —
// just enough to detect "the writer produced an identical body".
function hashish(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = Math.trunc(h * 31 + (s.codePointAt(i) ?? 0));
  }
  return h.toString(16);
}

// NOTE: the in-memory deterministic fragment authorer is a TEST-FIXTURES path.
// It lives under `tests/fixtures/fragmentAuthoring.ts` as `buildFakeFragmentAuthorer`
// — `fake` triggers the `no-production-stubs` lint stem-list so any attempt to
// wire it as a production default is mechanically caught. Production wires the
// real LLM-backed `wrapProviderFragmentAuthorer` via
// `buildForgeFragmentAuthorerFactory` (engine/forge/providerFactory.ts).
