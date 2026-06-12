// greenfield onboarding: typed contracts for the vision interview.
//
// The greenfield "full track" is a multi-round Forge VISION INTERVIEW. Across
// ~14 rounds Forge asks the operator about their product and accumulates a
// structured CAPTURE — identity, personas, behaviors, interfaces, design-DNA,
// architecture, rulesets. On completion the capture is DERIVED into the live
// product graph: a project's personas/behaviors/milestones/specs, created
// through the SAME entity-creation paths so authz + dependency
// checks are unchanged. The derived DAG then renders via.
//
// The interview itself runs over the SAME injectable answerer seam as the
// conversation + discovery flows: the real implementation
// wraps a provider Answerer; tests inject a fake; a deterministic fallback
// keeps the flow live without provider infra. NOTHING here is persisted — the
// capture is carried round-to-round on the request (the surface re-submits the
// running capture), so there is no interview-session table and no migration.

import { z } from "zod";

// ── Capture sub-shapes (the "what forge captured" panel) ────────────────────

// HOSTNAME-SAFE slug pattern. The slug becomes the GitHub repo NAME and the deploy
// APP name (derive.ts / greenfield create), both of which flow into hostnames
// (`<app>.fly.dev`, a Vercel project subdomain) and URLs — so an LLM-authored slug
// with spaces/uppercase/`/`/leading-trailing dashes would create an invalid or
// surprising host. We constrain to a DNS-label-safe shape: lowercase
// alphanumerics + single internal dashes, no leading/trailing dash, ≤63 chars (the
// DNS label ceiling). `normalizeSlug` below coerces a near-miss into this shape; the
// schema REJECTS what cannot be made safe (empty after normalization).
const HOSTNAME_SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

// Coerce a free-form (possibly LLM-authored) slug into a hostname-safe DNS label:
// lowercase, non-alphanumeric runs → single dashes, trimmed dashes, ≤63 chars.
// Returns "" when nothing safe survives (the caller rejects/falls back to a default).
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replaceAll(/-+$/gu, "");
}

// Forward decl: the full capture type is defined below; `safeProjectSlug` is
// declared after `InterviewCapture` (it reads `identity`/`designDna`).

// The product identity: slug + one-line pitch (+ optional repo hint). The slug is
// HOSTNAME-SAFE (DNS-label shape) because it names the repo + deploy app — an unsafe
// LLM-authored slug is rejected at the capture boundary (the derive normalizes/
// defaults a missing identity; see `safeProjectSlug`).
export const CaptureIdentity = z
  .object({
    // NORMALIZE-THEN-VALIDATE: a raw (LLM-authored) slug is first coerced to a
    // hostname-safe DNS label (`normalizeSlug`) so a near-miss like "My App!" becomes
    // "my-app" rather than breaking the interview round; the coerced result must then
    // satisfy `HOSTNAME_SAFE_SLUG` — a slug with NO safe content left (empty after
    // normalization) is REJECTED loudly (never silently shipped into a repo/host name).
    slug: z
      .string()
      .min(1)
      .max(160)
      .transform(normalizeSlug)
      .pipe(
        z
          .string()
          .min(1, "slug has no hostname-safe content")
          .max(63)
          .regex(
            HOSTNAME_SAFE_SLUG,
            "slug must be a hostname-safe DNS label (lowercase alphanumerics + single dashes)",
          ),
      ),
    pitch: z.string().min(1).max(400),
    repoHint: z.string().max(200).default(""),
  })
  .strict();
export type CaptureIdentity = z.infer<typeof CaptureIdentity>;

// A persona the interview surfaced. `surface` notes their delivery surface
// (desktop / handheld / …) for the architecture step; purely descriptive.
export const CapturePersona = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    surface: z.string().max(80).default(""),
  })
  .strict();
export type CapturePersona = z.infer<typeof CapturePersona>;

