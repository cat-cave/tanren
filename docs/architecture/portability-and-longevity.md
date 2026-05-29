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
