# Portability & Longevity (north star)

Two long-horizon intents shape how we architect today (neither is imminent):

1. **Ground-up Rust rewrite** — eventually reimplement the system in strict, performant Rust as the ultimate type-safety story.
2. **Native agentic harness** — a Rust harness (opencode-alternative) with tight tanren integration.

Neither should be built soon. But we want today's code to make them _easy and incremental_ later. The governing principle:

> **Make the contracts the durable asset and the implementation disposable.**

A Rust rewrite and a native harness both reduce to "slot a new implementation behind a stable boundary" — _if_ the boundaries and the tests that pin them are language-agnostic.

## Design rules we follow now

### 1. Behavior/contract tests over implementation tests (→ portable tests)

- Assert through **public contracts**: HTTP (`app.request`), the SSH substrate result, the persisted **event stream**, **DB state**, and Answerer/harness **JSON outputs** — not private functions or mock call-counts.
- Prefer **recorded golden fixtures** (request/response pairs, golden event sequences, run-state snapshots) over white-box assertions. These fixtures are the executable spec a Rust port must satisfy unchanged.
- A test that breaks on a behavior-preserving refactor is testing the wrong layer. (This also makes the test suite refactor-safe today.)

### 2. Conformance suites per seam (→ slottable implementations)

- Every adapter seam (`Allocator`, `SecretStore`, `JobQueue`, `EventStore`, `SourceConnector`, `IdentityProvider`, `WriterAdapter`/`AnswererAdapter`, `CostResolver`, `GitHubHttpClient`/VCS) gets a **shared conformance test** that _any_ implementation must pass — the in-memory fake, the real one, and a future Rust one.
- New implementations are accepted by running the seam's conformance suite, not by bespoke per-impl tests. This is the strangler-fig enabler: replace one service in Rust, prove it green against the same conformance + contract tests, ship.

### 3. Language-neutral schema source of truth

- Keep schemas exportable to a neutral form. Drizzle SQL migrations are already neutral; answerer schemas already emit JSON. Extend to a **unified JSON-Schema export** of all contracts (DB rows, event payloads, HTTP request/response, answerer + harness I/O).
- A Rust port generates `serde` types from that export rather than hand-porting shapes. Zod stays the authoring tool; JSON Schema is the portable artifact.

#### Unified JSON-Schema export (shipped)

The export lives at [`contracts/json/**`](../../contracts/json) and is regenerated from the Zod sources by [`scripts/contract-schema-export.mjs`](../../scripts/contract-schema-export.mjs) (`corepack pnpm run codegen:contract-schemas`). The single catalog that enumerates every exported contract is [`services/orchestrator/src/engine/schemaExport/catalog.ts`](../../services/orchestrator/src/engine/schemaExport/catalog.ts); adding a contract is one entry there. A `--check` mode plus the `check:contract-schema-drift` gate (wired into `just fast-check` and `just ci`, pinned by the `contract-schema-drift-check-wired` architecture rule and a vitest drift test) keeps the JSON from silently drifting from the Zod source — the same mechanism the answerer-schema export uses.

Contract families exported today:

| Family       | Source of truth                                                   | Files                         |
| ------------ | ----------------------------------------------------------------- | ----------------------------- |
| `events/`    | `EventRegistry` (`engine/events/registry.ts` + `schemas/**`)      | one per registered event name |
| `state/`     | `stateEnumCatalog` (`engine/state/*` Zod enums)                   | one per state enum            |
| `answerers/` | `answererSchemaCatalog` (plan/check/audit/demo/forge)             | one per role                  |
| `http/`      | run-detail read API contract (`routes/runs/contract.ts`)          | request/response + SSE frames |
| `insights/`  | `InsightPayload` discriminated union (`engine/insights/types.ts`) | one                           |

The renderer reuses **Zod 4's native `z.toJSONSchema`** (no separate `zod-to-json-schema` dependency — same renderer the answerer export uses), targeting draft-2020-12.

