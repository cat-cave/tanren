// The WRITER PROMPT for the per-subtask inner loop (subtaskInnerLoop.ts). Split out so the
// inner-loop module stays under the 500-line architecture cap, and so the writer guidance —
// the standing toolchain + immutable-contract + grading instructions and the
// contract-violation rework steering — is single-sourced and unit-testable in one place.
//
// MODE-AWARE (task #86 — v64 root cause). The standing GRADING instruction differs by spec
// mode: `from_scratch` keeps today's "build everything ELSE — manifest/lockfile, sources,
// configs, tests, fixtures" guidance (the brownfield/legacy authoring path); the greenfield
// SCAFFOLD spec runs in `specialize_seed` mode, where the workspace's initial commit IS the
// composed VFS — manifest, lockfile, tsconfig, contract files, source skeleton are ALREADY in
// place AND proven green by composition — so the writer is told to touch ONLY product-identity
// surfaces and is explicitly forbidden from rebuilding the manifest, regenerating the lockfile,
// editing configs, or adding new tests/lint configs. v64 spent 6 hours / 61 writer iterations
// without converging because the spec text said "INSTANTIATE the seed" but the standing
// instruction said "Build everything ELSE — manifest/lockfile, sources, configs, tests" — the
// writer kept doing what the standing instructions said, checker kept catching the scope
// drift, but each iteration was a DIFFERENT over-broad diff so the fixed-point detector never
// fired. See `services/orchestrator/src/engine/state/spec.ts` for the `SpecMode` enum.
import type { PlanSubtask } from "../answerers/schemas/index.js";
import { DEFAULT_SPEC_MODE, type SpecMode } from "../state/spec.js";
import type { SubtaskLoopInput } from "./subtaskLoop.js";

// A standing toolchain instruction prepended to every writer prompt. Stack-agnostic (the
// project DECLARES its own dependencies + toolchain — JS/TS, Rust, Python, a translation
// project, anything): name no specific tool here. The rule is about REALNESS, not a stack.
const WRITER_TOOLCHAIN_INSTRUCTION =
  "Use the project's OWN declared dependencies and toolchain (whatever the project actually " +
  "declares — its real manifest + lockfile / pinned versions). Declare real, published, " +
  "resolvable dependencies. NEVER stub, fake, vendor, or shim a toolchain binary or " +
  "dependency, and never invent placeholder versions — use the real published artifacts the " +
  "project's declared toolchain resolves.";

// The IMMUTABLE-CONTRACT files: the project's DECLARED lifecycle + gate contract that the
// writer must NEVER edit. A Tanren project declares its lifecycle (tier-1/2/3 + build +
// deploy commands) in its `justfile` and its native gate in `.tanren/ci.yml`; those two
// files ARE the fixed contract the build satisfies, not changes. Stack-agnostic — these are
// Tanren's OWN contract surface (every project declares its lifecycle through them, whatever
// the stack — JS/TS, Rust, Python, a translation project), not a stack assumption. Listed
// once here so the writer guidance + the contract-violation rework steering name the same set.
export const IMMUTABLE_CONTRACT_FILES = ["justfile", ".tanren/ci.yml"] as const;

// A standing instruction prepended to every writer prompt: the project's declared contract
// files are FIXED — the writer SCAFFOLDS the project (manifest, sources, configs, tests,
// etc.) to SATISFY the declared lifecycle commands, WITHOUT editing those contract files.
// This is the v40 scaffold-oscillation fix: a scaffold writer kept redefining the justfile (a
// fixed contract) → blocked → over-reverted the whole scaffold to avoid the violation → no net
// change → blocked, oscillating forever. Naming the contract as UNTOUCHABLE up front (and the
// task as: make the rest of the tree satisfy it) stops the writer ever reaching for it.
//
// MODE: this is the `from_scratch` variant (today's brownfield/legacy authoring) — it frames
// the task as "scaffold the rest to SATISFY the contract." The `specialize_seed` variant
// (`WRITER_CONTRACT_INSTRUCTION_SPECIALIZE_SEED`) drops the "build everything else" framing
// because the seed already includes (almost) everything else, proven green.
const WRITER_CONTRACT_INSTRUCTION =
  "The project's DECLARED CONTRACT files are FIXED — you must NOT create, edit, delete, or " +
  `move them: ${IMMUTABLE_CONTRACT_FILES.join(", ")} (the project's lifecycle recipes + its ` +
  "native gate definition). They are the contract your work SATISFIES, not changes. Build " +
  "everything ELSE — the manifest/lockfile, sources, configs, tests, fixtures — so that the " +
  "lifecycle commands those contract files already declare PASS as written. If a lifecycle " +
  "command fails, fix the project to satisfy it; NEVER change the contract file to match your " +
  "code. Treat any change to a contract file as a build-breaking error.";

