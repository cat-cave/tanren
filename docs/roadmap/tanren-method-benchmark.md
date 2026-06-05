# Tanren-Method Benchmark + Experimentation Harness

> **Status: the toolkit described here is BUILT** (prerequisite met — the run
> loop is live-validated to merged PRs across three tiers). Code-complete on
> `main` under `engine/benchmark/**` (entities, migration `0033`; `TrialScorecard`
> projection; `deriveCellScorecard`/`compareCells` reducers; `BenchmarkRunner`
> scheduling trials through the real worker; the post-merge hidden-`accept` step
> emitting `benchmark.accept.*`, migration `0034`) plus the
> `tanren experiments`/`tanren cells` CRUD + `report`/`compare` CLI over the
> `/orgs/:orgId/experiments[/cells]` routes. **The remaining piece is the seed
> corpus** (§1.2/§4.3 — content, not code). Where the design below says
> "net-new"/"proposed", that work has now landed.

## §0 — Why this exists, and what it is NOT

Tanren's thesis (`PROJECT_BRIEF.md` §0) is that **the workflow is the product**:
the plan → write → check → audit → native gate → PR → review → merge loop is what
makes arbitrary tasks reach merged code reliably. If that loop is the product,
the durable question is not "which model is best" but **"which configuration of
the Tanren _process_ produces the best delivery outcomes."** We want to answer
questions like:

- Does enforcing strict typing / code-standards adherence in the native gate
  (`.tanren/ci.yml` tier strictness) improve DORA metrics, or just add lead time?
- Do cheapest-models-only routing tables pay off, or cost more long-term via
  more retries, more audited concerns, and more rework?
- Does a stricter checker/auditor reduce change-failure rate enough to justify
  the added lead time and token spend?

This is a **process benchmark**, deliberately unlike a model leaderboard: models
and harnesses are held **fixed** inside an experiment; the thing under test is the
Tanren configuration around them. The success condition of every experiment is to
**reach the same verifiable end behavior** with some combination of less
wall-clock, fewer tokens / less cost, better DORA, fewer audited concerns, and
fewer retries.

Reference point: `facebookresearch/programbench` is the structural analogue —
programming tasks with machine-checkable acceptance and a runner that scores
attempts. We borrow its **task + harness + scorer** structure and its
machine-checkable-success discipline, and diverge on three axes: (1) **smaller
scale** — a handful of authored seed projects, sized to what we can afford to run
N times per cell (§5, §6); (2) **the unit under test is the _process config_, not
the _solver_** — programbench varies the model/agent with the task fixed; we hold
model+harness fixed and vary one Tanren knob; (3) **end-behavior equivalence, not
pass@k on a fixed harness** — "done" is the seed project's acceptance running as
its own CI, so two configs that both merge a green PR are comparable on the
_non-correctness_ axes. §8 maps ProgramBench's patterns and divergences in full.

## §1 — What a "benchmark task" is

A **benchmark task** = a seed project + a precise end-goal spec + machine-checkable
acceptance criteria. The non-negotiable property: **"same end behavior" is
verifiable by automation, not by an Answerer's judgment.** If success needed a
reasoning agent's opinion, two configs would not be comparable (the judge is part
of the config under test). So acceptance lives in the seed project's own CI, run
identically regardless of cell. This maps onto existing entities:

| Benchmark concept        | Existing Tanren entity                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| Seed project             | `projects` row + a real GitHub repo (the fixture-repo pattern)                   |
| End-goal spec            | `specs` row (`description` + `acceptance_criteria` JSONB)                        |
| Machine-checkable accept | the repo's `.tanren/ci.yml` tiers (`engine/ci/schema.ts`) run by the native gate |
| A single attempt         | a `runs` row driven by the run worker (`engine/worker/runExecutor.ts`)           |

The seed repo already carries its own acceptance gate: `.tanren/ci.yml` is run by
the **native gate** — Tanren executes the tiers itself over SSH (`engine/ci/schema.ts`,
`fixtures/tanren-ci.sample.yml`); there is no GitHub Actions. That is the lever that makes "same end behavior"
objective: a **frozen, hidden acceptance tier** in the seed repo — call it the
`accept` tier — that the _config under test never sees or edits_ and that the
benchmark scorer runs against the merged result. The configs vary the `fast`/`slow`
tiers (the strictness knob); the `accept` tier is constant and is the equivalence
oracle.

### §1.1 The tiered corpus