#### How JSON Schema maps to Rust `serde`

The intended Rust path is `contracts/json/**` → [`typify`](https://github.com/oxidecomputer/typify) (or `schemafy`) → `serde`-derived Rust types. The mapping is mechanical:

| JSON Schema                                           | Rust `serde` type                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `{ "type": "object", "additionalProperties": false }` | `#[derive(Serialize, Deserialize)]` `struct` (deny unknown fields) |
| required vs. optional property                        | `T` vs. `Option<T>`                                                |
| `{ "type": "string", "enum": [...] }`                 | a fieldless `enum` (one variant per value)                         |
| `oneOf`/discriminated union on a literal field        | `#[serde(tag = "kind")]` tagged `enum` (e.g. `InsightPayload`)     |
| `{ "type": "string", "format": "date-time" }`         | `chrono::DateTime<Utc>` (see the date note below)                  |
| `{ "type": "integer" }`                               | `i64` / `u64` (`minimum: 0` ⇒ unsigned)                            |
| `{ "type": "array", "items": ... }`                   | `Vec<T>`                                                           |
| `anyOf: [T, { "type": "null" }]`                      | `Option<T>`                                                        |

The `x-tanren-schema-id` annotation on each file is the stable contract identifier the Rust side keys generated modules to.

**Date representation.** `z.coerce.date()` / `z.date()` have no native JSON Schema form, so the renderer emits them as `{ "type": "string", "format": "date-time" }` — exactly how they cross the wire as JSON — which `typify` maps to `chrono::DateTime`. This is the one deliberate coercion; everything else renders structurally.

#### Known gaps (intentional, not blocking)

- **Harness protocol I/O** (`engine/providers/types.ts`: `WriterResult`, `TokenUsage`, `AnswererRunOptions`) are TypeScript `interface`s, not Zod, so they cannot be auto-rendered. The protocol shapes are documented in prose + TS code blocks in [`harness-protocol.md`](./harness-protocol.md); the structured-output payloads a harness actually emits (the answerer roles) **are** exported under `answerers/`. Promoting the writer-result/token-usage shapes to Zod is the follow-up that closes this gap.
- **DB row shapes** are Drizzle table definitions, already neutral via SQL migrations (the existing schema-drift gate), so they are not re-exported as JSON Schema here.
- **`z.unknown()` fields** (e.g. redacted event `payload`, `RunForgeBundle.recentTurns`, `InsightAction.toolCall`) render as the permissive `{}` schema — by design, since those fields are intentionally loosely typed at the contract boundary.

### 4. Formalize the harness↔orchestrator protocol

- Define the harness protocol as a **versioned, documented contract** (stdin/stdout JSON: a task descriptor in → diff / events / token-usage / structured-output out), distinct from any single CLI's quirks.
- Each harness adapter (codex/claude/opencode and the incoming agy/aider/pi/reasonix) maps its CLI to this one protocol; harnesses without structured output declare a writer-only capability.
- The future Rust harness implements this protocol natively — it's "just another conformant harness," getting the tight integration for free.

### 5. Curate test strength with mutation testing

- "How strong are the tests" should be a number. **Stryker** mutation testing on the workflow-critical + seam modules, with a mutation-score gate, makes test quality measurable and prevents shallow tests from passing as coverage.

**Status: wired up (Track C §5).** Stryker (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`) is configured in `stryker.config.mjs` and runs via `just mutation` (`pnpm check:mutation` -> `stryker run`).

- **Scope (the highest-value modules only):** the workflow `planner` / `checker` / `auditor`, `engine/credentials/**` (credential resolution + materialization), the `Allocator` / `JobQueue` / `SecretStore` seam contracts (now conformance-covered), and the concrete allocators behind the Allocator seam. Nothing else is mutated.
- **Deliberately NOT in the per-PR gate.** Mutation testing is slow (~7-8 min for this scope), so it is excluded from `just ci` / `just fast-check`. Run it on demand or nightly: `just mutation`.
- **Measured baseline (first run):** **39.89%** full-scope mutation score (926 killed + 64 timed-out of ~2,483 mutants). `thresholds.break` is pinned just below that, at **38**, so `just mutation` passes today and any regression below the floor fails — a non-breaking ratchet. Raising the floor by killing surviving mutants is follow-up work; the value delivered here is the number plus the regression gate, not fixing every weak test now.
- **Where the tests look weakest** (lowest mutation scores / most surviving mutants — prioritize these when ratcheting up):
  - `engine/credentials/**` is the weakest cluster (~33% scope score). `codexAuth.ts` (33%, 55 survivors), the `opencode` / `claude` auth + materializer files (~35%), and several credential files with no mutated coverage at all (`githubToken.ts`, `orgGithubApp.ts`, `resolveCredentials.ts`).
  - The `Allocator` seam contract (`contracts/allocator.ts`, 37.5%) and several allocators the per-PR suite never exercises under Stryker (`allocatorRouter.ts`, `buildAllocator.ts`, `poolPolicy.ts`, `staticRunnerAllocator.ts`, `runnerStore.ts`, `scaffoldedAllocators.ts` — all 0%).
  - Strongest today: `manualSshAllocator.ts` (88%), `secretStore.ts` (75%), `githubTokenResolver.ts` (74%).
  - The workflow `planner` / `checker` / `auditor` report 0% in the full-scope run as a Stryker scoping artifact (per-test coverage attribution fails for these ESM `.js`-import + `@tanren/db`-alias modules). Measured in isolation they score ~56% (planner 66 / checker 60 / auditor 39), so the true scope strength is above the 39.89% headline.
- **How to run:** `just mutation`. The HTML report lands at `reports/mutation/index.html` and the machine-readable score at `reports/mutation/mutation.json` (both gitignored under `reports/`).

## The OSS↔hosting billing seam (budget gate + metering-export)

tanren is open-source and self-hostable; a separate, **closed hosting layer** runs it as a SaaS. The boundary between them for billing is two narrow surfaces that live **in this repo** — the OSS _enforces_ a budget ceiling and _exports_ usage; it never decides pricing, plans, or charges. **Billing/pricing policy lives entirely outside the repo.** A self-hosted deployment that sets no budget is unrestricted: default behavior is unchanged.

### 1. Budget — the single spend gate (`engine/dag/budgetGate.ts`)

There is **one** admission gate: a single total-dollar ceiling, configured as a project/org config knob and enforced by the DAG walker. There is no pluggable `QuotaPolicy` and no per-dimension quota table — the `engine/quota/` admission seam and the `org_quotas`/`DbQuotaPolicy` reference policy were deleted; budget is the only gate.

- **Walker-enforced.** Before the DagWalker schedules more work it checks the org/project's running real spend (from `cost_records`) against the configured `ceilingUsd`. Over the ceiling, it pauses the DAG and emits `dag.budget.paused` rather than spawning further runs.
- **Config knob, not env.** The ceiling is read/written through the budget routes (`GET`/`PUT` at `/projects/:id/budget` and `/orgs/:orgId/budget`); it is a first-class config value, not an environment variable. A deployment that sets no ceiling is unrestricted.
- **Ground truth.** Spend is the run's real metered usage from `cost_records`, not an estimate. See [`budget-model.md`](../roadmap/budget-model.md) for the budget design-of-record and the forward cost-dimension design.

### 2. Metering-export — the read seam a hosting layer bills off (`engine/metering/index.ts`)

Typed reads derived straight from `cost_records` grouped by `org_id` (the rich, token-typed, multi-basis cost ledger). **Not billing logic** — just a clean read the hosting layer ingests:

- `getOrgUsage(orgId, window?)` → aggregate rollup (`runs`, `tokens`, `costUsd`) over an optional time window.
- `streamBillableRuns(orgId, window?)` → per-run billable events (one row per run with summed token + dollar totals).

`costUsd` is best-effort (unpriced rows contribute 0 dollars but still count tokens), mirroring the ledger's honest-NULL cost model. The hosting layer maps these figures to its own pricing/credits.

### 3. Managed-provider seam — BYOK vs. a platform-provided LLM (`engine/config` + `engine/credentials` + `engine/providers`)

A self-hosted tenant brings its own LLM key (**BYOK**: it imports its own Codex/Claude/OpenRouter credential, today's default). A hosting layer may instead want to offer a **platform-provided LLM** — an OpenRouter-style shell where tenants run against the platform's single OpenRouter key and the platform meters + bills the usage. That is **managed** mode. As with the quota + metering seams above, the OSS exposes only the **toggle + plumbing**; **who** gets managed and the **platform key + pricing** are HOSTING concerns outside this repo. A deployment that sets nothing stays BYOK — default behavior is unchanged.

The seam is a credential-**source** + endpoint toggle, NOT a new harness adapter:

- **`providerMode: "byok" | "managed"`** (`engine/config/managedProvider.ts`), part of org config (default `"byok"`) and project-overridable, carried in the `config` JSONB.
- **Credential resolution** (`engine/credentials/resolveCredentials.ts`): under `managed`, the run resolves a **platform-owned** ref (`credential/openrouter/platform/default` by default — the secret-store key the hosting layer writes the platform OpenRouter API key under) instead of the tenant's imported LLM credential. The GitHub credential is always the tenant's; managed mode only swaps the LLM source. An explicit credential pin forces BYOK. The OSS only **selects** the platform ref — it never sees the key.
- **Harness endpoint override** (`engine/providers/{aider,opencode,claude,codex}.ts`): each OpenAI-API-compatible adapter takes an optional base-URL override. A managed run points the harness at the OpenRouter endpoint (`https://openrouter.ai/api/v1`) — aider via `--openai-api-base` + `OPENAI_API_KEY`, codex/opencode via `OPENAI_BASE_URL`, claude via `ANTHROPIC_BASE_URL`. BYOK passes no override, so the existing native-endpoint behavior is byte-identical. The endpoint is resolved from config and injectable for tests.
- **Metering stays tenant-scoped.** A managed run's `authRef` is the `credential/openrouter/platform/...` ref, which the cost path (`engine/costs/sources.ts`) already classifies as `per_token` / `openrouter` (real spend captured as `provider_response` from OpenRouter's `usage.cost`, else NULL/`unknown`), and `cost_records.org_id` is derived in-statement from the run. So managed usage is priced and **metered to the tenant's org** through the very same metering-export read the hosting layer bills off — no separate path.

The hosting layer therefore wires: the platform OpenRouter key into the secret store, the `providerMode: "managed"` policy onto the orgs it chooses, and its `QuotaPolicy` + billing on top of the (already tenant-tagged) `cost_records`.

## What already supports this (don't regress it)

Multi-service boundaries (orchestrator/allocator/dashboard/db over HTTP+SQL+SSH+events); Zod-sourced contracts with drift checks; the `app.request` HTTP test pattern; injectable/mockable seams everywhere; answerer-schema JSON export. The deltas to pursue are §1–§5 above, incrementally — not a big-bang.

## Sequencing (folded into the expansion/strictness plan)

- **Now (cheap, high-leverage):** adopt §1 as the default test style in all new work; write §4 (harness-protocol contract doc) before/with the new harness adapters.
- **Track C — longevity (interleaved with Track B):** seam **conformance suites** (§2) starting with the highest-risk seams (Allocator, JobQueue, EventStore, SecretStore, provider/harness adapters); **unified JSON-Schema export** (§3); **Stryker mutation testing** (§5) on critical + seam modules.
- **Not now:** the Rust rewrite itself and the Rust harness — these are the _payoff_, enabled by the above, undertaken only when the TS system is functional + proven.