/* eslint-disable unicorn/no-thenable */
// `then` is BDD Given/When/Then vocabulary (mirrors the BehaviorRow
// field name); the thenable-object lint does not apply to a schema field.
export const CaptureBehavior = z
  .object({
    persona: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    given: z.string().max(280).default(""),
    when: z.string().max(280).default(""),
    then: z.string().max(280).default(""),
  })
  .strict();
/* eslint-enable unicorn/no-thenable */
export type CaptureBehavior = z.infer<typeof CaptureBehavior>;

// An inferred interface (a delivery surface, e.g. "desktop dashboard").
export const CaptureInterface = z
  .object({
    name: z.string().min(1).max(120),
    note: z.string().max(200).default(""),
  })
  .strict();
export type CaptureInterface = z.infer<typeof CaptureInterface>;

// One architecture line ("web · next.js · turborepo"). Free-form by design —
// the HUMAN-READABLE summary of the architecture step. The LOAD-BEARING output
// of that step is `CaptureLifecycle` below (the concrete stack commands the
// scaffold authors the justfile from).
export const CaptureArchitectureLine = z
  .object({
    layer: z.string().min(1).max(40),
    choice: z.string().min(1).max(160),
  })
  .strict();
export type CaptureArchitectureLine = z.infer<typeof CaptureArchitectureLine>;

// The project's CONCRETE LIFECYCLE for the chosen stack — the load-bearing output
// of the architecture step (stack-flexible contract,
// docs/operator-guide/ci-config.md). Tanren knows NO stack: the project
// DECLARES what each conventional justfile target IS for its stack, and the run
// MATERIALIZES the justfile + `.tanren/ci.yml` from this DETERMINISTICALLY (no LLM,
// no hardcoded pnpm example — the v27 fix; the ci.yml is the skeleton verbatim, the
// justfile the six targets filled from these commands). The six
// conventional targets map 1:1 to the contract's `bootstrap`/`tier-1`/`tier-2`/
// `tier-3`/`build`/`deploy`; each holds the ACTUAL stack command(s) — general
// enough that a Rust project fills `tier1` with "cargo clippy" + `build` with
// "cargo build", a Python project "uv run ruff" + "uv build", a novel
// translation "aspell" + "pandoc … epub", just as naturally as a TS project
// fills "pnpm lint" + "pnpm build". A target may hold a multi-line command
// (newline-joined). `stack` is the human-readable stack/runtime label
// ("ts/pnpm", "rust/cargo", "python/uv", "novel/pandoc") — descriptive only;
// Tanren never branches on it.
// The project's TOOLCHAIN declaration (environment-management.md §3 Layer 1) — a
// STACK-AGNOSTIC map of mise tool-name → version-spec the project CHOSE. The keys
// are `mise` tool names (`node`, `pnpm`, `python`, `go`, `rust`, …); the values are
// version strings the project picked (`"24"`, `"10"`, `"3.13"`, `"latest"`,
// `"nightly"`, …). Tanren names NO stack here — it is a generic `Record` validated
// only for shape, NEVER for a known tool set. It is materialized DETERMINISTICALLY
// into a `mise.toml` `[tools]` table (the scaffold projection, like the justfile)
// and provisioned at workspace-prep via `mise install` in the `tanren` user space —
// which makes the project's `node`/`pnpm`/etc resolve to the declared versions when
// the project's gate/bootstrap commands run, WITHOUT touching Tanren's own harness
// (codex stays on the runner's isolated node). Keys are validated as mise-safe tool
// names (no shell-breaking chars) so the deterministic `[tools]` projection cannot
// be smuggled into; values are bounded version specs. An EMPTY map = the project
// declared no toolchain (it provisions inside its own `bootstrap` shell, or uses the
// runner baseline) — no `mise.toml` is materialized, and Tanren invents no versions.
const MISE_TOOL_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
export const CaptureToolchain = z.record(
  z.string().min(1).max(80).regex(MISE_TOOL_NAME, "mise tool name must be lowercase alphanumeric + . _ -"),
  z.string().min(1).max(80),
);
export type CaptureToolchain = z.infer<typeof CaptureToolchain>;

