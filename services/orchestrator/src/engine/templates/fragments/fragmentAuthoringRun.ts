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
import { loadFragmentLibrary, RUNTIME_NODE_PNPM_ID, RUNTIME_RUBY_BUNDLER_ID } from "./library/index.js";
import { deriveRuntimeLanguage, unsupportedRuntimeLanguageReason } from "./runtimeLanguage.js";
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
}

type AuthorOneOutcome = { kind: "ok"; source: OrgFragmentSource } | { kind: "failed"; reason: string };

async function authorOneFragment(args: AuthorOneArgs): Promise<AuthorOneOutcome> {
  const { spec, lifecycle, orgId, deps } = args;

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
      output = await deps.authorer({ spec, lifecycle, ...(previousAttempt && { previousAttempt }) });
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
    const validation = await validateFragmentBody({ spec, bodyTs });
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
 * full-library kitchen-sink (audit finding H5). The persisted `dependsOn` is
 * DERIVED from the parsed ops (audit finding #11) so a fragment that uses
 * node-pnpm-only ops without declaring the runtime dep is caught here rather
 * than silently dropping deps in a later compose. */
async function validateFragmentBody(args: { spec: FragmentSpec; bodyTs: string }): Promise<SmokeOk | SmokeFailed> {
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

  // 2) Derive the implicit `dependsOn` from the ops (audit finding #11). Any
  // `addPackageJsonDep` / `addPackageJsonDevDep` call ⇒ implicit
  // `runtime-node-pnpm` dependency — pkg.json deps only land in the composed
  // VFS when the active runtime is node-pnpm (the ruby-bundler runtime ships
  // no package.json + `processDeps` early-returns on its absence), so this
  // dep is structurally required.
  const derivedDependsOn = deriveImplicitDependsOn(ops, args.spec);

  // 3) Build the validated Fragment via `interpretOrgFragment`, carrying the
  // derived dependsOn so the smoke compose's cross-runtime pre-flight sees the
  // correct shape (and so a future compose that pairs this fragment with the
  // wrong runtime fails loud via the existing `dependency_runtime_mismatch`).
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

  // 5) Full-library smoke — the kitchen-sink config that composes the authored
  // fragment alongside every bundled fragment compatible with the runtime.
  // Catches the "isolated-fine but composes-with-conflict" class (audit
  // finding H5 — task #150) that the minimal smoke can't see because it only
  // wires the authored slot: file collisions, dep-version conflicts, justfile
  // clashes when the operator's real project uses the full bundled set.
  const full = await runFullLibrarySmokeComposition(args.spec, fragment, derivedDependsOn);
  if (full.kind !== "ok") return full;

  return { kind: "ok", dependsOn: derivedDependsOn };
}

/** Derive the implicit `dependsOn` list from the parsed ops (audit findings #11
 * + H2). Any op whose effect implies a runtime MUST surface that runtime — a
 * runtime fragment is its own runtime so we never self-depend. Implications:
 *  - `addPackageJsonDep` / `addPackageJsonDevDep` ⇒ runtime-node-pnpm.
 *  - `vfs.write|overwrite("package.json", …)` ⇒ runtime-node-pnpm (a fragment
 *    writing pkg.json directly bypasses the addPackageJsonDep API).
 *  - `vfs.write|overwrite("Gemfile", …)` ⇒ runtime-ruby-bundler.
 *  - `vfs.appendToJustfileTarget` lines containing a pnpm / npm / yarn / npx /
 *    node token ⇒ runtime-node-pnpm; bundle / gem / ruby ⇒ runtime-ruby-bundler.
 *
 * The composer's `dependency_runtime_mismatch` then fails LOUD on a misaligned
 * pair, instead of silently dropping the mismatch + producing a broken VFS. */
export function deriveImplicitDependsOn(ops: readonly FragmentOp[], spec: FragmentSpec): readonly string[] {
  // A runtime fragment IS the runtime — never imply a self-dependency. Bail
  // before the per-op walk so a runtime-fragment that happens to author its
  // own package.json / Gemfile doesn't get a circular self-derived dep.
  if (spec.kind === "runtime") return [];
  const implied = new Set<string>();
  for (const op of ops) {
    if (op.kind === "dep" || op.kind === "devDep") {
      implied.add(RUNTIME_NODE_PNPM_ID);
      continue;
    }
    if (op.kind === "write" || op.kind === "overwrite") {
      if (op.path === "package.json") implied.add(RUNTIME_NODE_PNPM_ID);
      else if (op.path === "Gemfile") implied.add(RUNTIME_RUBY_BUNDLER_ID);
      continue;
    }
    if (op.kind === "just") {
      if (op.lines.some((line) => lineHasNodeToolingToken(line))) implied.add(RUNTIME_NODE_PNPM_ID);
      if (op.lines.some((line) => lineHasRubyToolingToken(line))) implied.add(RUNTIME_RUBY_BUNDLER_ID);
    }
  }
  return [...implied];
}

/** Strip the justfile comment portion of a line before token-matching (task
 * #103). Justfile/shell comments are `#` to end-of-line, so `# pnpm here is
 * historical` or `mkdir output # was: npm` would otherwise false-positive the
 * tooling-token regex. A `#` at column 0 OR preceded by whitespace begins a
 * comment; a `#` mid-token (rare quoted-string case) is left alone. */
function stripJustfileComment(line: string): string {
  const match = line.match(/(?:^|\s)#/u);
  if (match === null || match.index === undefined) return line;
  return line.slice(0, match.index);
}

/** A justfile line invokes node tooling — pnpm / npm / yarn / npx / node — as a
 * whole-word token (not a substring, so `node` does NOT match `linode`). The
 * comment portion is stripped FIRST (task #103) so `# pnpm here is historical`
 * does NOT derive the node runtime. */
function lineHasNodeToolingToken(line: string): boolean {
  const code = stripJustfileComment(line);
  return /(?:^|[\s|;&"'`(])(?:pnpm|npm|yarn|npx|node)(?=$|[\s|;&"'`)])/u.test(code);
}

/** A justfile line invokes ruby tooling — bundle / gem / ruby — as a whole-word
 * token. Mirrors {@link lineHasNodeToolingToken} (comment strip + whole-word
 * regex). */
function lineHasRubyToolingToken(line: string): boolean {
  const code = stripJustfileComment(line);
  return /(?:^|[\s|;&"'`(])(?:bundle|gem|ruby)(?=$|[\s|;&"'`)])/u.test(code);
}

// NOTE: the in-memory deterministic fragment authorer is a TEST-FIXTURES path.
// It lives under `tests/fixtures/fragmentAuthoring.ts` as `buildFakeFragmentAuthorer`
// — `fake` triggers the `no-production-stubs` lint stem-list so any attempt to
// wire it as a production default is mechanically caught. Production wires the
// real LLM-backed `wrapProviderFragmentAuthorer` via
// `buildForgeFragmentAuthorerFactory` (engine/forge/providerFactory.ts).
