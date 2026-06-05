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

```yaml
version: 1 # required; literal 1

bootstrap: # optional
  run: "pnpm install --frozen-lockfile"

tiers: # required; `fast` and `slow` are mandatory
  fast: # a tier is a non-empty list of named steps
    - name: lint # step name (free text, non-empty)
      run: "pnpm lint" # shell command Tanren runs verbatim over SSH
    - name: typecheck
      run: "pnpm typecheck"
  slow:
    - name: build
      run: "pnpm build"
  # extra named tiers are allowed, e.g.:
  # integration:
  #   - name: e2e
  #     run: "pnpm test:e2e"

when: # required; every declared tier MUST appear here
  fast:
    - per_iteration # valid points: per_iteration | pre_audit | pre_merge
  slow:
    - pre_audit
    - pre_merge
```

### Fields

| Field           | Required | Description                                                                                       |
| --------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `version`       | yes      | Schema version. Must be the literal `1`.                                                          |
| `bootstrap.run` | no       | Install/provision command Tanren runs over SSH before the gate.                                   |
| `tiers`         | yes      | Map of tier name to a non-empty list of `{ name, run }` steps. `fast` and `slow` are required.    |
| `when`          | yes      | Map of tier name to a non-empty list of lifecycle points. Every declared tier must have an entry. |

### Lifecycle points

- `per_iteration` — after each writer iteration (cheap feedback).
- `pre_audit` — before handing the work to an auditor.
- `pre_merge` — before merging the PR. **This is the merge authority.**

## Per-test grain (optional)

When a `test` step emits a JUnit report to `reports/junit.xml` (e.g.
`vitest --reporter=junit --outputFile=reports/junit.xml`), Tanren reads it back
over SSH after the gate and ingests the per-test rows **in-process** — feeding
flaky-detection + auto-quarantine. There is no upload step, no webhook, no signing
secret: the gate produced the report on the runner, and Tanren ingests it
directly. A repo that emits no JUnit simply has no per-test grain (a clean no-op).

## Validation rules (fails loudly)

Invalid config is **never silently skipped** — a misconfigured repo fails the
gate. The validator rejects:

- a `version` other than `1`, or unknown top-level keys (the schema is strict);
- a missing `fast` or `slow` tier, or any tier with an empty step list;
- a `when` value outside `per_iteration | pre_audit | pre_merge`;
- a `when` entry that references a tier not declared under `tiers`;
- a declared tier that has no `when` entry (it would otherwise never run).

YAML syntax errors raise `CiYamlParseError`; schema violations raise
`CiConfigValidationError`. (The parser supports the constrained subset this
schema needs — nested mappings, sequences of mapped/scalar items, and scalar
values — not arbitrary YAML.)

## Default when the file is absent

If a repo ships no `.tanren/ci.yml`, `resolveCiConfig(undefined)` returns a
built-in default that mirrors this monorepo's own conventions:

| Tier   | Steps                       | Runs at                  |
| ------ | --------------------------- | ------------------------ |
| `fast` | `lint`, `typecheck`, `unit` | `per_iteration`          |
| `slow` | `build`, `test`             | `pre_audit`, `pre_merge` |

The default `bootstrap.run` is `pnpm install --frozen-lockfile`.

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
