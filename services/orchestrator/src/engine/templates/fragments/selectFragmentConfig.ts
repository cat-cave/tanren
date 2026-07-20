// SELECT-FRAGMENT-CONFIG — the single, fragment-only scaffold-selection entry
// point (docs/roadmap/templating-system.md). REPLACES the dual `selectSeedTemplate`
// (template-selection + agent-template-build) the doctrine collapse deletes.
//
// THE ONE-WAY DOCTRINE (the user's explicit directive that drives this entire PR):
//
//   "Let's make there be only exactly one way, the right way, for tanren to get
//   repos scaffolded. Since fragments are the way we're going, this should be the
//   way to act. If someone is using tanren to translate russian fanfiction, then
//   they need to make a lot of custom fragments, but maybe they share some
//   spellchecking linter fragments with someone using tanren to craft their D&D
//   campaign lore book. Similarly, someone wanting to take their existing app and
//   simply switch from gcp to AWS may want to reuse nearly all fragments, subbing
//   out only one or needing to create a new one, etc. We should NEVER have
//   fallback paths or legacy workarounds. Everything in tanren should feel like
//   the single intended way to do things."
//
// THE FLOW. Given a captured `lifecycle` + a `FragmentLibrary` (the unified
// bundled + org-scoped registry — `loadFragmentLibrary(orgId?)`), this module:
//   1. Derives a `TemplateConfig` from the lifecycle. A canonical curated stack
//      LABEL short-circuits to the curated entry's config; otherwise the lifecycle
//      tokens (the `stack` label + the `deploy` command) are mapped to fragment
//      LABELS via the bundled-runtime/frontend/db/deploy mapping table below
//      (open strings — any string the library has a fragment for is fine).
//   2. Walks the derived config's referenced fragment ids. Every id present in the
//      library → `{ kind: "ready", config }`. Any missing → `{ kind:
//      "missing-fragments", missing: [{ kind, label, contract? }, ...] }` so the
//      per-fragment authoring DAG (F2) can spawn one authoring run per missing
//      fragment, persist them into the org's `fragments` table, and the parent
//      derive can re-call this function. On the retry the library
//      (bundled + org-scoped) now contains the freshly-authored fragments and the
//      decision flips to `ready`.
//
// NO FALLBACK. There is no agent-template-build path, no from-scratch project
// scaffold, no "skip selection" mode. Every scaffold is a compose of validated
// fragments; missing fragments are AUTHORED, not skipped.

import { lookupCurated } from "./registry/index.js";
import { compose as composeFragmentIds } from "./compose.js";
import type { CaptureLifecycle } from "../../forge/interview/types.js";
import { fragmentEvidenceContentDigest, type FragmentEvidenceContractV1 } from "./fragmentEvidenceContract.js";
import { type FragmentContract, type FragmentKind, type FragmentLibrary, type TemplateConfig } from "./types.js";

// Re-export so `derive.ts` can declare the seam without reaching into the inner module.
export type { FragmentContract, FragmentKind } from "./types.js";

/**
 * A reference to a fragment a config needs — the SHAPE of one slot the composer will
 * try to fill. Carries the minimum information `selectFragmentConfig` extracted from
 * the lifecycle + the per-kind mapping, AND the contract the authoring DAG must make
 * the fragment declare (e.g. a runtime fragment must declare a `testRunner` and a
 * `reportPath`, else `processCiYml` throws at compose time — the contract surface is
 * the load-bearing post-process invariant).
 */
export interface FragmentSpec {
  /** Which of the 9 compose phases the fragment fills. */
  kind: FragmentKind;
  /** The per-kind label that becomes the fragment id (`<kind>-<label>`). */
  label: string;
  /** The full fragment id the composer requires (`<kind>-<label>`). */
  id: string;
  /** Required contract fields the authoring DAG must make the fragment declare,
   * derived from the kind. For a runtime: `testRunner` + `reportPath` (else
   * `processCiYml` throws). For other kinds: typically empty. */
  requiredContract: Partial<FragmentContract>;
}

