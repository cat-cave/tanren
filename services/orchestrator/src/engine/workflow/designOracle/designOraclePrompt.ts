// Single source of truth for the Design-Oracle Answerer PROMPT TEXT (WS-D4 of
// docs/roadmap/native-design-subsystem.md). The design oracle judges whether the
// built output satisfies the project's first-class `DesignContract` (WS-D1). It is
// a NEW answerer in the mold of the checker/auditor/demo-run — it self-inspects the
// built output in a READ-ONLY sandbox and emits findings; it never has context
// injected as raw blobs beyond the RESOLVED contract + entity graph it must verify
// against (the contract is the durable artifact under test, not arbitrary context).
//
// THE MOAT — the prompt renders THREE things no standalone design tool has:
//   1. an EXHAUSTIVE BEHAVIOR-COVERAGE CHECKLIST — every `behaviorRef` (resolved to
//      its real given/when/then) must have a designed/implemented surface or flow;
//   2. PERSONA-SCOPED FIDELITY — each surface is verified for its RESOLVED persona
//      (no "assume default admin"); a dimension's `personaRefs` scope it to a
//      persona's view, the contract-level `personaRefs` are the all-surfaces set;
//   3. DOMAIN-AWARE MODE — the agent is given the contract's `domain` + each
//      dimension's `intent` and CHOOSES the verification mode (web → render/inspect
//      surfaces; novel → prose/typography; game → art/feel). Tanren never branches
//      on the domain; the prompt stays domain-general by construction.
//
// READ-ONLY: like the demo-run answerer, the oracle runs in a read-only sandbox and
// cannot start a server or render live. It probes STATICALLY (reads the surfaces /
// artifacts the contract names + the diff) and, when fidelity genuinely cannot be
// judged statically (it needs a live render the sandbox cannot do), emits a single
// `design-not-verifiable` info finding rather than fabricate a pass or a failure.

export interface ResolvedPersona {
  id: string;
  name: string;
  description: string;
}

export interface ResolvedBehavior {
  id: string;
  // The persona this behavior belongs to (already resolved to the persona row's id),
  // so the checklist can attribute coverage per persona.
  personaId: string;
  title: string;
  given: string;
  when: string;
  then: string;
}

// One contract dimension as rendered for the oracle: the domain-declared key/label,
// the `intent` bar the oracle judges fidelity against, optional guidance, and the
// persona ids that scope it (empty ⇒ applies to every persona on the contract).
export interface ResolvedDimension {
  key: string;
  label: string;
  intent: string;
  guidance: string;
  personaRefs: ReadonlyArray<string>;
}

export interface DesignOraclePromptInput {
  // The descriptive design domain label — the signal the oracle uses to CHOOSE its
  // verification mode (never a Tanren branch). E.g. "saas-web", "novel-translation".
  domain: string;
  // The universal contract core (domain-independent).
  identity: string;
  intent: string;
  principles: ReadonlyArray<string>;
  constraints: ReadonlyArray<string>;
  // The domain-adaptive dimension set (the project's own declaration).
  dimensions: ReadonlyArray<ResolvedDimension>;
  // The RESOLVED personas the contract binds to (the moat — typed, not guessed).
  personas: ReadonlyArray<ResolvedPersona>;
  // The RESOLVED behaviors the design is responsible for COVERING (the moat — the
  // exhaustive coverage checklist).
  behaviors: ReadonlyArray<ResolvedBehavior>;
  // The run base the writer's change is diffed against; the oracle self-inspects.
  baselineSha: string;
}

function renderPersona(persona: ResolvedPersona): string {
  const desc = persona.description.trim() === "" ? "(no description)" : persona.description;
  return `- [${persona.id}] ${persona.name}: ${desc}`;
}

function renderBehavior(behavior: ResolvedBehavior): string {
  // The given/when/then is the design acceptance criterion the surface must cover.
  return [
    `- [${behavior.id}] (persona ${behavior.personaId}) ${behavior.title}`,
    `    Given ${behavior.given}`,
    `    When ${behavior.when}`,
    `    Then ${behavior.then}`,
  ].join("\n");
}

function renderDimension(dimension: ResolvedDimension): string {
  const scope =
    dimension.personaRefs.length === 0
      ? "all personas on the contract"
      : `personas ${dimension.personaRefs.join(", ")}`;
  const lines = [`- [${dimension.key}] ${dimension.label} (scope: ${scope})`, `    Intent: ${dimension.intent}`];
  if (dimension.guidance.trim() !== "") {
    lines.push(`    Guidance: ${dimension.guidance}`);
  }
  return lines.join("\n");
}

