import { z } from "zod";
import { CiYamlParseError, parseYaml } from "../ci/yaml.js";

// Versioned Zod schema for `.tanren/template.yml` — the metadata that rides
// inside a TEMPLATE repo (a validated instance of the stack-flexible contract;
// docs/roadmap/templating-system.md §1). A template is a real conforming repo
// PLUS this manifest: it declares what stack the repo embodies, the CAPABILITIES
// it bakes (so selection can query by capability, not a stack string), the
// release channel it tracks, its provenance, and — once validated — the
// negative-control proof that its gates actually check (the "meaningful, not
// green-by-accident" oracle result).
//
// This module is the CONTRACT + PARSER only. It never validates a repo, runs a
// gate, or touches the registry — the validation harness (a later wave) produces
// the `validationProof`; the registry store persists the parsed manifest. Like
// the `.tanren/ci.yml` parser, malformed input ALWAYS throws (never degrades to a
// default) so a mangled template manifest fails LOUDLY rather than registering a
// half-described template.
//
// STACK-AGNOSTIC by construction: `capabilities` describes ANY stack — a TS/pnpm
// web app, a Rust/cargo service, or a non-code project (a Russian-novel
// translation: runtime "prose", gates ["spellcheck", "consistency"], bdd false).
// Tanren names no stack here; the manifest is the project's own declaration.

// ---- Capabilities ----------------------------------------------------------

// What a template's conforming repo can DO, in capability terms (NOT a stack
// string). Selection (a later wave) queries by these so a never-seen stack is
// matched on capability, never on a hardcoded stack name. Every field is a free
// declaration: `runtime`/`packageManager`/`framework`/`deployTarget` are opaque
// labels (e.g. "node"/"cargo"/"prose", "pnpm"/"uv", "next"/"axum", "vercel"); the
// gate/bdd/mutation/junit flags say which parts of the full-bar feature set the
// template actually bakes (the validation harness PROVES these meaningful).
export const TemplateCapabilities = z
  .object({
    // The execution runtime the repo targets (opaque label — "node", "bun",
    // "cargo", "python", "prose"). No stack is privileged.
    runtime: z.string().min(1),
    // The dependency/package manager the bootstrap uses ("pnpm", "uv", "cargo").
    packageManager: z.string().min(1),
    // The application framework, when the stack has one ("next", "axum"). Absent
    // for stacks/non-code projects with no framework concept.
    framework: z.string().min(1).optional(),
    // The deploy target the template's `just deploy` is wired for ("vercel",
    // "flyio", "hetzner"). Absent when the template ships no deploy hook.
    deployTarget: z.string().min(1).optional(),
    // The conventional gate target NAMES the template's justfile fills + proves
    // (e.g. ["tier-1", "tier-2", "tier-3"]). Stack-agnostic — a novel template's
    // gates might be ["spellcheck", "consistency"].
    gates: z.array(z.string().min(1)),
    // Whether the template bakes behavior-driven specs (the BDD feature set).
    bdd: z.boolean(),
    // Whether the template bakes mutation testing (seeded-mutant kill proof).
    mutation: z.boolean(),
    // Whether a test tier emits a machine-readable JUnit report (per-test grain
    // for flaky-intelligence; the JUNIT_REPORT_PATH convention).
    junit: z.boolean(),
  })
  .strict();
export type TemplateCapabilities = z.infer<typeof TemplateCapabilities>;

// ---- Channel ---------------------------------------------------------------

// The maintenance channel the template tracks. `lts` bumps only to LTS/stable
// releases (conservative, slow cadence); `nightly` aggressively tracks latest
// (the canary that catches a breaking tooling release FIRST). A version only
// graduates nightly→lts once nightly re-validates green (§4).
export const TemplateChannel = z.enum(["lts", "nightly"]);
export type TemplateChannel = z.infer<typeof TemplateChannel>;

// ---- Provenance ------------------------------------------------------------

// Where the template came from: the research sources the creation flow recorded
// (§2 step 1 — the web-researched current best practice for the stack) and, when
// Tanren built it with its own loop, the run id that created it. Provenance is
// durable evidence the template is grounded, not hand-waved.
export const TemplateProvenance = z
  .object({
    // The research sources (urls / references) the creation flow grounded the
    // template on. At least one — provenance is durable evidence the template is
    // grounded, not hand-waved (a hand-seeded template records a provenance note).
    // (`min(1)` also keeps the manifest inside the dependency-free YAML parser's
    // block-sequence subset — it expresses no empty array.)
    researchSources: z.array(z.string().min(1)).min(1),
    // The Tanren run id that authored this template via the creation meta-DAG,
    // when it was built by the loop (absent for an externally-authored template).
    createdByRunId: z.string().min(1).optional(),
  })
  .strict();
export type TemplateProvenance = z.infer<typeof TemplateProvenance>;

// ---- Validation proof ------------------------------------------------------