/** The outcome of a single `selectFragmentConfig` call. */
export type SelectFragmentConfigResult =
  | { kind: "ready"; config: TemplateConfig; reasons: readonly string[] }
  | { kind: "missing-fragments"; config: TemplateConfig; missing: readonly FragmentSpec[]; reasons: readonly string[] };

/**
 * Thrown when a missing-fragments decision could not be resolved by the per-fragment
 * authoring DAG (one or more authoring runs failed at their writer-rework fixed
 * point). The doctrine: NEVER silently skip a missing fragment. The derive halts
 * loud and the operator/system either fixes the authoring failure or expands the
 * bundled library.
 */
export class FragmentAuthoringFailedError extends Error {
  readonly failedIds: readonly string[];
  /** Per-fragment-id: the LAST writer rejection captured at the fixed point. The
   * derive 409 response embeds this map so the operator can read WHY F2 halted
   * directly off the response body — no log-grepping (v66 fix). Empty when the
   * error is raised before authoring ran (no seam wired). */
  readonly failureReasons: Readonly<Record<string, string>>;
  constructor(failedIds: readonly string[], options?: { failureReasons?: Record<string, string>; cause?: unknown }) {
    const list = failedIds.length === 0 ? "<none>" : failedIds.join(", ");
    const reasons = options?.failureReasons ?? {};
    const detail =
      Object.keys(reasons).length === 0
        ? ""
        : ` Reasons: ${Object.entries(reasons)
            .map(([id, reason]) => `${id}: ${reason}`)
            .join(" | ")}.`;
    super(
      `per-fragment authoring failed for: ${list}.${detail} The derive halts fail-closed; ` +
        `there is no silent-skip path. Inspect the per-fragment authoring run logs ` +
        `(\`fragment.authoring.failed\` events), fix the writer / validator gate, and retry.`,
    );
    this.name = "FragmentAuthoringFailedError";
    this.failedIds = failedIds;
    this.failureReasons = reasons;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Thrown when `selectFragmentConfig` cannot resolve a TemplateConfig at all (the
 * lifecycle is so malformed that we cannot even derive a slot map). Distinct from
 * `missing-fragments` (which still produces a config + a list to author). This
 * surfaces a true wiring bug (an empty lifecycle.stack, a deploy with no token).
 */
export class UnresolvableLifecycleError extends Error {
  constructor(reason: string) {
    super(
      `cannot derive a TemplateConfig from the captured lifecycle: ${reason}. ` +
        `The capture is required to declare a stack and a deploy command; an empty ` +
        `or unparseable lifecycle is a wiring bug, not a degrade path.`,
    );
    this.name = "UnresolvableLifecycleError";
  }
}

// ── Token mapping (lifecycle → fragment labels) ─────────────────────────────

// Split a free-form stack label into lowercase tokens on the conventional
// separators: "/", "+", "·", "-", whitespace, commas. Periods preserved (so
// "fly.io" stays one token).
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[/+·,\s-]+/u)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

// Per-kind label mappers. Each takes the captured-lifecycle tokens and returns the
// fragment LABEL (the `<kind>-<label>` suffix). Open-world: the bundled-library
// mapping table is documentation; any string the library has a fragment for is
// valid. A returned label that the library doesn't have triggers a
// `missing-fragments` decision so the authoring DAG can fill it.

// Runtime mapping. Recognized bundled aliases first; unknown stacks return the
// first token verbatim as the label (so an unknown stack still produces a derived
// FragmentSpec the authoring DAG can target). The token is lowercase + must be a
// valid label (non-empty); an empty stack throws UnresolvableLifecycleError.
function deriveRuntimeLabel(stackTokens: readonly string[]): string {
  // Recognized aliases → bundled labels (open mapping; "no match" falls through).
  // Two tokens combined (`ts pnpm` → `node-pnpm`) when the alias map matches the
  // PAIR; else single-token alias; else verbatim first token.
  const head = stackTokens[0] ?? "";
  const second = stackTokens[1] ?? "";
  // pair aliases
  if (
    (head === "ts" || head === "typescript" || head === "js" || head === "javascript" || head === "node") &&
    (second === "pnpm" || second === "node-pnpm")
  ) {
    return "node-pnpm";
  }
  if (head === "node" && second === "pnpm") return "node-pnpm";
  if (head === "ruby" && (second === "bundler" || second === "rails")) return "ruby-bundler";
  // single-token aliases
  if (head === "node" || head === "node-pnpm" || head === "pnpm") return "node-pnpm";
  if (head === "ruby" || head === "rails" || head === "bundler") return "ruby-bundler";
  // verbatim — open world (a "russian-fanfiction" stack picks up
  // `runtime-russian` as the label, triggering missing-fragments → authoring).
  if (head === "") return "";
  return head;
}

// Frontend mapping. Returns "" when no frontend token is present (the slot is
// omitted — `TemplateConfig.frontend` is optional). Tokens recognized:
// "react-router", "remix", "next" (open).
function deriveFrontendLabel(stackTokens: readonly string[]): string {
  const set = new Set(stackTokens);
  if (set.has("react-router") || (set.has("react") && set.has("router"))) return "react-router";
  if (set.has("remix")) return "remix";
  if (set.has("next") || set.has("next.js") || set.has("nextjs")) return "next";
  if (set.has("rails")) return "rails";
  return "";
}

// DB mapping. Returns "" when no db token is present.
function deriveDbLabel(stackTokens: readonly string[]): string {
  const set = new Set(stackTokens);
  if (set.has("postgres-prisma")) return "postgres-prisma";
  if (set.has("prisma")) return "postgres-prisma";
  if (set.has("postgres") || set.has("postgresql") || set.has("pg")) return "postgres-prisma";
  if (set.has("mysql")) return "mysql";
  if (set.has("sqlite")) return "sqlite";
  return "";
}

// Deploy mapping. The captured `lifecycle.deploy` is a shell command (`fly deploy
// --remote-only`), so we tokenize THAT, not just the stack.
//
// UNKNOWN-DEPLOY DOCTRINE (Codex H3 #1 fix). An unknown deploy verb is NEVER
// silently degraded to "none" — that treated opaque `heroku push` / `bin/deploy.sh`
// scripts as no-deploy, silently dropping the entire deploy phase. We now MIRROR
// the runtime open-world path: return the first deploy token verbatim so the
// library check raises a `missing-fragments` decision and the per-fragment
// authoring DAG (F2) fills in a `deploy-<token>` fragment (or the operator
// expands the bundled library). A legitimate no-deploy project MUST declare
// `deploy: "none"` (or `no-op` / `noop`) explicitly; an empty deploy verb is a
// wiring bug (`UnresolvableLifecycleError`).
function deriveDeployLabel(deployTokens: readonly string[], stackTokens: readonly string[]): string {
  const allTokens = new Set([...deployTokens, ...stackTokens]);
  if (allTokens.has("fly") || allTokens.has("fly.io") || allTokens.has("flyctl")) return "fly";
  if (allTokens.has("vercel")) return "vercel";
  if (allTokens.has("none") || allTokens.has("no-op") || allTokens.has("noop")) return "none";
  // Unknown deploy — return the first deploy token VERBATIM so the missing-fragments
  // path spawns per-fragment authoring for the deploy slot. Mirrors the runtime
  // open-world verbatim behaviour (`deriveRuntimeLabel` above). An empty deploy
  // verb is caught in `deriveTemplateConfigFromLifecycle` and thrown loud.
  const head = deployTokens[0] ?? "";
  if (head === "") return "";
  return head;
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * Derive a `TemplateConfig` from a captured lifecycle. Tries the curated registry
 * first (a known stack short-circuits). On a miss, synthesizes a config from the
 * lifecycle's stack + deploy tokens. The resulting config may reference fragment
 * ids that aren't in the library — `selectFragmentConfig` resolves that question.
 *
 * REASONS are accumulated in order so the decision row records why each slot
 * landed where it did.
 */
export interface DeriveTemplateConfigResult {
  config: TemplateConfig;
  reasons: readonly string[];
}

export function deriveTemplateConfigFromLifecycle(lifecycle: CaptureLifecycle): DeriveTemplateConfigResult {
  if (lifecycle.stack.trim() === "") {
    throw new UnresolvableLifecycleError("lifecycle.stack is empty");
  }

  // 1) curated short-circuit.
  const curated = lookupCurated(lifecycle.stack);
  if (curated !== undefined) {
    return {
      config: curated.config,
      reasons: [`curated:${curated.id}`],
    };
  }

  // 2) synthesize from tokens.
  const stackTokens = tokens(lifecycle.stack);
  const deployTokens = tokens(lifecycle.deploy);
  const runtime = deriveRuntimeLabel(stackTokens);
  if (runtime === "") {
    throw new UnresolvableLifecycleError(`no runtime token found in stack "${lifecycle.stack}"`);
  }
  const frontend = deriveFrontendLabel(stackTokens);
  const db = deriveDbLabel(stackTokens);
  const deploy = deriveDeployLabel(deployTokens, stackTokens);
  if (deploy === "") {
    // Codex H3 #1: no silent "none" fallthrough. Every project MUST declare a
    // deploy verb — `deploy: "none"` explicitly for no-deploy projects, else
    // an identifiable deploy target (fly/vercel) or an operator-owned command
    // whose first token the missing-fragments path can spawn authoring for.
    throw new UnresolvableLifecycleError(
      `no deploy token found in stack "${lifecycle.stack}" / deploy "${lifecycle.deploy}"; ` +
        `declare "none" explicitly for a no-deploy project`,
    );
  }

  const reasons: string[] = [`runtime:${runtime}`, `deploy:${deploy}`];
  if (frontend !== "") reasons.push(`frontend:${frontend}`);
  if (db !== "") reasons.push(`db:${db}`);

  // The `slug` here is the snapshot stem / observability key. It is NOT the
  // project slug (the derive owns that via `safeProjectSlug` from the
  // identity / pitch). Synthesize a stable token-summary slug.
  const slugParts = [runtime, frontend, db, deploy].filter((s) => s !== "");
  const slug = slugParts.join("-");

  const config: TemplateConfig = {
    slug,
    runtime,
    ...(frontend === "" ? {} : { frontend }),
    ...(db === "" ? {} : { db }),
    deploy,
    addons: [],
    examples: [],
  };

  return { config, reasons };
}

// ── Library coverage check ──────────────────────────────────────────────────

/**
 * Language-family → default test runner. Used by `requiredContractFor` so a
 * missing runtime fragment's authoring DAG is prompted with a runner that
 * matches the operator's stack (Ruby → `rspec`, Go → `go-test`, Python →
 * `pytest`, Rust → `cargo-test`) instead of forcing every runtime to `vitest`
 * (the Codex H3 #2 bug: non-Node runtimes got a bogus test-runner contract that
 * either steered the LLM off the language's real test tool or clashed with the
 * bundled fragment's own declaration — e.g. `library/runtime-ruby-bundler.ts`
 * declares `rspec`).
 *
 * OPEN WORLD. An unrecognized runtime label returns `undefined` — the required
 * contract carries `reportPath` only and the authoring DAG proposes a runner
 * matching the language it's about to scaffold. `compose.ts:353` still throws
 * loud if the produced runtime fragment fails to declare BOTH `testRunner` and
 * `reportPath`, so the invariant "every runtime declares a test runner" is
 * preserved regardless of what the required contract seeds.
 */
export function defaultTestRunnerForRuntime(runtimeLabel: string): string | undefined {
  const label = runtimeLabel.toLowerCase();
  // Node / TypeScript family — matches the `deriveRuntimeLabel` alias table
  // above (node-pnpm, node, ts, typescript, js, javascript, pnpm).
  if (
    label === "node-pnpm" ||
    label === "node" ||
    label === "pnpm" ||
    label === "ts" ||
    label === "typescript" ||
    label === "js" ||
    label === "javascript"
  ) {
    return "vitest";
  }
  // Ruby family — Rails/Bundler/RSpec all conventionally use RSpec.
  if (label === "ruby-bundler" || label === "ruby" || label === "rails" || label === "bundler") {
    return "rspec";
  }
  // Go — the standard `go test` runner.
  if (label === "go" || label === "golang" || label === "go-modules") {
    return "go-test";
  }
  // Python family — pytest is the ecosystem default; poetry/pipenv/pip all wrap it.
  if (label === "python" || label === "python3" || label === "pip" || label === "pipenv" || label === "poetry") {
    return "pytest";
  }
  // Rust — cargo's built-in test harness.
  if (label === "rust" || label === "rust-cargo" || label === "cargo") {
    return "cargo-test";
  }
  return undefined;
}

/**
 * The contract a runtime fragment MUST declare (else `processCiYml` throws at
 * compose time — it can't fill the evidence-block report path without it). The
 * authoring DAG enforces this via the validate stage (PR-D's isolation test).
 *
 * Codex H3 #2: `testRunner` is now DERIVED from the runtime label (via
 * `defaultTestRunnerForRuntime`) instead of hard-coded to `vitest`. An
 * unrecognized label leaves `testRunner` unset and lets the authoring DAG
 * propose a language-appropriate runner (still enforced by
 * `compose.ts:composeCiEvidence` — a runtime fragment that ships with no
 * runner throws loud at compose time).
 */
function runtimeRequiredContract(runtimeLabel: string): Partial<FragmentContract> {
  const testRunner = defaultTestRunnerForRuntime(runtimeLabel);
  return {
    ...(testRunner === undefined ? {} : { testRunner }),
    reportPath: "reports/junit.xml",
    evidence: runtimeEvidenceContract(),
  };
}

/**
 * F2 runtime authoring receives a complete declarative evidence shape. The digest
 * addresses this frozen declaration, not a command or a mutable CI label; the batch
 * resolver still requires a matching captured artifact before it can select it.
 */
function runtimeEvidenceContract(): FragmentEvidenceContractV1 {
  const contract: FragmentEvidenceContractV1 = {
    schemaVersion: "fragment_evidence.v1",
    junitReportPath: "reports/junit.xml",
    testSelector: { path: ".tanren/test-selector.json", format: "json" },
    behaviorManifest: { path: ".tanren/behavior-manifest.json", format: "json" },
    contentDigest: "sha256:" + "0".repeat(64),
  };
  return { ...contract, contentDigest: fragmentEvidenceContentDigest(contract) };
}

function requiredContractFor(kind: FragmentKind, label: string): Partial<FragmentContract> {
  if (kind === "runtime") return runtimeRequiredContract(label);
  // Other kinds carry no compose-time contract requirements (their composeApply
  // is structural — files + deps + hooks). The authoring DAG still validates them
  // via the isolation harness.
  return {};
}

function fragmentSpecsForConfig(config: TemplateConfig): FragmentSpec[] {
  // Mirror `composeTemplate`'s phase walk so the spec list matches what compose
  // will actually try to resolve. Importing composeFragmentIds keeps the truth in
  // one place; if compose's phase routing changes, this list updates with it.
  const phaseIds = composeFragmentIds(config);
  return phaseIds.map(({ kind, id, label }) => ({
    kind,
    label,
    id,
    requiredContract: requiredContractFor(kind, label),
  }));
}

/**
 * THE LIVE SELECTION ENTRY POINT. Derive a config from the lifecycle, walk the
 * fragments it would reference, and report either `ready` (every fragment is in
 * the library) or `missing-fragments` (the per-fragment authoring DAG must fill
 * the missing ones and the caller must retry).
 *
 * The base fragment is ALWAYS the first slot — its absence is a wiring bug, not a
 * missing-fragments case (the bundled library is required infrastructure).
 */
export function selectFragmentConfig(
  lifecycle: CaptureLifecycle,
  library: FragmentLibrary,
): SelectFragmentConfigResult {
  const { config, reasons: derivationReasons } = deriveTemplateConfigFromLifecycle(lifecycle);
  const specs = fragmentSpecsForConfig(config);
  const missing = specs.filter((spec) => !library.has(spec.id));

  const reasons: string[] = [...derivationReasons];
  for (const spec of missing) reasons.push(`missing:${spec.id}`);

  if (missing.length === 0) {
    return { kind: "ready", config, reasons };
  }
  return { kind: "missing-fragments", config, missing, reasons };
}
