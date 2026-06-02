# `just e2e` — the real-resource, real-credential e2e gate (autonomy-engine §8b)

This suite is the standing, machine-checkable answer to **"is Tanren real, or a
stubbed shell?"** It runs the **real stack** (`just up-dev`) with **real provider
and GitHub credentials** and drives the **real operator flow over the real
external surfaces only** — the HTTP API and the dashboard. It **cannot pass unless
Tanren actually works against real resources**: every case asserts on a **real
persisted artifact** (a merged PR on GitHub, the implemented file on the base
branch, `cost_records` rows with a real basis, the DORA projection) — never on a
mocked return.

## It is NOT on the per-PR fast path — on purpose

`just e2e` spends **real credits and real wall-clock**, and needs **real
credentials** that the public PR CI does not have (per the existing `just
acceptance` discipline — no secrets in public CI). So:

- `just fast-check` / `just ci` run the **harness unit tests** (`lib/**/*.test.ts`)
  and the **no-mock architecture check** (`e2e-no-mock-imports`, below). They do
  **not** run the credentialed cases.
- `just e2e` runs the credentialed cases (`cases/**/*.e2e.ts`) against a live
  stack. It runs **locally / in a credentialed nightly**, and its result (the run
  IDs and PR URLs) is the **release evidence**.

The credentialed cases are named `*.e2e.ts` (not `*.test.ts`/`*.spec.ts`) so
vitest's default discovery never picks them up; only `just e2e` runs them
explicitly. The harness/manifest unit tests are `lib/**/*.test.ts` and **do** run
under `just fast-check`.

## The no-mock discipline is mechanically enforced

`e2e-no-mock-imports` (in `scripts/check-architecture.mjs`, wired through `just
architecture`) **fails** any file under `tests/e2e/**` that imports:

- a **test fixture / mock / stub / deterministic stand-in** — any specifier under
  `tests/fixtures/**` / `**/fixtures/**`, or one whose name matches the stub
  taxonomy (`*Stub`, `Mock*`, `Fake*`, `Noop*`, `createDeterministic*`,
  `templated*`); or
- a **non-public internal seam** — a deep import into another package's internals
  (`@tanren/*/src/**`) or a path that reaches into `services/*/src/**`.

The e2e suite talks to Tanren **only** through the real external surfaces (HTTP
`fetch` against the orchestrator API + the dashboard) and reads **real persisted
artifacts** straight from Postgres (raw `pg` + SQL) and GitHub (the real REST
API). There is no internal seam, no mock, no fixture — that is the whole point.

## The cases (a manifest + harness skeleton)

`lib/manifest.ts` encodes the e2e CASES as a typed manifest. It ships the three
**tier proofs** (easy / medium / hard → a merged PR) and **placeholders** that
grow per capability as the autonomy engine lands (real-LLM ideation → a real DAG;
the walker drives a multi-spec DAG to merged PRs with no per-spec trigger; a real
conflict resolved intent-preserved; a real issue ingest → triage → merged spec;
`apex`). `lib/harness.ts` is the skeleton that drives the real operator flow and
asserts on the persisted artifacts each case declares.

## Running it

```sh
just up-dev                              # the real stack
# credentials live in tanren.acceptance.json (see docs/operator-guide/acceptance.md)
just e2e                                 # runs cases/**/*.e2e.ts against the live stack
```

See `docs/operator-guide/e2e.md` for the operator runbook.
