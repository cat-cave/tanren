# Forge Conversation Substrate (P2A-0019)

Forge is the operator's chat-primary surface in the hi-fi vision: a typed
conversation that narrates project state and offers structured actions.
Phase 2 ships the **data substrate** only — long-lived threads, ordered
turns, a typed tool surface, and a templated v0 narration generator. The
thick LLM-backed Forge ("Forge author") swaps in for Phase 3 with **no
migration**: the same `forge_threads` and `forge_turns` tables back the
LLM-authored conversation.

Owner spec: `P2A-0019` in `docs/roadmap/phase-2a-specs.md`.

## Model

```
ForgeThread (org / project / run scope)
  └── ForgeTurn (append-only, ordered by index)
        ├── source: event | cost | insight | prior_turn | operator
        ├── audience: project:member | project:admin | org:admin | platform:admin
        ├── authorKind: forge_template (v0) | forge_llm (Phase 3) | operator
        └── render: ForgeAnswer  (from P2A-0008 answerer schema)
```

A thread is the unit of operator-Forge conversation. It is scoped to an
org (the tenant), and optionally to a project and/or run for tighter
context. Turns are append-only with a monotonically increasing per-thread
index; a unique constraint on `(thread_id, turn_index)` is the storage
backstop.

Every turn carries:

- **source** — what triggered the turn. Phase 2 emits `operator` for the
  v0 generator's "operator clicked refresh" trigger; Phase 3 emits
  `event`, `cost`, `insight`, or `prior_turn` depending on what the LLM
  was reacting to.
- **audience** — the minimum scope required to read the turn. The
  list/get path filters turns the actor cannot view. This is a
  **coarse-grained complement** to P2A-0009 (which redacts individual
  fields inside event payloads): a turn rendered for `org:admin` is
  simply invisible to a `project:member`.
- **authorKind** — Phase 2 writes `forge_template`; Phase 3 will write
  `forge_llm`. The dashboard renders both identically; the column exists
  so the read API can label provenance and so audit queries can attribute
  conversation cost back to LLM turns.
- **render** — the typed `ForgeAnswer` payload (`body`, `attentionItems`,
  `insights`, `prompts`) from the P2A-0008 single-source-of-truth
  answerer schemas. The append path validates `render` against the
  schema; readers receive `unknown` and re-parse if they need exhaustive
  type safety.

### Why two tables instead of an event log

Conversations have ordering, state (closed vs open), and an explicit
"thread" container the dashboard navigates. Events are immutable
infra-state records and a different consumer audience. We keep them
separate so:

- The dashboard's chat UI can paginate turns inside a thread without
  reading the global event firehose.
- The Phase 3 LLM author reads "all my prior turns in this thread" by a
  single indexed query.
- Closing or archiving a conversation does not require deleting events.

## Tool surface

The P2A-0008 `ForgeToolCall` discriminated union enumerates every read
and write the hi-fi shows Forge offering. v0 implements every variant —
read tools wrap the existing typed stores (P2A-0005, P2A-0011, P2A-0014,
P2A-0018); write tools wrap the P2A-0013 workflow functions; `repo.*`
tools call the GitHub App via the same `FetchGitHubHttpClient` the
brownfield link route uses.

Read tools:

- `tanren.read_spec` — spec + linked behaviors + milestone
- `tanren.read_run` — run + tasks
- `tanren.read_events` — events for run/spec (P2A-0009 redacted by default)
- `tanren.read_costs` — cost records for run/project + total USD
- `tanren.read_behaviors` — behaviors reachable from a project's personas
- `tanren.read_milestones` — milestones for a project
- `tanren.read_insights` — P2A-0020 stub (v0 returns empty array)
- `repo.read_file` — single-file read via GitHub Contents API
- `repo.grep` — repo-scoped GitHub Code Search
- `repo.read_issue` — single GitHub issue

Write actions (operator-button-driven in v0, LLM-callable in Phase 3):

- `tanren.create_spec` — opens a new spec (+ optional behavior/milestone links)
- `tanren.trigger_run` — queues a run from a spec
- `tanren.rerun_task` — queues a rerun of the task's spec (v0 simplification)
- `tanren.acknowledge_insight` — records an ack (P2A-0020 stub in v0)

All tools enforce the same project/org access checks as the underlying
P2A-0013 routes via the shared `assertProjectAccess`/`assertRunAccess`/
`assertSpecAccess` helpers in `engine/forge/tools/authz.ts`.

## Routes

```
POST /orgs/:orgId/forge/threads
GET  /orgs/:orgId/forge/threads/:threadId
GET  /orgs/:orgId/forge/threads/:threadId/turns
POST /orgs/:orgId/forge/threads/:threadId/turns/generate-project-view
POST /orgs/:orgId/forge/threads/:threadId/turns/generate-run-detail
POST /orgs/:orgId/forge/tools
```

The `/forge/tools` endpoint dispatches on the `ForgeToolCall` discriminated
union — the dashboard sends a single `{tool, args}` JSON body that matches
the P2A-0008 schema exactly. Adding a tool is: extend the union in
`engine/answerers/schemas/forge.ts`, implement the function, add a case
to `dispatchTool` in `routes/forge/index.ts`.

## v0 narration generator

`engine/forge/narration/v0.ts` is a **pure function** that turns
structured project context (`NarrationInput`) into a `ForgeAnswer`. It
composes four blocks:

- **body** — single-sentence pulse (`"Supplier Tools: 1 run in flight,
  1 PR review-ready; $42 spent this week."`)
- **attentionItems** — pending reviews, budget warnings, blocked runs,
  ranked by priority
- **insights** — passed through from `NarrationInput.insights` (P2A-0020
  owns generation)
- **prompts** — hardcoded follow-up prompt list keyed to the project's
  current state

The route handler loads `NarrationInput` from the existing stores
(recent runs, pending reviews, week-to-date cost) and hands it to the
generator. The narration logic is pure so synthetic-fixture tests can
exercise it without a database.

## Phase 3 swap

The LLM author replaces only `engine/forge/narration/v0.ts` — it reads
prior turns + tool results from the same `forge_threads` /
`forge_turns` tables, emits `authorKind: "forge_llm"`, and lands a new
turn through the same `ForgeTurnStore.append` path. The HTTP routes,
the tool surface, the audience scoping, and the dashboard renderer all
stay the same. **No migration.**
