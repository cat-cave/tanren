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

## What already supports this (don't regress it)

Multi-service boundaries (orchestrator/allocator/dashboard/db over HTTP+SQL+SSH+events); Zod-sourced contracts with drift checks; the `app.request` HTTP test pattern; injectable/mockable seams everywhere; answerer-schema JSON export. The deltas to pursue are §1–§5 above, incrementally — not a big-bang.

## Sequencing (folded into the expansion/strictness plan)

- **Now (cheap, high-leverage):** adopt §1 as the default test style in all new work; write §4 (harness-protocol contract doc) before/with the new harness adapters.
- **Track C — longevity (interleaved with Track B):** seam **conformance suites** (§2) starting with the highest-risk seams (Allocator, JobQueue, EventStore, SecretStore, provider/harness adapters); **unified JSON-Schema export** (§3); **Stryker mutation testing** (§5) on critical + seam modules.
- **Not now:** the Rust rewrite itself and the Rust harness — these are the _payoff_, enabled by the above, undertaken only when the TS system is functional + proven.
