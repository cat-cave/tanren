# Spec-implementation loop redesign — pointer page

The spec-implementation loop redesign originally lived as a standalone design
doc while the refactor was in flight (PR #434 landed the redesign — WS1 + WS2 —
and PR #435 purged the last vestigial retry-cap). The design intent has since
been **folded into the architecture doctrine + the code itself**, so this page
is a **pointer** rather than a source-of-truth. Comments across the engine
still cite `docs/roadmap/spec-loop-redesign.md § "X"` for historical continuity;
this page tells a fresh reader where the current canonical text lives.

## Where the design intent lives now

- **`docs/architecture/autonomy-engine.md`** is the durable design rationale:
  - **§1c.1 — "The intelligent non-convergence detector (no hardcoded attempt
    caps)"** is the load-bearing convergence doctrine every citation to
    `§ "convergence"` / the CONVERGENCE answerer / the velocity-defer /
    consecutive-stall HALT references. It formalizes progress vs. fixed-point,
    the `escalation: keep_going | escalate` verdict shape, and the binding
    "no hardcoded `K`/`MAX_*`/timeout" principle.
  - **§1c** — spec-level re-drive on transient failure, the re-drive vs. HALT
    classification the loop rides on.
  - **§1e — "Design is a first-class engine concern"** is where the design
    oracle stage in the loop is specified.
  - **§2b — "DAG-aware, intent-preserving conflict resolution"** is where the
    "keep intent alive across a conflict" rule the loop's re-planning path
    follows lives.
- **`ROADMAP.md`** carries the timeline + shipped-status entries (search
  "spec-implementation loop" / "convergence detector" / "retry-cap").
- **`docs/roadmap/timeout-eradication.md`** is the coordinating artifact for
  the doctrine the redesign is one prong of: NO arbitrary timeouts / retry caps
  / attempt caps anywhere in the engine.

## Where the design intent is exercised in code

The redesign shipped inline as the modules listed below — reading them is the
fastest way to see the loop's actual shape. Comments in these files cite the
sections referenced above.

- **The loop's outer orchestrator + shape:**
  `services/orchestrator/src/engine/workflow/subtaskLoop.ts` carries the shape
  `PLANNER → per-task[ WRITER → FAST GATE (tier-1) → CHECKER ] → SPEC GATE
(tier-2, CI-fail=P0) → AUDITOR → DEMO (optional) → findings? → TRIAGE →
CONVERGENCE`, plus the HALT rules (no retry-cap; only a convergence stall or
  a budget-exhaustion halt).
- **Per-stage detail:** `subtaskInnerLoop.ts`, `loopStages.ts`,
  `auditorStage.ts`, `loopStagePrompts.ts`, `loopFindings.ts`, `loopPolicy.ts`,
  `auditor/auditor.ts`, `checker/checker.ts`.
- **The answerer schemas the loop drives:**
  `services/orchestrator/src/engine/answerers/schemas/{audit,check,convergence,demoRun,specQuality,triage}.ts`
  — one file per stage answerer, strict-JSON output, malformed ⇒
  `AnswererSchemaValidationError`.
- **The convergence assessor + progress backstop shared across every loop:**
  `services/orchestrator/src/engine/workflow/convergenceDetector.ts` (fixed-point
  rule + PROGRESS signal), wrapped by `retryUntilConverged.ts` and paired with
  the `ActivityWatchdog` for the sign-of-life dimension.
- **Config + state:** `engine/config/{projectConfig,shared}.ts` (convergence
  policy + velocity-defer configurable), `engine/state/{run,task}.ts`,
  `engine/events/sensitivityRules.loop.ts`,
  `engine/events/schemas/answerer.ts`.
- **Tests:**
  `services/orchestrator/tests/{loopPolicy,plannerLoop,gateLoopRouting}.test.ts`
  paired with `services/orchestrator/tests/helpers/plannerLoopHelpers.ts`.

## History

- **PR #434** — `feat(loop): spec-implementation loop redesign — convergence not
retry-caps (WS1+WS2)` — landed the redesign.
- **PR #435** — `refactor(loop): purge vestigial maxPlannerRerunsPerSpec + make
velocity-defer configurable` — closed out the last vestigial retry-cap.
- **Later doctrine sweep** — `docs/roadmap/timeout-eradication.md` (#609–#622,
  plus disguised-survivor fixes) generalized the same principle across the rest
  of the engine (CI-gated by `scripts/check-architecture-timeouts.mjs`).

If a citation reads `spec-loop-redesign.md § "convergence"`, read
`docs/architecture/autonomy-engine.md §1c.1`. If it reads `§ "Workstream 1"` /
`§ "Workstream 2"`, read the PR #434 description (they were the two workstreams
of that PR) alongside the modules above.
