# Forge Conversation Substrate

Forge is the operator's chat-primary surface in the hi-fi vision: a typed
conversation that narrates project state and offers structured actions. Two
authoring paths share one data substrate:

- a **templated narration generator** (`engine/forge/narration/v0.ts`) — a pure
  function that the `generate-project-view` / `generate-run-detail` routes use to
  render a deterministic pulse turn from structured project context, and
- the **thick LLM-backed Forge author** (`engine/forge/conversation/engine.ts`,
  `authorKind "forge_llm"`) — the real conversation engine that answers an
  operator question by looping a provider answerer over the read-tool surface and
  proposing writes for human approval. **This is built and merged.**

The same `forge_threads` and `forge_turns` tables back both paths.

## Model

```
ForgeThread (org / project / run scope)
  └── ForgeTurn (append-only, ordered by index)
        ├── source: event | cost | insight | prior_turn | operator
        ├── audience: project:member | project:admin | org:admin | platform:admin
        ├── authorKind: forge_template | forge_llm | operator
        └── render: ForgeAnswer  (single-source-of-truth answerer schema)
```

A thread is the unit of operator-Forge conversation. It is scoped to an
org (the tenant), and optionally to a project and/or run for tighter
context. Turns are append-only with a monotonically increasing per-thread
index; a unique constraint on `(thread_id, turn_index)` is the storage
backstop.

Every turn carries:

- **source** — what triggered the turn. The templated generator emits
  `operator` for its "operator clicked refresh" trigger; the LLM author emits
  `event`, `cost`, `insight`, or `prior_turn` depending on what it was reacting
  to.
- **audience** — the minimum scope required to read the turn. The
  list/get path filters turns the actor cannot view. This is a
  **coarse-grained complement** to the per-field event-payload redaction: a turn
  rendered for `org:admin` is simply invisible to a `project:member`.
- **authorKind** — `forge_template` for templated narration, `forge_llm` for the
  LLM author, `operator` for the operator's own question turns. The dashboard
  renders them identically; the column exists so the read API can label
  provenance and so audit queries can attribute conversation cost back to LLM
  turns.
- **render** — the typed `ForgeAnswer` payload (`body`, `attentionItems`,
  `insights`, `prompts`) from the single-source-of-truth answerer schemas
  (`engine/answerers/schemas/forge.ts`). The append path validates `render`
  against the schema; readers receive `unknown` and re-parse if they need
  exhaustive type safety.

### Why two tables instead of an event log

Conversations have ordering, state (closed vs open), and an explicit
"thread" container the dashboard navigates. Events are immutable
infra-state records and a different consumer audience. We keep them
separate so:

- The dashboard's chat UI can paginate turns inside a thread without
  reading the global event firehose.
- The LLM author reads "all my prior turns in this thread" by a single
  indexed query.
- Closing or archiving a conversation does not require deleting events.

## Tool surface

The `ForgeToolCall` discriminated union enumerates every read and write the
hi-fi shows Forge offering. Every variant is implemented — read tools wrap the
existing typed stores; write tools wrap the workflow functions; `repo.*` tools
call the GitHub App via the same `FetchGitHubHttpClient` the brownfield link
route uses.

Read tools:

- `tanren.read_spec` — spec + linked behaviors + milestone
- `tanren.read_run` — run + tasks
- `tanren.read_events` — events for run/spec (redacted by default)
- `tanren.read_costs` — cost records for run/project + total USD
- `tanren.read_behaviors` — behaviors reachable from a project's personas
- `tanren.read_milestones` — milestones for a project
- `tanren.read_insights` — compute-on-read insights dispatch
- `repo.read_file` — single-file read via GitHub Contents API
- `repo.grep` — repo-scoped GitHub Code Search
- `repo.read_issue` — single GitHub issue

Write actions:

- `tanren.create_spec` — opens a new spec (+ optional behavior/milestone links)
- `tanren.trigger_run` — queues a run from a spec
- `tanren.rerun_task` — queues a rerun of the task's spec
- `tanren.acknowledge_insight` — records an ack

All tools enforce the same project/org access checks as the underlying
routes via the shared `assertProjectAccess`/`assertRunAccess`/
`assertSpecAccess` helpers in `engine/forge/tools/authz.ts`.

## Write actions: propose → approve → execute

The LLM author never executes a write directly. During the answerer loop it is
constrained to the READ family for tool dispatch (a write-tool request mid-loop
is dropped, never executed). Its final answer may instead carry
`proposedActions` — write tools it wants a human to approve. The conversation
engine persists each as a `pending` row in `forge_action_proposals` and stops.

An operator then approves or rejects the proposal through the proposal routes.
On approve, `decideForgeProposal` (`engine/forge/proposalDecision.ts`) is the
single chokepoint: it claims the proposal (idempotent conditional UPDATE on
`status = 'pending'`), re-validates the args into a typed `ForgeWriteToolCall`,
executes the underlying write through the dispatcher **under the approving
operator's `ActorContext`** (the write tools enforce the same access gate as the
routes), records `executed`/`failed`, and appends a turn narrating the outcome.
A second decision on an already-decided proposal throws
`ProposalAlreadyDecidedError`, mapped to a 409 — so a write is never executed
twice.

## Routes

```
POST /orgs/:orgId/forge/threads
GET  /orgs/:orgId/forge/threads/:threadId
GET  /orgs/:orgId/forge/threads/:threadId/turns
POST /orgs/:orgId/forge/threads/:threadId/turns/generate-project-view
POST /orgs/:orgId/forge/threads/:threadId/turns/generate-run-detail
POST /orgs/:orgId/forge/tools
POST /orgs/:orgId/forge/threads/:threadId/ask
GET  /orgs/:orgId/forge/threads/:threadId/proposals
POST /orgs/:orgId/forge/proposals/:proposalId/approve
POST /orgs/:orgId/forge/proposals/:proposalId/reject
```

- The `/forge/tools` endpoint dispatches on the `ForgeToolCall` discriminated
  union — the dashboard sends a single `{tool, args}` JSON body. Adding a tool
  is: extend the union in `engine/answerers/schemas/forge.ts`, implement the
  function, add a case to `dispatchTool` in `routes/forge/index.ts`.
- `/forge/threads/:threadId/ask` (`routes/forge/ask.ts`) runs one operator
  question through the LLM-backed conversation engine and returns the persisted
  operator + forge turns. The answerer is resolved per-request from the thread's
  org/project via `answererFactory(target)`; production wires a real provider
  answerer, tests inject a fake. There is no deterministic fallback.
- `/forge/proposals/...` (`routes/forge/proposals.ts`) lists and decides
  write-action proposals.

## Templated narration generator

`engine/forge/narration/v0.ts` is a **pure function** that turns structured
project context (`NarrationInput`) into a `ForgeAnswer`. It composes four
blocks:

- **body** — single-sentence pulse (`"Supplier Tools: 1 run in flight,
1 PR review-ready; $42 spent this week."`)
- **attentionItems** — pending reviews, budget warnings, blocked runs,
  ranked by priority
- **insights** — passed through from `NarrationInput.insights`
- **prompts** — follow-up prompt list keyed to the project's current state

The `generate-project-view` / `generate-run-detail` route handlers load
`NarrationInput` from the existing stores (recent runs, pending reviews,
week-to-date cost) and hand it to the generator. The narration logic is pure so
synthetic-fixture tests can exercise it without a database.
