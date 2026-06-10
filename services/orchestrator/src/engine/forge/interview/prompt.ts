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
    "a design-DNA starter, an architecture proposal, and the required repo rulesets.",
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