Stratify the corpus so a knob's effect is observed at three complexity levels (a
knob that helps trivial tasks may hurt non-trivial ones). Extends the existing
easy/medium/hard fixture ladder (`fixtures/tanren-fixture-{easy,medium,hard}`,
`docs/operator-guide/acceptance.md`).

- **Tier 0 — trivial fixture (smoke).** The existing
  `cat-cave/tanren-fixture-easy` shape: one function, one test, README mention.
  Acceptance = the existing easy-tier persisted-state assertions. **Purpose:** a
  cheap control that proves the _harness itself_ is deterministic enough before
  spending on real tasks — the calibration baseline, not where knobs show effect.
- **Tier 1 — small real feature.** A real (small) library/service with a single
  multi-file feature spec — the `fixture-medium` shape (≥ 2 planner subtasks, a
  genuine checker rejection likely). Acceptance = a hidden `accept` tier that
  exercises the feature's behavior (not just "tests pass"). **Purpose:** the
  first place strictness / model-cost knobs produce measurable deltas in retries
  and lead time.
- **Tier 2 — non-trivial multi-spec project.** A seed project with a small DAG
  of dependent specs (`spec_dependencies` edges, P2A-0018) toward **one named
  product end-goal** (e.g. "a working CLI todo app with persistence, an
  `add`/`list`/`done` surface, and a documented JSON store format"). Acceptance =
  a hidden end-to-end `accept` tier _plus_ a behavior checklist (the demo-role
  narration the hi-fi review surface models). **Purpose:** where compounding
  effects show up — a cheap-model config that wins per-spec may lose across a DAG
  via rework that propagates through dependents (the `stuck` insight, P3-0020).

### §1.2 How to source / author these without hand-waving

Authoring honesty is the hard part — an under-specified goal makes every
comparison noise (§6). Three sourcing paths, in increasing effort and fidelity:

1. **Distill from real shipped specs.** Take specs Tanren has already merged
   (the run/spec history) and freeze the _pre-spec_ repo state as the seed and
   the _post-merge_ behavior as the hidden `accept` tier. This is the
   highest-fidelity source because the goal is provably reachable by Tanren and
   the acceptance is provably authorable. The corpus literally grows from
   Tanren's own delivery history.
2. **Author against an executable oracle.** Write the seed + the `accept` tier
   _first_, by hand, and prove the goal reachable by completing it manually once
   (the "golden solution" — never shown to the config under test, only used to
   confirm the `accept` tier is neither vacuous nor impossible). This mirrors
   ProgramBench's reference-solution discipline (§8): a task without a passing
   reference solution is not admitted.
3. **Greenfield from the Forge interview.** Use the greenfield onboarding flow
   to derive a spec DAG, then hand-author the hidden `accept` tier. Lowest
   fidelity (the goal's reachability is unproven until the first config merges
   it) — admit a Tier-2 task to the _scored_ corpus only after ≥ 1 config cell
   has reached its `accept` tier green, so we never benchmark against an
   impossible goal.

**Admission gate for the corpus:** a task is _scored_ only if (a) its `accept`
tier is machine-checkable and runs in the seed repo's CI, (b) a reference path
has reached it green, and (c) the `accept` tier is frozen + content-addressed (a
task whose acceptance changed is a _new_ task — model-drift, §6).

## §2 — Metrics: the per-run / per-experiment scorecard

The scorecard splits into **DORA** (the headline) and **Tanren-native process
signals** (the mechanism behind the DORA deltas). Almost everything is already
persisted; the gap is **aggregation across runs within an experiment**, not
collection.

### §2.1 DORA — what Tanren measures today, and the gaps

`engine/insights/dora/compute.ts` already derives all four, REPORTED not
targeted, from existing rows (`events`, `runs`, `specs`) — no new collection:

| DORA metric         | Today (`deriveDoraMetrics`)                                       | Benchmark gap                                                                                                                             |
| ------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Lead time           | median `spec.created_at` → `merge.completed`, per merged run      | Fine as-is. For a benchmark we also want **wall-clock per run** isolated from queue wait — add a derived "active execution seconds".      |
| Deploy frequency    | `merge.completed` events / `windowDays`                           | Per-day rate is awkward for a benchmark (N trials over minutes). Reframe as **merge-success rate per trial** (merges / attempts in cell). |
| Change-failure rate | failures / finished runs (`failed`/`halted`/`cancelled` statuses) | Good. Augment with **post-merge `accept`-tier failures** — a run can merge a green PR that still fails the hidden oracle (a real CFR).    |
| MTTR                | median halt → next `merge.completed` for the same spec            | Meaningful only at Tier 2 (a halt + recovery within a DAG). Sparse at Tier 0/1; report `null` honestly (the panel already does).          |

Both gaps are small: deploy-frequency is reframed by the §4 aggregator (the
existing `deriveDoraMetrics` is reused unchanged for the operator panel); the
post-merge failure signal needs the `accept` tier run _after_ merge plus a
net-new event (`benchmark.accept.{passed,failed}`) and runner step — not a
migration to the DORA inputs.

### §2.2 Tanren-native process signals — already tracked

These are the _why_ behind a DORA delta and the real differentiators of a process
benchmark. Mapping each to where it already lives:

| Signal                       | Where it lives today                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Tokens by type (mandatory)   | `cost_records.{input,cached_input,cache_creation,output,reasoning_output,total}_tokens` — first-class, always present.      |
| Cost by source (best-effort) | `cost_records.{cost_usd,billing_mode,cost_basis}` — bases `provider_response`/`ccusage`/`credits`/`unknown`/`unattributed`. |
| Audited-concern count        | scheduled-audits library + auditor rejections; auditor `loop_to_planner` shows as `planner.rerequested` (producer=auditor). |
| Retry / re-plan count        | `planner.rerequested` events (producer `gate` vs `auditor`); `tasks.attempt`; retry-hotspot insight (`engine/insights`).    |
| Halt count + reason          | `runs.status='halted'` + `runs.outcome` (`retry_budget_exhausted`/`escape_hatch_hit`/`window_exhausted`/`quota_exceeded`).  |
| Time-to-green                | derivable from `gate.*` / `ci.passed` event timestamps relative to run start.                                               |
| Gate pass-rate               | in-loop gate events (`engine/workflow/gate/`) + `gate.failed`/`ci.passed` in the event log.                                 |
| Review iterations            | `review.*` events (P3-0008); `review_stall` insight (P3-0020).                                                              |
| Per-subtask pace             | `pace_anomaly` insight; task `started_at`/`ended_at`.                                                                       |

**The recurring theme: collection is solved; cross-run aggregation per
experiment-cell is the net-new work.** Existing insights compute _within a
project window_; a benchmark computes _within a cell_ (runs sharing a config)
then _across cells_ (the comparison).

### §2.3 The proposed per-run scorecard shape

A `TrialScorecard` (net-new, derived — see §4) per `runs` row in a cell:

```
TrialScorecard {
  runId, cellId, trialIndex
  reachedAcceptGreen: boolean        // hidden accept tier passed post-merge
  terminalStatus: runs.status        // done | halted | failed | cancelled
  haltReason: runs.outcome | null
  activeExecutionSeconds: number     // run start → terminal, queue-wait removed
  leadTimeSeconds: number            // spec.created → merge.completed (DORA)
  plannerReruns, plannerRerunsByProducer: { gate, auditor }  // planner.rerequested
  writerIterations: number           // sum tasks.attempt over write tasks
  gateFailures, reviewIterations, auditedConcerns: number
  tokens: { input, cachedInput, cacheCreation, output, reasoning, total }
  costUsd: number | null             // null is honest; aggregate handles it
  costBasisMix: { provider_response, ccusage, credits, unknown, unattributed }
}
```

Every field projects existing rows except `reachedAcceptGreen` /
`activeExecutionSeconds`, which need the post-merge `accept` step (§2.1).

## §3 — The experiment model

### §3.1 The cell

A **cell** is a frozen `(models × harnesses × tanren-config)` point plus the seed
task, holding everything constant except the one knob under test. Concretely a
cell pins:

- **Routing table** — the 6-role fallback chain (`engine/config/shared.ts`
  `RoutingTable`: plan/write/check/audit/demo/forge, each `(cli, model,
authRef)[]`). This is where "fixed models × harnesses" is expressed: the cell
  freezes the cli+model per role.
- **Escape hatches** — `maxWriterIterPerSubtask`, `maxPlannerRerunsPerSpec`,
  `maxRetriesPerTransientFailure` (`EscapeHatches`).
- **Gate strictness** — the seed repo's `fast`/`slow` `tanren-ci.yml` tiers + the
  `when` policy (`engine/ci/schema.ts`).
- **Governance posture** — `strict`/`open`/`audit_only` + merge-integration mode.
- **Seed task** — the seed repo + spec(s), pinned by commit SHA, hidden `accept`
  tier frozen and content-addressed.

A **knob** is exactly one of those dimensions varied between two (or more)
otherwise-identical cells. The three motivating questions become three knobs:

- _strictness knob_ — same routing; vary `fast` tier lint-only → lint+typecheck+
  coverage-floor.
- _cheap-model knob_ — same gate; vary `write` (and `check`/`audit`) routing from
  a premium model to the cheapest capable one.
- _checker-strictness knob_ — same routing+gate; vary the auditor routing /
  acceptance threshold; observe CFR vs lead-time.

### §3.2 Trials per cell, and the statistics

LLM flows are nondeterministic; a single run per cell is noise. So a cell is run
**N trials** (same seed + config, fresh runner each — `engine/worker` already
provisions per-run ephemeral runners). Then:

- **Report medians + a dispersion/CI, never a single run.** Use the **median and
  a bootstrap confidence interval** per metric per cell (small-N, non-normal,
  some metrics bounded like CFR ∈ [0,1]). The DORA reducer already medians
  internally; the cell aggregator medians across trials.
- **Compare cells with effect-size + a nonparametric test.** For two cells,
  report the difference of medians and a Mann–Whitney U (or bootstrap diff-CI)
  rather than a t-test, given small N and skew.
- **A starter heuristic for N: 5 trials Tier 0 (control), 7–10 Tier 1, 10+
  Tier 2** — but N is _driven by observed variance_, not fixed. The harness
  records per-metric variance and flags "CI too wide to call" rather than
  reporting a false winner (§6's regression-detection posture).

### §3.3 Keeping cells comparable

The comparability invariants (violating any one makes a comparison meaningless):

- **Same seed SHA + same hidden `accept` tier** across all cells in an experiment.
- **Same substrate** — same allocator, runner image SHA (`runners.image_sha` is
  the forensic anchor), and CI provider. A config that "wins" because it ran on a
  faster runner is not a process win.
- **Same provider account state where it bites** — subscription-window pressure
  and rate-limit state (`rate_limit_observations`) confound wall-clock and cost.
  Trials should be scheduled to avoid running cell A under a fresh window and
  cell B under an exhausted one. This is a real confounder, flagged loudly (§6).
- **One knob.** If two dimensions differ between cells, the experiment is
  malformed and the runner refuses it.

## §4 — Infra Tanren needs

Per §2, **most of this is read-side aggregation over data the system already
persists.** The split:

### §4.1 What already exists (reuse, don't rebuild)

- **The run executor** (`engine/worker/runExecutor.ts`) — a trial _is_ a
  worker-driven run; the benchmark runner enqueues a `plan` job and the existing
  dequeue→execute path runs it. No second executor.
- **Per-run cost + token accounting** (`engine/costs/`, `cost_records`) — the
  economics axis is already mandatory and attributed.
- **DORA + insights** (`engine/insights/`) — the reducers exist; they need to be
  callable over a cell's run-set, not just a project window.
- **Org / project / spec / routing model** — a cell's config is expressible in
  the existing `RoutingTable` + `EscapeHatches` + `tanren-ci.yml`, no new vocab.
- **The fixture-repo + acceptance-tier pattern** (`fixtures/`,
  `docs/operator-guide/acceptance.md`) — the seed-corpus substrate.

### §4.2 What is net-new

1. **Experiment config entity** (net-new, additive — JSONB on a new table, no
   migration to existing tables). Proposed shapes:
   - `experiments` — `{ experiment_id, org_id, title, knob, hypothesis,
seed_task_ref (repo+SHA+accept-tier-hash), created_at }`.
   - `experiment_cells` — `{ cell_id, experiment_id, label, frozen_config
(RoutingTable + EscapeHatches + ci-tier snapshot + governance), trials_target }`.
   - `experiment_trials` — `{ trial_id, cell_id, run_id (FK → runs),
trial_index, accept_result, scorecard JSONB }`. This is the join that turns
     a `runs` row into a benchmark observation; the heavy data stays in `runs` /
     `cost_records` / `events`.

   These are control-plane records that _reference_ the existing data plane; the
   benchmark adds a thin indexing layer, not a parallel run-history store.

2. **Trial orchestration** (net-new, thin). A `BenchmarkRunner` that, per cell,
   provisions the frozen config (seed repo at pinned SHA + routing/escape-hatches/
   `tanren-ci.yml`), enqueues one `plan` job per trial for the existing worker to
   run, runs the hidden `accept` tier post-merge, and writes an `experiment_trials`
   row. It is a _scheduler over the existing executor_ plus the `accept` step —
   serializing/spacing trials to respect the comparability invariants (§3.3) and
   real rate limits (`rate_limit_observations`).
3. **Cross-run aggregation** (net-new, mostly reducers). `deriveCellScorecard`
   (median + bootstrap-CI over a cell's `TrialScorecard`s) and `compareCells`
   (diff-of-medians + nonparametric test + effect size) — pure reducers in the
   spirit of `deriveDoraMetrics`, with thin DB loaders, reusing the DORA reducer
   per-cell where the metric already exists.
4. **A comparison / report surface** (net-new, additive). An experiment-report
   view (CLI table + dashboard panel) rendering cell-vs-cell scorecards with CIs,
   the knob, the hypothesis, and a "winner / no-call / regression" verdict —
   a new read view borrowing the existing DORA/cost surfaces, not new collection.
5. **A deterministic-enough harness** (discipline, not much code). Pin the seed
   SHA, runner `image_sha`, model+harness versions, and `accept`-tier hash _into
   the cell record_, and record provider/model version strings per trial so "the
   model changed under us" is detectable rather than silent (§6).

### §4.3 The seed corpus (net-new content, not code)

The corpus — seed repos, their hidden `accept` tiers, their reference paths
(§1.2) — is content, not code, and the genuine net-new authoring effort that
gates the whole capability (§5).

## §5 — A phased path

The prerequisite (real credentials + real runs) is **met** and the toolkit phases
below (B1/B2) are **built on `main`**; what remains is the seed corpus (content)
and then running the experiments (B3). Cost/time shapes that work: each Tier-1
trial is a full real agentic run (minutes, real tokens, a real PR + CI cycle), so
a 2-cell × 10-trial Tier-1 experiment is ~20 real runs and Tier-2 is far more. The
harness is designed to **spend the minimum runs that still yield a callable
result** and fail loudly when N is too small rather than over-spend or over-claim.

- **Phase B0 — prerequisite (DONE).** The live run path (P3-0009) is landed.
- **Phase B1 — smallest meaningful experiment, by hand.** One Tier-1 seed
  (distilled from a real merged spec, §1.2 path 1, frozen `accept` tier). **Two
  cells, one knob** (lint-only vs lint+typecheck `fast` tier). **N = 5–7 trials**,
  triggered through the normal dashboard/worker path. Aggregate **by hand** from
  existing `runs`/`cost_records`/`events` (one query + a spreadsheet). Deliverable:
  a learned answer to one question + a calibration of real-run noise (which sets N
  later). **No new entities yet** — prove the methodology before building infra.
- **Phase B2 — the harness skeleton (BUILT).** The entities, `TrialScorecard`
  projection, `deriveCellScorecard`/`compareCells` reducers, and `BenchmarkRunner`
  (enqueue trials + `accept` step + write rows) are merged (banner has file
  paths). What remains is exercising it against a real seed.
- **Phase B3 — the standing benchmark.** Grow the corpus across all tiers
  (admission gate, §1.2), add the report surface (§4.2.4), and run a frozen config
  snapshot as a **regression detector**: re-run on a Tanren process change and
  flag metric regressions, not absolute scores (§6). "This process change made
  CFR worse on Tier 2" is the durable signal — where it starts paying rent.

## §6 — Honest limitations

A "perfect" process benchmark is impossible. The harness is _useful anyway_ by
being honest about each limitation.

- **Nondeterminism.** Same config + seed, different outcomes. _Mitigation:_ N
  trials + medians + CIs, never single runs; report "CI too wide to call" over a
  false winner (§3.2). The benchmark answers "is cell A reliably better than cell
  B beyond run-to-run noise" — a _relative_ claim within a frozen snapshot.
- **Goal under-specification.** A vague goal makes "same end behavior" subjective.
  _Mitigation:_ the hidden, frozen, machine-checkable `accept` tier is the
  equivalence oracle (§1); a task with no passing reference path and a vacuous
  `accept` tier is not admitted to the scored corpus.
- **Model / provider drift over time.** Providers silently update models.
  _Mitigation:_ pin + record model/harness/runner versions per trial; treat a
  changed model (or `accept` tier) as a **new** cell/task. Cross-time comparisons
  are suspect; the trustworthy mode is **same-snapshot relative comparison and
  regression detection**, not a leaderboard across model generations.
- **Confounders we can't fully control.** Subscription-window pressure and
  rate-limit state (`rate_limit_observations`) bleed into wall-clock and cost;
  runner-host variance bleeds into time. _Mitigation:_ the comparability
  invariants (§3.3), loud flagging on a detected confounder, and reporting
  token-economics (deterministic-ish) alongside wall-clock (confounded).
- **Cost of running it.** _Mitigation:_ small corpus by design (§0), variance-
  driven N (stop early on a tight CI), and the Tier-0 control as a cheap
  determinism check before spending on Tier 1/2.

The net posture: **relative comparisons within a frozen config snapshot, with
confidence intervals, for regression detection** — not absolute, cross-time,
leaderboard scores. That is the most a benchmark over nondeterministic real LLM
flows can honestly deliver, and it is enough to answer the motivating questions.

## §7 — Biggest open questions (for the user)

1. **Equivalence oracle strength.** Is a frozen hidden `accept` CI tier a strong
   enough definition of "same end behavior," or do Tier-2 product goals need a
   demo-executor / behavior-checklist judge — and if so, how do we keep that judge
   _out_ of the config under test so it doesn't confound the comparison?
2. **Corpus sourcing priority.** Distill-from-history (§1.2 path 1) is highest-
   fidelity but only covers what Tanren has shipped. How much hand-authored Tier-2
   corpus is worth the authoring cost before the benchmark earns its keep?
3. **Budget envelope per experiment.** What real-dollar / wall-clock ceiling per
   experiment? This sets max trials-per-cell and thus statistical power — and
   whether Tier 2 (most informative, most expensive) is in scope initially.
4. **Confounder tolerance.** How aggressively must the harness control
   subscription-window / rate-limit state? Strict control (drain windows, space
   trials) buys cleaner comparisons at large wall-clock cost; loose control is
   cheaper but adds noise wider CIs absorb.
5. **Where it lives.** An _internal_ tuning tool (the out-of-the-box config) or a
   _customer-facing_ "tune your org's config" surface? That changes whether the
   entities are control-plane-internal or first-class product (and touches the
   RLS + control-/data-plane split, now shipped through P3c). The benchmark
   entities ship today as control-plane-internal, RLS-scoped records.
6. **Default-config feedback loop.** What governs promoting a benchmark-winning
   config to the _shipped default_ routing/gate — auto on a clean snapshot, or
   always human-gated?

## §8 — Lessons from ProgramBench

> _Grounded in a web investigation of ProgramBench (a recent Meta/FAIR release),
> not training-data recall; sources cited at the end. Unverified details are
> flagged **[unverified]** rather than asserted._

### §8.1 What ProgramBench actually is (verified)

ProgramBench (`facebookresearch/ProgramBench`, "Can Language Models Rebuild
Programs From Scratch?") is **200 whole-repo generation tasks**: the agent is
**"given a compiled binary and its documentation"** (at `./executable`) and
**"must write a new, original codebase from scratch that produces an executable
with identical behavior."** The corpus **"range[s] from compact CLI tools to
widely used software such as FFmpeg, SQLite, and the PHP interpreter,"** pinned by
`owner__repo.commit_hash` (e.g. `ffmpeg__ffmpeg.360a402`). Key mechanics:

- **Machine-checkable success without prescribing structure** — **"end-to-end
  behavioral tests … generated via agent-driven fuzzing, enabling evaluation
  without prescribing implementation structure."** The oracle checks _behavior_,
  not code shape; results read as XML into per-task pass/fail + timing JSON.
- **Hermetic, no-internet sandbox + decoupled run vs. eval harness** — tasks run
  in Docker `task_cleanroom` images and **"the agent MUST NOT have access to
  internet during inference."** The agent harness (e.g. `mini-swe-agent`) emits a
  `submission.tar.gz` + trajectory per instance; a _separate_ scorer
  (`uv run programbench eval <run-dir>`) runs the hidden tests against the rebuilt
  program — producing the artifact and scoring it are different programs.
- **Explicit nondeterminism handling in scoring** — **"some branches and
  individual tests are ignored because they are non-deterministic or have other
  flaws"** via a reference `tests.json`; use **"logic from `programbench info` to
  get final scores."** The benchmark curates out flaky tests rather than pretends
  away nondeterminism.
- **Partial-credit scoring; one attempt; tasks are hard** — headline: **"the best
  model passing 95% of tests on only 3% of tasks,"** **"none fully resolve any
  task"** — so the metric is a _fraction of behavioral tests passed per task_, not
  a binary. The `mini-swe-agent` baseline runs **one attempt per instance**
  (budgets 21,600 s / 1,000 steps). **[unverified]** whether the _paper_ reports
  pass@k — the baseline docs describe single-attempt.

### §8.2 Patterns we adopt

| ProgramBench pattern                                                          | How it maps onto our process benchmark                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Behavioral oracle, not structural** ("tests without prescribing structure") | This _is_ our §1 hidden `accept` tier. Two configs producing different code but the same behavior are comparable — exactly what a process benchmark needs (config varies; the equivalence oracle is fixed). Commit-pinned tasks → our SHA-pinned cell (§3.1). |
| **Decoupled run-harness vs. eval-scorer + hermetic containers**               | Our `BenchmarkRunner` (trials via the run worker) is separate from `deriveCellScorecard`/the `accept` step (scoring) — mirrors `agent` vs. `programbench eval`. Hermetic execution is native: ephemeral per-run runners over SSH (`engine/worker`).           |
| **Partial-credit, fraction-of-tests scoring**                                 | Adopt for Tier 2: a multi-spec DAG goal is rarely 100% met every trial, so report _fraction of `accept` checks passed_ per trial (not just binary merged-green) for a smoother signal.                                                                        |
| **Curate out known-flaky tests** (`tests.json` / `programbench info`)         | Adopt directly: the `accept` tier is vetted for flakiness before joining the scored corpus (§1.2 gate). A flaky oracle manufactures fake CFR deltas. **The single most transferable lesson.** Pinned reference → our §1.2 path-2 reachability requirement.    |

### §8.3 Where we deliberately diverge

The divergences are the point: ProgramBench benchmarks _a model/agent on a task_;
we benchmark _a Tanren process configuration_.

1. **Unit under test.** ProgramBench varies the **solver** to rank solvers. We
   **hold the solver fixed** (routing pins models+harnesses per role) and vary
   **one Tanren config knob** (gate strictness / model-cost / checker strictness).
   Their X-axis is "which model"; ours is "which process config."
2. **Task shape.** ProgramBench is _rebuild-from-binary, from-scratch, single
   huge goal_. Ours is _normal feature work on a seed repo_ (small features and
   multi-spec product goals) — the work Tanren's loop actually does. We test
   delivery, not reverse-engineering.
3. **Multi-trial statistics are mandatory for us, not optional.** ProgramBench's
   baseline is **one attempt per instance** ranking deterministically-scored
   solvers. Our entire signal is _process reliability under nondeterminism_, so a
   single run per cell is meaningless — we require **N trials + medians + CIs +
   nonparametric comparison** (§3.2). Where ProgramBench _removes_ flaky tests to
   stabilize scoring, we additionally _measure_ run-to-run variance as first-class
   (it is part of what a process config buys you).
4. **The scorecard is multi-axis, not a single test-pass fraction.** Their
   headline is one number; ours is a **vector** — DORA + token-economics +
   retries + audited-concerns + gate-pass-rate (§2). "Same behavior" (their whole
   metric) is for us only the _equivalence gate_ that makes the _other_ axes
   comparable: correctness is the entry ticket, not the score.
5. **Scale and intent.** 200 large from-scratch builds vs. a small, tiered
   corpus (§1.1) run as a **regression detector on a frozen config snapshot**
   (§5 B3), not a public solver leaderboard.

### §8.4 Open ProgramBench questions we could not close

**[unverified]**: whether the _paper_ reports multi-sample / pass@k stats
(baseline docs describe single-attempt); the **task-selection methodology** for
the 200 programs (range confirmed — CLI tools → FFmpeg/SQLite/PHP — criteria not);
the exact **cross-task aggregation formula** (per-test fraction confirmed,
averaging across tasks not nailed down in our sources).

### §8.5 Sources

- ProgramBench repo — <https://github.com/facebookresearch/ProgramBench> (README + usage/eval docs)
- Paper ("Can Language Models Rebuild Programs From Scratch?") — <https://arxiv.org/abs/2605.03546>
- mini-swe-agent ProgramBench baseline — <https://mini-swe-agent.com/latest/usage/programbench/>
