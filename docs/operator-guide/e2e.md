# `just e2e` — the real-resource, real-credential e2e gate (operator runbook)

`just e2e` is Tanren's standing proof that the **assembled system does real work
end-to-end against real resources** (autonomy-engine §8b). It runs the **real
stack** with **real provider + GitHub credentials**, drives the **real operator
flow over the real external surfaces only** (the HTTP API + the dashboard), and
asserts on **real persisted artifacts** — a merged PR on GitHub, the implemented
file on the base branch, `cost_records` rows with a real basis, the DORA
projection. It **cannot pass on a stubbed shell**: the cases drive only the
external surfaces, and the `e2e-no-mock-imports` architecture check fails any
`tests/e2e/**` file that imports a fixture/mock or a non-public internal seam.

It is **not on the per-PR fast path**. It spends **real credits and real
wall-clock** and needs credentials the public PR CI does not have — exactly the
`just acceptance` discipline (no secrets in public CI). It runs **locally / in a
credentialed nightly / pre-release**, and its result (the run IDs and PR URLs) is
the **release evidence**.

## What runs where

- **`just fast-check` / `just ci`** run the e2e **harness unit tests**
  (`tests/e2e/lib/**/*.test.ts` — pure, no creds) and the **`e2e-no-mock-imports`**
  architecture check. They do **not** run the credentialed cases.
- **`just smoke`** additionally runs **`smoke-e2e-artifacts`** — the gate's
  artifact-read teeth (`readRunArtifacts`) against a **real seeded Postgres**
  (gated behind `TANREN_RLS_DB_TEST=1`, like the RLS integration smokes). It
  proves the SQL the credentialed run reads its evidence through actually returns
  a seeded merged run (outcome + `pr_url` + a `cost_records` row + the DORA
  count), not just that the verdict logic is correct over hand-built evidence.
- **`just e2e`** runs the credentialed **cases** (`tests/e2e/cases/**/*.e2e.ts`)
  against a live stack, via `vitest.e2e.config.ts`.

The credentialed cases are named `*.e2e.ts` (not `*.test.ts`/`*.spec.ts`) so the
default vitest discovery never picks them up; only `just e2e` opts them in. They
are declared `active` in the manifest but **skip cleanly** (`it.skipIf`) unless a
live stack + real credentials are present (`TANREN_E2E_API_TOKEN` + a
`tanren.acceptance.json` / `TANREN_ACCEPTANCE_CONFIG` config) — so a no-creds run
of `just e2e` never throws and never reports a false green; it just skips.

## The cases (a manifest + harness)

`tests/e2e/lib/manifest.ts` is the typed source of truth for what the gate proves.
It ships the three **tier proofs** (easy / medium / hard → a merged PR) as the
active cases, and declares **per-capability placeholders** that grow as the
autonomy engine lands: real-LLM ideation → a real DAG; the walker driving a
multi-spec DAG to merged PRs with no per-spec trigger; a real conflict resolved
intent-preserved; a real issue ingest → triage → merged spec; and `apex`. Each
case declares the **real persisted artifacts** it asserts on; the harness
(`tests/e2e/lib/harness.ts`) reads those artifacts (Postgres rows via the
`@tanren/db` public entry, the GitHub PR/contents API) and fails the case if any
declared artifact is missing or fake.

## Prerequisites

1. The real stack is up: `just up-dev`.
2. Operator credentials in `tanren.acceptance.json` (the same file the acceptance
   gate uses — see [acceptance.md](./acceptance.md)): `codex_auth_file`,
   `github_token_file`, `github_repo_url` (+ optional `github_base_branch`).
3. `TANREN_E2E_API_TOKEN` exported — a real `api_token` for the e2e operator. The
   suite drives the HTTP API as a real operator (Bearer auth); there is no
   internal-seam bypass.

Optional overrides: `TANREN_E2E_API_URL` (default `http://127.0.0.1:3100`),
`TANREN_E2E_DASHBOARD_URL` (default `http://127.0.0.1:3000`), `TANREN_DATABASE_URL`
(default the dev-compose Postgres, used only to read the real persisted rows).

## Running it

```sh
just up-dev
export TANREN_E2E_API_TOKEN="$(…issue an api_token…)"
just e2e
```

Capture the printed run IDs + PR URLs as the release evidence.