// The `specialize_seed`-mode variant of the contract instruction (task #86). The contract
// files are part of a WHOLE composed seed that is ALREADY in place; the "build everything
// ELSE" framing is dropped here because the seed already includes (almost) everything else
// too. The contract files remain explicitly listed as untouchable (the v40 rule still
// applies, but is now reinforced by the seed already shipping them in their proven-green
// shape — specialization NEVER modifies them).
const WRITER_CONTRACT_INSTRUCTION_SPECIALIZE_SEED =
  "The project's DECLARED CONTRACT files are FIXED — you must NOT create, edit, delete, or " +
  `move them: ${IMMUTABLE_CONTRACT_FILES.join(", ")} (the project's lifecycle recipes + its ` +
  "native gate definition). The seed already includes them in their proven-green composed " +
  "shape; specialization NEVER modifies them. Treat any change to a contract file as a " +
  "build-breaking error.";

// How the writer's change will be GRADED (spec-loop redesign §WRITER, workstream 1).
// Steers the writer to satisfy the gate on the first pass: run the fast deterministic
// gate (fmt/lint/typecheck) BEFORE finishing — a fast-gate failure loops straight back
// to it — then names the CHECKER (completeness) + AUDITOR (quality) bars it is judged on.
// Also covers DERIVED-ARTIFACT reconciliation (the apex-v43 lockfile-staleness finding):
// any change to a source that has a generated companion must regenerate that companion
// and commit it, because the gate may run a strict/frozen check against it (e.g. a
// frozen-lockfile install that fails instantly on a stale lockfile). Stack-agnostic —
// this is framed in terms of the project's DECLARED lifecycle commands (whatever the
// stack), never specific tools or package managers.
//
// MODE: this is the `from_scratch` variant (today's brownfield/legacy authoring) — it
// tells the writer to BUILD everything ELSE (manifest/lockfile, sources, configs, tests,
// fixtures) and to REGENERATE generated companions after a manifest edit. For the
// `specialize_seed` mode the writer gets `WRITER_SPECIALIZE_SEED_GRADING_INSTRUCTION`
// instead, which forbids manifest/lockfile/config/test changes since the composed seed
// already supplies all of those, proven-green.
const WRITER_GRADING_INSTRUCTION =
  "How your change will be graded — satisfy these BEFORE you finish: a FAST " +
  "deterministic gate runs first (formatting, lint, typecheck) — RUN it yourself " +
  "(the project's fmt/lint/typecheck commands) and make it pass before you stop, " +
  "since a fast-gate failure loops straight back to you before any reviewer. A " +
  "FORMATTING failure is mechanical: run the project's declared format-WRITE step (the " +
  "one its lifecycle/justfile defines — e.g. its format/fix recipe, NOT just the " +
  "check) over EVERY file you touched, then re-run the check — never hand back the same " +
  "unformatted output. RECONCILE generated companions: when your change modifies a " +
  "source that has a generated or derived companion — a dependency lockfile derived " +
  "from a manifest, generated code, formatted output, snapshots — run the project's " +
  "DECLARED command that regenerates that companion and COMMIT the result alongside " +
  "your change. The gate may run a strict frozen check (e.g. a frozen-lockfile install) " +
  "that fails instantly if the companion is stale, so a manifest edit without a " +
  "matching regenerated lockfile will be rejected before any reviewer sees it. " +
  "Specifically for dependency changes: after editing a package manifest, run the " +
  "project's declared install or bootstrap step so the lockfile is regenerated to match, " +
  "and commit both together. 'Upgrade to latest' means bump to newer PUBLISHED versions " +
  "(then regenerate the lockfile) — rewriting version-range syntax to an equivalent " +
  "range is NOT an upgrade and will break a frozen-lockfile gate. Then a CHECKER " +
  "judges whether your change COMPLETES the subtask intent + every relevant acceptance " +
  "criterion (leave it complete and self-contained), and an AUDITOR reviews " +
  "quality/security/perf (write correct, secure, clean code).";