// The canonical self-inspection block — the writer's change is committed on the
// current branch of the read-only workspace; the oracle inspects it itself (no diff
// is injected). Mirrors the checker/demo-run self-inspection contract.
function selfInspectionBlock(baselineSha: string): string[] {
  return [
    "The built output is committed on the current branch of your READ-ONLY workspace.",
    "Inspect it yourself: run",
    `  git diff ${baselineSha} -- . ':(exclude)node_modules'`,
    "to see what changed, then READ the surfaces / artifacts the contract is about",
    "(for a web UI: the components, styles, routes, and rendered markup; for a novel:",
    "the prose/typography files; for a game: the art / UI / feel assets). Do NOT expect",
    "the output to be provided inline — read it from the workspace.",
  ];
}

export function buildDesignOraclePrompt(input: DesignOraclePromptInput): string {
  return [
    "You are the Tanren Design Oracle. Your ONLY job is to judge DESIGN FIDELITY: does",
    "the built output satisfy the project's DESIGN CONTRACT? This is distinct from the",
    "checker (per-task completeness), the auditor (quality/security), and the demo-run",
    "answerer (does the user-flow work) — you verify the output LOOKS AND FEELS like the",
    "contract demands, covers every behavior the design is responsible for, and is",
    "correct for each RESOLVED persona.",
    "",
    "DOMAIN-AWARE — you are NOT assuming a web UI. Choose HOW to verify from the",
    `contract's domain and dimensions. The design domain is: ${input.domain}. A web UI is`,
    "verified by inspecting the rendered surfaces; a novel translation by its prose and",
    "typography; a game by its art direction and feel. Decide the verification mode that",
    "fits THIS domain and its dimensions, and report it in `verificationMode`.",
    "",
    ...selfInspectionBlock(input.baselineSha),
    "",
    "IMPORTANT — you run in a READ-ONLY sandbox: you CANNOT start a server, render live,",
    "or perform live I/O. Probe STATICALLY: read the surfaces/artifacts + the diff and",
    "reason about fidelity. Emit findings ONLY for gaps you can SUBSTANTIATE from what you",
    "read. If a fidelity judgement genuinely CANNOT be made statically (it needs a live",
    "render you cannot perform), emit a SINGLE info-severity finding with id",
    "`design-not-verifiable` saying so — do NOT invent a pass or a failure.",
    "",
    "Render NO pass/fail verdict and do NOT edit files, run mutation commands, create",
    "commits, or write to the workspace. Return only the structured JSON required by the",
    "provided schema.",
    "",
    "==== THE DESIGN CONTRACT (the bar you judge against) ====",
    `Design identity: ${input.identity}`,
    `Design intent (north star): ${input.intent}`,
    ...(input.principles.length === 0
      ? ["Design principles: (none)"]
      : ["Design principles:", ...input.principles.map((p) => `- ${p}`)]),
    ...(input.constraints.length === 0
      ? ["Design constraints (non-negotiable): (none)"]
      : ["Design constraints (non-negotiable):", ...input.constraints.map((c) => `- ${c}`)]),
    "",
    "Design dimensions (the project's domain-declared facets; verify each against its",
    "intent — a dimension scoped to specific personas is THAT persona's view of the",
    "surface):",
    ...(input.dimensions.length === 0 ? ["(no dimensions declared)"] : input.dimensions.map(renderDimension)),
    "",
    "==== PERSONAS (resolved — no guessing; each surface must be correct for ITS persona) ====",
    ...(input.personas.length === 0 ? ["(no personas bound)"] : input.personas.map(renderPersona)),
    "",
    "==== BEHAVIOR-COVERAGE CHECKLIST (exhaustive — every behavior MUST have a designed surface/flow) ====",
    "For EACH behavior below, verify the built output provides a designed/implemented",
    "surface or flow that covers it FOR THAT BEHAVIOR'S PERSONA. A behavior with NO",
    "covering surface is a COVERAGE GAP — emit a finding citing the behavior id. A surface",
    "that exists but is wrong for its resolved persona is a PERSONA-SCOPED FIDELITY miss —",
    "emit a finding citing the persona id.",
    ...(input.behaviors.length === 0
      ? ["(no behaviors bound — there is no coverage obligation; do not invent one)"]
      : input.behaviors.map(renderBehavior)),
    "",
    "==== HOW TO ANSWER ====",
    "Emit `findings` (each with an explicit severity P0-P3): one per behavior-coverage",
    "gap, persona-scoped fidelity miss, or violated contract dimension/principle/",
    "constraint. Give each a stable slug `id`, a `title`, and a `body` that names the",
    "behavior id / persona id / dimension key it concerns and what is wrong. Emit an",
    "EXPLICIT empty `findings: []` when the output is design-faithful — never invent a",
    "finding. Set `verificationMode` to the domain-derived mode you used, and `summary`",
    "to what you inspected (surfaces/artifacts read + behaviors/personas/dimensions",
    "verified).",
  ].join("\n");
}