export const CaptureLifecycle = z
  .object({
    // The chosen stack/runtime label (descriptive — NOT a switch Tanren reads).
    stack: z.string().min(1).max(120),
    // The conventional targets → the stack commands that fill them.
    bootstrap: z.string().min(1).max(400),
    tier1: z.string().min(1).max(400),
    tier2: z.string().min(1).max(400),
    tier3: z.string().min(1).max(400),
    build: z.string().min(1).max(400),
    deploy: z.string().min(1).max(400),
    // The project's TOOLCHAIN (mise tool-name → version-spec; see `CaptureToolchain`).
    // OPTIONAL: a project may declare none (provisions inside its own bootstrap, or
    // rides the runner baseline) — absent/empty ⇒ no `mise.toml` materialized.
    // Defaults to `{}` so an answerer that omits it still parses.
    toolchain: CaptureToolchain.default({}),
  })
  .strict();
export type CaptureLifecycle = z.infer<typeof CaptureLifecycle>;

// The full accumulated capture. Every list grows monotonically across rounds;
// the engine de-dupes by a natural key when merging a round's delta.
export const InterviewCapture = z
  .object({
    identity: CaptureIdentity.nullable().default(null),
    personas: z.array(CapturePersona).default([]),
    behaviors: z.array(CaptureBehavior).default([]),
    interfaces: z.array(CaptureInterface).default([]),
    designDna: z.string().max(80).default(""),
    architecture: z.array(CaptureArchitectureLine).default([]),
    // The load-bearing lifecycle declaration (the architecture step's structured
    // output). `null` until the architecture step captures it; the scaffold
    // FAILS LOUD if it is still null at derive (never a silent Node default).
    lifecycle: CaptureLifecycle.nullable().default(null),
    // LIFECYCLE/STACK DRIFT GUARD (apex v28–v31): once the architecture round
    // captures a lifecycle it is OPERATOR-CONFIRMED + PINNED — a later round's LLM
    // answerer must NOT silently re-write the stack label / swap tier commands /
    // drop flags. This flag latches `true` the first round a lifecycle is captured;
    // while it is set, `mergeCapture` PRESERVES the confirmed lifecycle verbatim and
    // a re-emitted-but-different lifecycle is treated as DRIFT (surfaced, not taken)
    // — an actual change requires an EXPLICIT, operator-visible `lifecycleChange`
    // signal on the delta. Carried on the capture (re-submitted each round) so the
    // pin survives the round trip with no interview-session table.
    lifecycleConfirmed: z.boolean().default(false),
    rulesets: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type InterviewCapture = z.infer<typeof InterviewCapture>;

// Thrown when a derive cannot resolve ANY hostname-safe project slug — neither a
// captured identity slug NOR a usable fallback from the pitch/design-DNA/stack. A
// LOUD failure: the slug names the repo + deploy app, so a no-slug derive must not
// silently invent a collision-prone constant (the old `"greenfield-project"`).
export class MissingProjectSlugError extends Error {
  constructor() {
    super(
      "greenfield derive could not resolve a hostname-safe project slug — the interview captured no " +
        "identity slug and no usable fallback (pitch/design-DNA/stack). Capture a product identity first.",
    );
    this.name = "MissingProjectSlugError";
  }
}

// Resolve the project SLUG for a derive — the repo + deploy-app name. When the
// interview captured an `identity.slug` it is used verbatim (already hostname-safe
// via the schema). When identity is null (the LLM never surfaced one), derive a REAL
// fallback from the captured signal (pitch → design-DNA → stack label), normalized to
// a hostname-safe label — NOT a silent shared `"greenfield-project"` constant that
// would collide across products. Throws `MissingProjectSlugError` when nothing
// hostname-safe survives (fail-loud, never a silent default).
export function safeProjectSlug(capture: InterviewCapture): string {
  const identitySlug = capture.identity?.slug;
  if (identitySlug !== undefined && identitySlug !== "") return identitySlug;
  for (const candidate of [capture.identity?.pitch ?? "", capture.designDna, capture.lifecycle?.stack ?? ""]) {
    const normalized = normalizeSlug(candidate);
    if (normalized !== "") return normalized;
  }
  throw new MissingProjectSlugError();
}

export function emptyCapture(): InterviewCapture {
  return {
    identity: null,
    personas: [],
    behaviors: [],
    interfaces: [],
    designDna: "",
    architecture: [],
    lifecycle: null,
    lifecycleConfirmed: false,
    rulesets: [],
  };
}

// ── Round I/O ───────────────────────────────────────────────────────────────

// One inline suggestion Forge offers under a question (the hi-fi InlineActions).
export const InterviewSuggestion = z
  .object({
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(200),
  })
  .strict();
export type InterviewSuggestion = z.infer<typeof InterviewSuggestion>;

// The capture DELTA a single round contributes. Every field is OPTIONAL (a
// round adds only the items it surfaced) — but because the answerer JSON Schema
// is rendered for OpenAI strict structured-outputs (every key required, optional
// expressed as nullable; see renderAnswererJsonSchema), the model returns `null`
// for the fields it has nothing to add this round. So each field is `.nullish()`
// (accepts present | null | absent), not the plain `.optional()` that
// `InterviewCapture.partial()` would produce (which would REJECT the model's
// `null`). `mergeCapture` treats null exactly like an omitted field.
export const InterviewCaptureDelta = z
  .object({
    identity: CaptureIdentity.nullish(),
    personas: z.array(CapturePersona).nullish(),
    behaviors: z.array(CaptureBehavior).nullish(),
    interfaces: z.array(CaptureInterface).nullish(),
    designDna: z.string().max(80).nullish(),
    architecture: z.array(CaptureArchitectureLine).nullish(),
    lifecycle: CaptureLifecycle.nullish(),
    // LIFECYCLE/STACK DRIFT GUARD: the EXPLICIT operator-visible signal that a
    // re-emitted `lifecycle` is an INTENTIONAL change to an already-confirmed
    // lifecycle (not silent drift). Only when `true` does `mergeCapture` accept a
    // different lifecycle over a confirmed one; otherwise a differing lifecycle is
    // DRIFT and the confirmed one is preserved. Has no effect on the first (initial)
    // lifecycle capture — that always lands. `null`/absent = no change requested.
    lifecycleChange: z.boolean().nullish(),
    rulesets: z.array(z.string().min(1)).nullish(),
  })
  .strict();
export type InterviewCaptureDelta = z.infer<typeof InterviewCaptureDelta>;

// What the answerer returns for a single round: the next question (or, when the
// interview is complete, a closing line), the capture DELTA this round added,
// and whether the interview is done.
export const InterviewRoundOutput = z
  .object({
    // The Forge prompt/question for the NEXT round (or the closing summary when
    // `complete`).
    say: z.string().min(1).max(2000),
    // The capture this round contributes. The engine merges it into the running
    // capture (monotonic) — the answerer need only return the new items.
    captureDelta: InterviewCaptureDelta.default({}),
    suggestions: z.array(InterviewSuggestion).max(4).default([]),
    complete: z.boolean().default(false),
  })
  .strict();
export type InterviewRoundOutput = z.infer<typeof InterviewRoundOutput>;

// The context handed to the answerer for one round. `round` is 1-based.
export interface InterviewAnswererContext {
  round: number;
  totalRounds: number;
  // The operator's answer to the PRIOR round's question (empty on round 1).
  answer: string;
  // The capture accumulated so far (before this round's delta).
  capture: InterviewCapture;
}

// The injectable interview answerer — the LLM seam, mirroring the conversation answerer's
// `ForgeConversationAnswerer` + the `DiscoveryAnswerer`. The real
// implementation wraps a provider Answerer; tests inject a fake; the
// deterministic default keeps the flow live without provider infra.
export interface InterviewAnswerer {
  ask(context: InterviewAnswererContext): Promise<InterviewRoundOutput>;
}

// The default round budget (the hi-fi "round N of ~14").
export const DEFAULT_TOTAL_ROUNDS = 14;