// The `specialize_seed`-mode grading instruction (task #86 — v64 root cause). The composed
// seed is ALREADY in place AND proven green by composition — the writer MUST NOT rebuild
// what is already there. The standing instruction enumerates what is PRE-EXISTING (manifest,
// lockfile, tsconfig, lint/test/build configs, contract files, source skeleton, demo) and
// points the writer at the SPEC's acceptance criteria as the canonical list of what to
// touch (product-identity surfaces — package manifest `name`, deploy slug, .env.example,
// README, src/demo, etc). The "build everything ELSE" framing is DROPPED — it is exactly
// what made v64's writer keep doing out-of-scope edits each iteration even though the spec
// text said "INSTANTIATE the seed". The lockfile-regeneration / manifest-companion /
// package-manager-upgrade rules are dropped entirely (they don't apply — there ARE no
// manifest edits in seeded mode). Stack-agnostic (no tool names baked in); the
// keep-the-gate-green rule still applies, but a gate failure is fixed by adjusting the
// surfaces the writer DID touch — never by reaching for the seed's pre-existing config.
const WRITER_SPECIALIZE_SEED_GRADING_INSTRUCTION =
  "How your change will be graded — this spec runs in SPECIALIZE-SEED mode: the workspace's " +
  "initial commit IS the composed seed. The manifest, lockfile, tsconfig, lint/test/build " +
  "configs, contract files (justfile + .tanren/ci.yml), source skeleton, demo — ALL of these " +
  "are ALREADY IN PLACE and PROVEN GREEN by composition. Your job is to SPECIALIZE the seed " +
  "for THIS product, NOT to rebuild any of it. Touch ONLY product-identity surfaces — the " +
  "canonical list is the spec's acceptance criteria, typically: the manifest's `name` field " +
  "(rename only — do NOT add, remove, or version-bump dependencies), the deploy descriptor's " +
  "`app`/slug, .env.example placeholders, README and product metadata, the product-specific " +
  "demo or entrypoint. Do NOT rebuild or regenerate the manifest's dependency list, do NOT " +
  "regenerate the lockfile, do NOT edit tsconfig / lint configs / test configs / build " +
  "configs, do NOT add new tests or test fixtures, do NOT add or edit the contract files " +
  "(justfile, .tanren/ci.yml). The seed's gates are already proven; the FAST deterministic " +
  "gate (fmt/lint/typecheck) must STAY green — RUN it yourself before you stop. If your " +
  "specialization breaks a lifecycle command, fix the surface YOU touched (e.g. a rename you " +
  "missed, a placeholder you didn't fill in); NEVER reach for the seed's pre-existing " +
  "manifest/config to make the failure go away. A FORMATTING failure is mechanical: run the " +
  "project's declared format-WRITE step over the files YOU touched and re-run the check. " +
  "Then a CHECKER judges whether your change COMPLETES the subtask intent + every acceptance " +
  "criterion without scope drift onto seed-owned surfaces, and an AUDITOR reviews " +
  "quality/security/perf (write correct, secure, clean code).";

// Does a rejection reason indicate the writer EDITED an immutable contract file? Detected by
// the contract-file PATH appearing in the reason (the checker/auditor/gate name the offending
// file) — stack-agnostic, since the path set is the project's declared contract surface, not a
// tool. Substring match on the path is enough: a finding that says "you redefined the justfile"
// or "justfile-contract-mismatch" or names `.tanren/ci.yml` all surface the path.
function mentionsContractFile(reason: string): boolean {
  const lower = reason.toLowerCase();
  return IMMUTABLE_CONTRACT_FILES.some((file) => lower.includes(file.toLowerCase()));
}

