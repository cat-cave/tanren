# Harness↔Orchestrator Protocol (v1)

This document is the **versioned, documented contract** between the orchestrator
and any _harness_ — the thing that runs an agentic CLI (codex/claude/opencode/aider
today; agy/pi/reasonix and a future native Rust harness later). It is
Track C §4 of [`portability-and-longevity.md`](./portability-and-longevity.md):

> Define the harness protocol as a versioned, documented contract (a task
> descriptor in → diff / events / token-usage / structured-output out), distinct
> from any single CLI's quirks. Each harness adapter maps its CLI to this one
> protocol; harnesses without structured output declare a writer-only capability.

The contract — not the implementation — is the durable asset. A harness is
conformant if it satisfies this contract; _how_ it shells out to a CLI (or, for
the future Rust harness, runs in-process) is its own concern. The orchestrator
never depends on a CLI's quirks, only on this protocol.

## 1. Roles

A harness serves one or both protocol **roles**:

| Role     | Purpose                                              | Result kind                       |
| -------- | ---------------------------------------------------- | --------------------------------- |
| `write`  | Mutate a workspace to satisfy a spec/subtask         | diff + commits (`WriterResult`)   |
| `answer` | Produce a structured JSON answer to a reasoning task | schema-validated JSON (`TOutput`) |

The orchestrator's loop maps its stages onto these roles: `plan`, `check`,
`audit`, and `demo` are all `answer` tasks (each pins its own output schema);
`write` is the only `write` task.

## 2. Capability declaration

Every harness declares a **capability** — which roles it can serve. The single
discriminator is **structured output**:

- A harness that can emit schema-constrained JSON (the structured-output channel
  in §4) supports the `answer` role → it is **Answerer-eligible** (and, since
  any structured-capable agent can also just edit files, Writer-eligible too).
- A harness without structured output is **writer-only**.

This yields exactly two capability classes:

| Class              | Roles              | `structuredOutput` | Harnesses today |
| ------------------ | ------------------ | ------------------ | --------------- |
| Structured-capable | `write` + `answer` | `true`             | codex, claude   |
| Writer-only        | `write`            | `false`            | opencode, aider |

opencode and aider are wired writer-only harnesses (each can edit files but
exposes no structured-JSON channel, so neither can serve the `answer` role).
agy/pi/reasonix are named throughout this doc as future members of these classes
but are **not** wired yet (they await CLI specs).

The capability table is the **single source of truth** in the providers layer:
[`harnessCapability.ts`](../../services/orchestrator/src/engine/providers/harnessCapability.ts).
Each entry is a typed record:

```ts
interface HarnessCapability {
  readonly cli: HarnessCli; // "codex" | "claude" | "opencode" | "aider"
  readonly roles: readonly HarnessRole[]; // ("write" | "answer")[]
  readonly structuredOutput: boolean; // true ⟺ "answer" ∈ roles
}
```

The invariant `structuredOutput ⟺ roles.includes("answer")` is pinned by a
conformance test (`adapterSelector.test.ts`). Adding a harness is **one entry
here plus its adapter** — the selectable-cli sets and role checks derive from
this table (§6), so there is no second place to keep in sync.

## 3. Task descriptor IN

The orchestrator hands the harness a **task descriptor**. The fields the
protocol guarantees:

| Field          | Roles    | Meaning                                                    |
| -------------- | -------- | ---------------------------------------------------------- |
| `prompt`       | both     | The spec/subtask instruction text (delivered on stdin)     |
| `workspace`    | `write`  | Absolute path to the git workspace to mutate               |
| `workspace?`   | `answer` | Optional read-only context dir for the reasoning task      |
| `role`         | both     | The protocol role (`write` / `answer`) being requested     |
| `outputSchema` | `answer` | The structured-output schema (name + JSON Schema + parser) |
| `timeoutMs`    | both     | Hard wall-clock budget for the invocation                  |
| `model?`       | both     | Optional model id pin (else the harness default)           |
| `authRef`      | both     | Credential reference the harness materializes at call time |

In the TS providers layer these map to `runWriter(opts)` /
`runAnswerer(opts)` in
[`types.ts`](../../services/orchestrator/src/engine/providers/types.ts). The
`outputSchema` carries `{ name, jsonSchema, parse(value) }` — the harness
constrains generation to `jsonSchema` and the orchestrator validates the result
with `parse`.

A `write` task is delivered to a read-write workspace; an `answer` task runs
read-only against its optional context workspace and never produces a diff.

## 4. Results OUT

### 4.1 `write` role → `WriterResult`

```ts
interface WriterResult {
  diff: string; // unified diff vs. the captured baseline sha
  commits: Commit[]; // commits made on top of baseline ({ sha, message })
  exitReason: // see §5
    "completed" | "timeout" | "crashed" | "token_limit" | "window_exhausted";
  tokenUsage?: TokenUsage; // disjoint buckets (§4.3)
  telemetry?: {
    // raw-event accounting + parsed signals
    rawEventCount: number;
    tokenUsage?: TokenUsage;
    usageLimit?: UsageLimitSignal;
  };
}
```

The harness is responsible for capturing the baseline, committing the
workspace's changes, and producing `diff` + `commits` — the orchestrator
consumes them uniformly regardless of which CLI produced them.

### 4.2 `answer` role → schema-validated JSON