// The per-negative-control verdict. `proven` = a planted mutation made the gate
// FAIL (the gate genuinely checks — the Lodestar oracle idea); `unproven` = the
// negative control was not run (so the gate could be green-by-accident);
// `"n/a"` = the template does not bake this gate (so there is nothing to prove).
export const NegativeControlResult = z.enum(["proven", "unproven", "n/a"]);
export type NegativeControlResult = z.infer<typeof NegativeControlResult>;

// The KILLER-step result (§2 step 4): proof the template is MEANINGFUL, not
// green-by-accident. Positive controls (`just bootstrap/tier-1/2/3/build`) all
// passed AND the negative controls proved each gate actually checks AND the
// auditor found no open P0/P1. Produced by the validation harness (a later wave),
// persisted on the manifest, refreshed on every maintenance bump. `null` on the
// manifest means UNVALIDATED — the registry then keeps the template `draft`.
export const TemplateValidationProof = z
  .object({
    // Every positive control (`just bootstrap/tier-1/2/3/build`) passed.
    positiveControlsPassed: z.boolean(),
    // Per-gate negative-control verdicts — the proof each gate FAILS on a planted
    // defect. The four full-bar gate classes, each `proven`/`unproven`/`"n/a"`.
    negativeControls: z
      .object({
        typecheck: NegativeControlResult,
        lint: NegativeControlResult,
        test: NegativeControlResult,
        mutation: NegativeControlResult,
      })
      .strict(),
    // The auditor/convergence verdict: no open P0/P1 findings after convergence.
    auditorClean: z.boolean(),
    // When the proof was produced (ISO-8601). The registry marks a template
    // DEGRADED when this proof expires.
    validatedAt: z.string().min(1),
    // The exact template-repo commit the proof was produced against, so a later
    // bump invalidates a stale proof.
    validatedSha: z.string().min(1),
  })
  .strict();
export type TemplateValidationProof = z.infer<typeof TemplateValidationProof>;

// ---- Top-level manifest ----------------------------------------------------

export const TemplateManifestV1 = z
  .object({
    version: z.literal(1),
    // The human label for the stack the template embodies ("ts-pnpm-next",
    // "rust-axum", "novel-ru-en"). Descriptive only — selection queries
    // `capabilities`, never this string, so a never-seen stack is never excluded
    // for failing a name match.
    stack: z.string().min(1),
    capabilities: TemplateCapabilities,
    channel: TemplateChannel,
    // The template's own version (semver or date label). Bumped by the
    // maintenance flow on each re-validated update.
    templateVersion: z.string().min(1),
    provenance: TemplateProvenance,
    // The negative-control + auditor proof, or `null` when the template has not
    // been validated yet (an unvalidated/draft template). Explicitly nullable so
    // an unvalidated manifest is a LOUD, first-class state — never an absent key
    // a reader might mistake for "validated".
    validationProof: TemplateValidationProof.nullable(),
  })
  .strict();
export type TemplateManifestV1 = z.infer<typeof TemplateManifestV1>;

// ---- Parser ----------------------------------------------------------------

// Thrown when `.tanren/template.yml` parsed as YAML cleanly but did not satisfy
// the schema (a missing capability, an unknown channel, a malformed proof).
// Distinct from CiYamlParseError (raw YAML syntax) so callers can report the two
// classes separately.
export class TemplateManifestValidationError extends Error {
  readonly issues: ReadonlyArray<z.core.$ZodIssue>;
  constructor(issues: ReadonlyArray<z.core.$ZodIssue>) {
    const summary = issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    super(`invalid .tanren/template.yml: ${summary}`);
    this.name = "TemplateManifestValidationError";
    this.issues = issues;
  }
}

export { CiYamlParseError as TemplateManifestYamlParseError };

// Parse raw `.tanren/template.yml` text into a validated, typed manifest. Uses
// the same dependency-free YAML parser the `.tanren/ci.yml` loader uses (the
// orchestrator carries no YAML dependency; the manifest shape stays inside that
// parser's supported subset). Invalid input ALWAYS throws — a YAML syntax error
// raises TemplateManifestYamlParseError, a schema violation raises
// TemplateManifestValidationError — so a malformed manifest fails LOUDLY and
// never registers a half-described template.
export function parseTemplateManifest(text: string): TemplateManifestV1 {
  const raw = parseYaml(text);
  const parsed = TemplateManifestV1.safeParse(raw);
  if (!parsed.success) {
    throw new TemplateManifestValidationError(parsed.error.issues);
  }
  return parsed.data;
}

// Round-trip the validated manifest back to a plain JSON-serializable object —
// the shape the registry persists into the `templates.manifest` jsonb column.
// Identity on a parsed manifest (the schema yields plain data), exposed as a
// named seam so the store + later waves never reach into the Zod type directly.
export function manifestToJson(manifest: TemplateManifestV1): Record<string, unknown> {
  return TemplateManifestV1.parse(manifest) as Record<string, unknown>;
}
