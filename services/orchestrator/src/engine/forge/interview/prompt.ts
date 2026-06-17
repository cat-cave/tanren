// the vision-interview prompt builder.
//
// Renders the per-round prompt handed to a provider Answerer. It states the
// goal (a multi-round product vision interview that accumulates a structured
// capture), the round position, the operator's latest answer, and the capture
// so far, then asks for exactly one `InterviewRoundOutput` (next question +
// capture delta + completion flag). Kept tiny + deterministic so the contract
// is auditable; the strict output schema enforces the rest.

import type { InterviewAnswererContext } from "./types.js";

export function buildInterviewPrompt(context: InterviewAnswererContext): string {
  // Compact (not pretty-printed) capture JSON: the pretty form ~doubles the token
  // cost of the growing capture for zero model benefit (apex pre-run §7.8).
  const captureJson = JSON.stringify(context.capture);
  return [
    // STATIC-FIRST (apex pre-run §7.8): the goal + architecture + lifecycle-pinning
    // instructions are INVARIANT across rounds, so they form the prompt prefix and
    // stay cache-stable. The variable tail (round number, operator answer, capture)
    // comes LAST so a per-round change never invalidates the cached static prefix.
    "You are Forge, running a product vision interview for a brand-new (greenfield) project.",
    "Across the interview you must capture: identity (slug + pitch), personas,",
    "behaviors (Given/When/Then, tied to a persona), interfaces (delivery surfaces),",
    "a DESIGN CONTRACT (see the design step), an architecture proposal, and the required repo rulesets.",
    "",
    // DESIGN STEP (native design subsystem, WS-D1): capture a DOMAIN-GENERAL design
    // contract in `captureDelta.designContract` — the durable design artifact the
    // build later injects into the writer + a design oracle verifies against. Its
    // SHAPE adapts to the project's DOMAIN; it is NOT a fixed web design-system. A
    // SaaS app's dimensions are tokens/components/layout; a mobile game's are
    // art-direction/ui/game-feel; a novel translation's are typography/voice/
    // layout/cover. Capture the universal core always; let the project's domain
    // decide the dimensions. Never bake the web "design system" as THE shape.
    "DESIGN STEP: capture a DESIGN CONTRACT in `captureDelta.designContract` — the durable",
    "design intent the build is judged against. It is DOMAIN-GENERAL, not a web design system:",
    "  - `domain`: the design domain label (e.g. 'saas-web', 'mobile-game', 'novel-translation')",
    "  - `identity`: a one-line design identity (what the product IS, design-wise)",
    "  - `intent`: the overarching design north star the writer builds toward",
    "  - `principles`: durable design rules (e.g. 'no AI-slop gradients', 'two accent colors max')",
    "  - `constraints`: hard non-negotiables (e.g. 'WCAG AA', 'platform HIG')",
    "  - `dimensions`: the DOMAIN-DERIVED design dimensions — each { key, label, intent } —",
    "      a web app: tokens/components/layout; a game: art-direction/ui/game-feel; a novel:",
    "      typography/voice/layout/cover. Let the domain decide; do NOT force a web schema.",
    // THE MOAT — bind the design to the project's TYPED persona + behavior graph.
    // Tanren has first-class personas + behaviors; design resolves against them
    // STRICTLY (no 'assume default admin'), and behaviors become design acceptance
    // criteria. Reference the personas/behaviors ALREADY captured, by their key.
    "  - `personas`: the persona NAMES this design serves (from the personas you already",
    "      captured) — design is resolved PER-PERSONA, never 'assume default admin'. A",
    "      `dimensions[].personas` may scope a dimension to specific personas (this persona's",
    "      view of this surface).",
    "  - `behaviors`: the behaviors this design must COVER, keyed as 'persona::title' (matching",
    "      the behaviors you captured) — these are the design's acceptance criteria, so the",
    "      design covers the SAME behaviors the implementation is built against.",
    "",
    // The architecture step is LOAD-BEARING: it must elicit the project's CONCRETE
    // LIFECYCLE for the chosen stack. Tanren knows NO stack — the project DECLARES
    // it, and the run MATERIALIZES the justfile + .tanren/ci.yml from this
    // deterministically (no LLM authoring of the contract files). The `lifecycle`
    // block is the structured output; `architecture` lines are the human-readable summary.
    "ARCHITECTURE STEP (load-bearing): once the stack is chosen, capture the project's",
    "concrete LIFECYCLE in `captureDelta.lifecycle` — the ACTUAL stack commands behind",
    "the six conventional justfile targets, for WHATEVER stack the operator picked",
    "(Tanren bakes in NO stack). Fill each as the real command for the chosen stack:",
    "  - `stack`: the stack/runtime label (e.g. 'ts/pnpm', 'rust/cargo', 'python/uv', 'novel/pandoc')",
    // FRESH-REPO-SAFE BOOTSTRAP (apex v32): `bootstrap` runs on a COLD CHECKOUT —
    // for this from-scratch greenfield repo there is NO lockfile yet, so the FIRST
    // bootstrap must be a plain restore that GENERATES the lockfile (e.g.
    // `pnpm install`), never a frozen/locked install that PRESUMES a committed
    // lockfile. A `--frozen-lockfile` (or `npm ci` / `cargo build --locked`) here
    // would fail the cold bootstrap before any lockfile exists. The generated
    // lockfile is committed in the scaffold so later/CI installs are reproducible.
    "  - `bootstrap`: install/restore deps from a CLEAN checkout — a plain install that",
    "      WRITES the lockfile on a fresh repo (e.g. 'pnpm install' | 'cargo fetch' | 'uv sync').",
    "      Do NOT use a frozen/locked install ('--frozen-lockfile' / 'npm ci' / '--locked'):",
    "      this is a from-scratch scaffold with NO committed lockfile yet, so the first",
    "      bootstrap must GENERATE the lockfile (which the scaffold then commits).",
    "  - `tier1`: the CHEAP per-iteration checks (e.g. 'pnpm lint && pnpm typecheck' | 'cargo clippy' | 'aspell check')",
    "  - `tier2`: the slower pre-audit checks incl. tests (e.g. 'pnpm build && pnpm test' | 'cargo test' | 'consistency-lint')",
    "  - `tier3`: the full pre-merge gate (usually tier1 + tier2 together)",
    "  - `build`: produce the artifact (e.g. 'pnpm build' | 'cargo build --release' | 'pandoc … --to epub')",
    "  - `deploy`: ship it (e.g. 'pnpm deploy' | 'flyctl deploy' | 'publish')",
    // UPGRADE VERB (environment-management.md §4.5/§7 P1): the command that BUMPS deps
    // to latest + regenerates the lockfile. Tanren runs it as a GATED DAG node (never a
    // side stream) so a breaking bump is rejected without ever breaking main. The
    // command is the PROJECT's — Tanren names no dependency manager. Omit only for a
    // stack with literally nothing to upgrade (a pure-shell/system-package project).
    "  - `upgrade`: bump deps to latest + regenerate the lockfile (e.g. 'pnpm update --latest' |",
    "      'cargo update' | 'uv lock --upgrade' | 'go get -u ./...'). Omit only for a stack with",
    "      nothing to upgrade. Tanren runs this as a gated DAG node, never a side stream.",
    // TOOLCHAIN (environment-management.md §3): the architecture step ALSO declares
    // the project's toolchain — the runtime/tool VERSIONS the stack needs, provisioned
    // at workspace-prep via `mise` in user space (the runner ships NO project toolchain).
    // It is a LIST of { name, version } entries — `name` is a `mise` tool name
    // (node/pnpm/python/go/rust/…); `version` is the version the PROJECT chose.
    // CURRENT/LTS BY DEFAULT (the anti-stale-version rule): pick the LATEST stable /
    // current-LTS versions a fresh project would adopt today (e.g. node '24', pnpm '10',
    // python '3.13') — NEVER years-old defaults — UNLESS the operator's intent explicitly
    // calls for a legacy/pinned/nightly toolchain. Omit `toolchain` (or leave it empty)
    // ONLY for a stack with NO tool mise can provision (a pure-shell or system-package
    // project) — then the bootstrap shell provisions it.
    "  - `toolchain`: a list of { name, version } the stack needs, at CURRENT/LTS",
    "      versions by default (e.g. [{ name: 'node', version: '24' }, { name: 'pnpm',",
    "      version: '10' }] | [{ name: 'python', version: '3.13' }]). Pick the latest",
    "      stable / current LTS a fresh project adopts TODAY — never years-old versions —",
    "      unless the operator asks for a legacy/pinned/nightly toolchain. Omit it only",
    "      for a stack with no mise tool.",
    "A tier that runs tests should write a machine-readable report to a known path",
    "(the test-report convention). The lifecycle is REQUIRED before the interview can",
    "complete — never leave it null and never assume Node/pnpm.",
    "",
    // LIFECYCLE/STACK DRIFT GUARD (apex v28–v31): the captured lifecycle is the
    // operator's CONFIRMED intent. Once it is non-null in the capture below it is
    // PINNED — the engine preserves it verbatim and will REJECT any re-emission
    // that drifts the stack label or tier commands. So once `lifecycle` is set:
    // do NOT re-emit it just to re-state it (omit `captureDelta.lifecycle`; the
    // engine keeps the confirmed one), and do NOT silently rewrite the stack
    // label, swap a tier's reporter/flags, or drop commands. The ONLY time to
    // re-emit `lifecycle` is when the OPERATOR explicitly asks to CHANGE it — and
    // then you MUST also set `captureDelta.lifecycleChange: true` so the change is
    // operator-visible (a silent re-emission is rejected and flagged as drift).
    "LIFECYCLE IS PINNED ONCE CAPTURED: if `lifecycle` is already non-null in the",
    "capture below, it is the operator's CONFIRMED stack — do NOT re-emit it to",
    "re-state it, and NEVER drift the stack label / swap tier commands / drop flags.",
    "Omit `captureDelta.lifecycle` to keep it. Re-emit a DIFFERENT lifecycle ONLY",
    "when the operator explicitly asks to change it, and then ALSO set",
    "`captureDelta.lifecycleChange: true` (a silent re-emission is rejected as drift).",
    "",
    "Return exactly one InterviewRoundOutput: `say` is your next question (or a closing",
    "summary when the interview is complete), `captureDelta` is ONLY the new capture this",
    "round adds (the engine merges it), `suggestions` are optional inline answers, and",
    "`complete` is true once every capture area is filled. Ask one focused question at a time.",
    "",
    // VARIABLE TAIL (changes every round) — LAST so it never invalidates the static
    // prefix above.
    `This is round ${context.round} of ~${context.totalRounds}.`,
    "The operator's latest answer:",
    context.answer === "" ? "(none — this is the opening round)" : context.answer,
    "",
    "Capture accumulated so far (compact JSON):",
    captureJson,
  ].join("\n");
}