The harness emits a single JSON object on the structured-output channel that
**must** validate against the task descriptor's `outputSchema.jsonSchema`. The
orchestrator runs `outputSchema.parse(value)` and gets back the typed `TOutput`
(e.g. `PlanAnswer`, `CheckAnswer`, `AuditAnswer`, `DemoAnswer`). A response that
is not valid JSON, or fails schema validation, is a failure (§5).

### 4.3 Token usage (both roles)

Token usage is reported in **disjoint buckets** that sum to `totalTokens` — they
must never be folded into one number:

```ts
interface TokenUsage {
  inputTokens: number; // uncached prompt tokens
  cachedInputTokens: number; // cache-read tokens
  cacheCreationTokens: number; // cache-write/creation
  outputTokens: number; // non-reasoning completion tokens
  reasoningOutputTokens: number; // reasoning tokens
  totalTokens: number; // provider-reported total, else sum of the five
}
```

A harness whose CLI reports an _inclusive_ shape (e.g. Codex, where cached ⊆
input and reasoning ⊆ output) must **de-overlap** into these disjoint buckets;
a harness whose CLI already reports disjoint buckets (e.g. opencode) maps
straight across. If a harness cannot report usage it returns `emptyTokenUsage`.

### 4.4 Events / telemetry (both roles)

A harness's CLI streams structured events (Codex/Claude/opencode all emit
JSON-per-line on stdout). The harness parses that stream into `telemetry`
(`rawEventCount`, `tokenUsage`, and any `usageLimit` signal). The protocol does
not mandate a specific event vocabulary in v1 — only that token usage and a
usage-limit signal are recoverable from the stream. (Surfacing the full event
stream as a first-class protocol output is a candidate for a later version.)

## 5. Exit / failure semantics

`exitReason` is the single classification the orchestrator routes on for the
`write` role; the `answer` role raises the analogous typed errors.

| `exitReason`       | Meaning                                                          | Orchestrator treatment      |
| ------------------ | ---------------------------------------------------------------- | --------------------------- |
| `completed`        | The task ran to completion                                       | Use the result              |
| `timeout`          | The `timeoutMs` budget was exceeded                              | Recoverable / retriable     |
| `crashed`          | Non-zero exit, transport failure, or unparseable output          | Hard failure                |
| `token_limit`      | The model's context/output token limit was hit mid-task          | Recoverable                 |
| `window_exhausted` | Authenticated but the subscription window / usage quota is spent | Escalate as window pressure |

`window_exhausted` is **distinct from `crashed`**: the harness authenticated
successfully but the account is out of quota (PROJECT_BRIEF §4.3). A harness
detects it from a stable "usage limit"/"rate limit" phrase in its event stream
and **must** classify it as `window_exhausted` so the workflow escalates window
pressure instead of retrying a doomed call. For the `answer` role this surfaces
as a typed usage-limit error (e.g. `CodexUsageLimitError` /
`ClaudeUsageLimitError`) rather than a generic failure.

Even on a failing `write` exit, the harness still captures and returns whatever
`diff`/`commits` exist (a partial diff is useful diagnostic state).

## 6. How the orchestrator consumes the capability model

The capability table backs adapter selection in
[`adapterSelector.ts`](../../services/orchestrator/src/engine/providers/adapterSelector.ts):

- `SELECTABLE_WRITER_CLIS` and `SELECTABLE_ANSWERER_CLIS` are **derived** from
  the table (`WRITER_CAPABLE_CLIS` / `ANSWERER_CAPABLE_CLIS`) rather than
  hardcoded — so they cannot drift from the declared capabilities.
- `buildWriterAdapter` / `buildAnswererAdapter` call `harnessSupportsRole(cli,
role)` **before** constructing an adapter. A cli the table does not mark
  eligible for the requested role throws `UnsupportedProviderError` — this is
  how opencode (writer-only) is rejected as an Answerer from the single source
  of truth, instead of an ad-hoc `switch` default.

Net effect: **adding a harness = one capability entry + its adapter.** Selection
behavior is fully determined by the table; the conformance test pins that the
v1 table reproduces today's selection (codex/claude both roles, opencode/aider
writer-only).

## 7. Versioning

This contract is **v1** (`HARNESS_PROTOCOL_VERSION`). The version is bumped only
on a **breaking** change to the invocation contract: a removed/renamed task
descriptor field, a changed `WriterResult`/`TokenUsage` shape, a changed
`exitReason` set, or a changed structured-output channel semantics. Additive,
backward-compatible changes (a new optional descriptor field, a new optional
telemetry field) do **not** bump the version.

A future Rust harness implements this protocol natively — it is "just another
conformant harness," declaring its capability entry and satisfying the same
contract + conformance tests, and gets the orchestrator integration for free.

## 8. What this contract intentionally does NOT cover (v1)

- **Transport.** Whether a harness shells out over SSH, runs a local process,
  or runs in-process is out of scope; the protocol is about the descriptor IN /
  results OUT, not the channel.
- **Credential materialization.** How a harness turns `authRef` into a usable
  credential on the runner is the harness's concern (see the per-provider
  `credentials/` materializers).
- **A full event-stream schema.** v1 only requires token usage + usage-limit be
  recoverable from the stream (§4.4); a first-class event contract is future
  work.
- **New harnesses.** aider is now wired (writer-only). agy/pi/reasonix and the
  Rust harness are named here for context but are not wired yet (they await CLI
  specs).
