# The native gate definition (`.tanren/ci.yml`)

`.tanren/ci.yml` is the single source of truth for the shell checks Tanren runs
against a target repo. It lives **in the target repo** (committed at
`.tanren/ci.yml`), not in the Tanren monorepo.

It is the **native gate definition** — it declares the tiered checks Tanren runs
**itself**, over SSH, on the runner workspace during a run. **There is no GitHub
Actions.** Tanren is the merge authority: it runs these steps and reads the
verdict from exit codes — it does not inject an Actions workflow and does not poll
a forge check-run. This file is a `CiConfigV1` (a tiered step definition), **not**
an Actions workflow.

The parser/validator lives at `services/orchestrator/src/engine/ci/`; the runner
that executes the steps over SSH lives at
`services/orchestrator/src/engine/workflow/gate/`. A copy-pasteable example is at
`fixtures/tanren-ci.sample.yml`.

## Why tiers

Checks are grouped into named **tiers** by cost. A cheap tier (`fast`) runs on
every writer iteration; an expensive tier (`slow`) runs only at the points where
the extra cost is worth it (before an audit, before a merge). The `when` policy
maps each tier to those lifecycle points declaratively, so adding a check never
requires touching orchestrator code — only the repo's `.tanren/ci.yml`. The
`pre_merge` tier is the **merge authority**: a passing `pre_merge` gate is what
admits the merge.

## Schema

Tanren names **no tech stack**. Every step defers to a `just <target>` recipe, so
the actual commands (pnpm / cargo / make / a fan-translation linter — anything)
live in the project's `justfile` (the project contract), not in Tanren. The schema
below is the **stack-agnostic 3-tier shape** the built-in default ships, mapping
each tier 1:1 to a spec-loop lifecycle point:

```yaml
version: 1 # required; literal 1

bootstrap: # optional — provision the workspace before the gate runs
  run: "just bootstrap"

tiers: # required; `fast` and `slow` are mandatory, plus a tier mapped to pre_merge
  fast: # cheap per-iteration gate (e.g. lint + typecheck). NO tests here —
    - name: tier-1 #   tests arrive with features, so a scaffold pass is never
      run: "just tier-1" #   blocked by a test tier.
  slow: # build + tests; DECLARES its JUnit report for per-test CI-intelligence
    - name: tier-2
      run: "just tier-2"
      junitReport: "reports/junit.xml" # explicit declared path (see below)
  merge: # the heaviest thorough gate — the merge-queue authority
    - name: tier-3
      run: "just tier-3"
  # extra named tiers are allowed, e.g.:
  # integration:
  #   - name: e2e
  #     run: "just integration"

when: # required; every declared tier MUST appear here, and at least one tier
  fast: #   MUST map to pre_merge (fail-closed — see Validation rules)
    - per_iteration # valid points: per_iteration | pre_audit | pre_merge
  slow:
    - pre_audit
  merge:
    - pre_merge
```

### Fields

| Field              | Required | Description                                                                                                                                                                                                                                    |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`          | yes      | Schema version. Must be the literal `1`.                                                                                                                                                                                                       |
| `bootstrap.run`    | no       | Provision command Tanren runs over SSH before the gate (default `just bootstrap`).                                                                                                                                                             |
| `tiers`            | yes      | Map of tier name to a non-empty list of `{ name, run, junitReport? }` steps. `fast` and `slow` are required.                                                                                                                                   |
| `step.run`         | yes      | Shell command Tanren runs verbatim over SSH (conventionally `just <target>`).                                                                                                                                                                  |
| `step.junitReport` | no       | Declared path the step writes a JUnit report to (e.g. `reports/junit.xml`). Tanren reads exactly this path back over SSH for per-test CI-intelligence (flaky-detection + quarantine). A step with no `junitReport` produces no per-test grain. |
| `when`             | yes      | Map of tier name to a non-empty list of lifecycle points. Every declared tier must have an entry, and at least one tier must map to `pre_merge`.                                                                                               |

### Lifecycle points

- `per_iteration` — after each writer iteration (cheap feedback).
- `pre_audit` — before handing the work to an auditor.
- `pre_merge` — before merging the PR. **This is the merge authority.**

## Per-test grain (declared via `junitReport`)

A step opts into per-test CI-intelligence by **declaring** a `junitReport` path —
the explicit config field, not a sniff. When a step sets
`junitReport: "reports/junit.xml"` and its `just <target>` recipe writes a JUnit
report to exactly that path, Tanren reads it back over SSH after the gate and
ingests the per-test rows **in-process** — feeding flaky-detection +
auto-quarantine. The path is the contract: Tanren reads back precisely the declared
path (the convention is `reports/junit.xml`), and the **command** that writes it is
the project's, inside the `just` recipe — Tanren names no test runner. There is no
upload step, no webhook, no signing secret. A step that declares no `junitReport`
simply has no per-test grain (a clean no-op).

## Validation rules (fails loudly)

Invalid config is **never silently skipped** — a misconfigured repo fails the
gate. The validator rejects:

- a `version` other than `1`, or unknown top-level keys (the schema is strict);
- a missing `fast` or `slow` tier, or any tier with an empty step list;
- a `when` value outside `per_iteration | pre_audit | pre_merge`;
- a `when` entry that references a tier not declared under `tiers`;
- a declared tier that has no `when` entry (it would otherwise never run);
- **a config where no tier maps to `pre_merge`** — the `pre_merge` gate is the
  merge authority, and an uncovered `pre_merge` would make `tanren/gate: success` a
  vacuous pass that lands anything. This is rejected **fail-closed** (a
  writer-editable `.tanren/ci.yml` cannot silently drop merge coverage).

YAML syntax errors raise `CiYamlParseError`; schema violations raise
`CiConfigValidationError`. (The parser supports the constrained subset this
schema needs — nested mappings, sequences of mapped/scalar items, and scalar
values — not arbitrary YAML.)

## Default when the file is absent

If a repo ships no `.tanren/ci.yml`, `resolveCiConfig(undefined)` returns the
built-in **stack-agnostic 3-tier `just`-based default** (`DEFAULT_CI_CONFIG` in
`engine/ci/resolve.ts`), which mirrors the scaffold skeleton's `ci.yml`:

| Tier    | Step (`run`)  | `junitReport`       | Runs at         |
| ------- | ------------- | ------------------- | --------------- |
| `fast`  | `just tier-1` | —                   | `per_iteration` |
| `slow`  | `just tier-2` | `reports/junit.xml` | `pre_audit`     |
| `merge` | `just tier-3` | —                   | `pre_merge`     |

The default `bootstrap.run` is `just bootstrap`. Because every command is a `just`
target, the default works for **any** stack: the project's `justfile` decides what
`tier-1`/`tier-2`/`tier-3`/`bootstrap` actually run.

## Consumer API

The orchestrator exposes a small surface from
`services/orchestrator/src/engine/ci`:

- `resolveCiConfig(yamlText | undefined)` — parse + validate, or return the
  default; throws on invalid input.
- `tiersFor(config, when)` — the tier names that run at a lifecycle point
  (ordered `fast`, `slow`, then extra tiers alphabetically).
- `stepsFor(config, when)` — the flattened steps for a lifecycle point, in tier
  then step order.
- `bootstrapCommand(config)` — the bootstrap command, or `undefined`.