// PRECISE rework steering for a contract-file violation: revert ONLY the change to the
// contract file and KEEP the rest of the scaffold. Without this, a writer faced with "you
// redefined the justfile" tends to over-correct — reverting the WHOLE scaffold to no net
// change (which is itself blocked), then re-introducing it (re-violating), oscillating
// forever (the v40 finding). Returns the steering lines, or [] when the reason is not a
// contract violation. Stack-general — it names the declared contract-file set, no tool.
export function contractViolationSteering(reason: string): string[] {
  if (!mentionsContractFile(reason)) return [];
  return [
    `This rejection is a CONTRACT-FILE violation — your change touched a FIXED contract file ` +
      `(${IMMUTABLE_CONTRACT_FILES.join(", ")}), which you must never edit. Fix it PRECISELY: ` +
      "revert ONLY the change to the contract file (restore it exactly as it was) and KEEP the " +
      "rest of your scaffold. Do NOT revert or delete the project files you added to satisfy the " +
      "lifecycle — change THOSE (or add what's missing) so the contract's commands pass unchanged. " +
      "Reverting the whole scaffold to no net change is NOT a fix and is also rejected.",
  ];
}

// Pick the standing instruction set the writer prompt assembles for this spec, by mode.
// `from_scratch` (default) → today's brownfield/legacy guidance (build manifest, sources,
// configs, tests, regenerate lockfile companions, etc). `specialize_seed` → the
// seeded-mode guidance (composed seed is in place + proven green; touch ONLY
// product-identity surfaces; no manifest/lockfile/config/test churn).
function standingInstructionsFor(mode: SpecMode): { contract: string; grading: string } {
  if (mode === "specialize_seed") {
    return {
      contract: WRITER_CONTRACT_INSTRUCTION_SPECIALIZE_SEED,
      grading: WRITER_SPECIALIZE_SEED_GRADING_INSTRUCTION,
    };
  }
  return { contract: WRITER_CONTRACT_INSTRUCTION, grading: WRITER_GRADING_INSTRUCTION };
}

export function writerPromptFor(
  input: SubtaskLoopInput,
  subtask: PlanSubtask,
  iter: number,
  lastReason: string,
): string {
  const criteria =
    input.context.acceptanceCriteria.length > 0
      ? ["", "Acceptance criteria:", ...input.context.acceptanceCriteria.map((criterion) => `- ${criterion}`)]
      : [];
  // On a re-iteration (gate fail / checker incompleteness) the prior reason steers the
  // writer at the concrete gap before it spends the iteration. When that reason is a
  // CONTRACT-FILE VIOLATION (the writer edited a fixed contract file), the steering is
  // PRECISE — revert ONLY that change, keep the rest of the scaffold — so the writer stops
  // oscillating between violate-everything and revert-everything (the v40 scaffold finding).
  //
  // PLACEMENT (task #86 — defensive). The rework block goes AFTER the standing instructions,
  // not before them. The writer reads top→bottom and weights the LAST thing it reads most
  // heavily on a re-iteration; in v64 the order was (spec "INSTANTIATE the seed") → (rework
  // reason "previous attempt had scope drift") → (standing "build everything ELSE"). The
  // standing instruction WON every iteration because it was last. The seeded-mode rewrite
  // removes that contradiction for scaffold specs, but the placement matters defensively for
  // every rework iteration regardless: putting the concrete failing reason LAST means it is
  // the strongest signal on every re-drive — which is the right ordering when iter > 0.
  const rework =
    iter > 0 && lastReason !== ""
      ? [
          "",
          `Previous attempt was rejected: ${lastReason}`,
          ...contractViolationSteering(lastReason),
          "Address it directly.",
        ]
      : [];
  // WS-D2 (native design subsystem): the project's rendered design block for its HEAD
  // `DesignContract` — persona-scoped, behavior-linked, domain-general. Present ⇒ the build
  // honors the design (the no-handoff loop); ABSENT ⇒ the project has no design contract (a real
  // empty state) and the writer simply gets no design block — NEVER a fabricated default.
  const design = input.context.designContextBlock === undefined ? [] : ["", input.context.designContextBlock];
  const mode: SpecMode = input.context.specMode ?? DEFAULT_SPEC_MODE;
  const standing = standingInstructionsFor(mode);
  return [
    `Subtask [${subtask.index}]: ${subtask.title}`,
    `Intent: ${subtask.intent}`,
    `Behaviors: ${subtask.behaviorIds.join(", ") || "(none)"}`,
    "",
    `Spec: ${input.context.specTitle}`,
    input.context.specDescription,
    ...criteria,
    ...design,
    "",
    WRITER_TOOLCHAIN_INSTRUCTION,
    "",
    standing.contract,
    "",
    standing.grading,
    ...rework,
  ].join("\n");
}
