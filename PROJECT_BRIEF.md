# PROJECT_BRIEF.md — Tanren v3

**Project**: Tanren (the platform for end-to-end agentic code development)
**Repo target**: `cat-cave/tanren` (migrated from `trevorWieland/tanren`)
**Status**: Implementation-ready brief. Written 2026-05-21 as a clean-room replacement of the prior n8n-autocoder rewrite brief, with all operator corrections folded as the new ground truth.

This is the fourth attempt in the agentic-code-orchestration space. Quikode (Python) was abandoned. Tanren v1 (Python, ~67kLOC) shipped working substrate adapters then was deleted in one commit. Tanren v2 (Rust) shipped one feature in five weeks. The n8n-autocoder built on top of an off-the-shelf workflow engine and accumulated compounding design errors. We name this attempt **Tanren v3** because honest naming matters: it is a successor, not a green-field project.

What is different in v3:

- **The workflow is treated as the product, not a side effect.** Prior attempts built infrastructure first and discovered the workflow during operator use. v3 specifies the minimum viable agentic-code workflow (§2) and builds infrastructure to serve it.
- **Writers and Answerers are first-class, structurally enforced agent kinds** (§3). Prior attempts hybridized; v3 refuses to.
- **The three cost models that real operators face are first-class** (§4). Prior attempts modeled one of three and broke on the others.
- **Everything runs in containers. No host code, ever, for any reason** (§6). The orchestrator is itself a container. There is no "host process" surface at all; consequently there is no host-execution enforcement layer to bypass.
- **Credential storage, transport, and loading are solved properly at v0**, not deferred (§8). Prior attempts shipped auto-discovery-of-local-credentials shortcuts that prevented every later expansion.

There is no time-gate on v0. v0 ships when the §14 acceptance gate passes — a complete agentic-code workflow producing merged PRs against real repos. If that takes an hour per task or six hours, that is not v0's failure; it is signal to optimize later.

> **Read order if you only have 20 minutes**: §0 (Why this exists) → §2 (Minimum viable workflow) → §3 (Writers vs Answerers) → §6 (Architecture) → §14 (Acceptance gate).

---

## §0 — Why this exists

The agentic-code-orchestration problem is not a workflow-engine problem and not an "LLM wrapper" problem. It is a **platform** problem: an end-to-end loop that takes a feature request and produces merged code, reliably, with honest cost accounting, against real repositories the operator owns. Three problem axes that prior attempts under-solved:

1. **Workflow correctness.** Code-writing agents drift. Without an outer loop (planner → writer → checker → auditor → PR → CI → review → merge), arbitrary tasks fail in arbitrary ways. The outer loop is not optional infrastructure; it is the product.

2. **Cost honesty.** Operators conceptualize LLM cost in three distinct ways (token-billed, flat-fee/self-hosted, subscription-window). Modeling one of the three breaks for the other two. Prior attempts modeled one and broke.

3. **Real infrastructure.** Autonomous code-writing agents need real sandboxing (containers, not host processes), real credential transport (stored, encrypted, injected per-session, not symlinked from `~/.config`), and real concurrency limits (measured, not guessed). Each of these has a "shortcut" that works for the first operator and fails for the second.

Tanren v3 commits to solving all three at v0. If the result is more infrastructure than a solo-builder seems to need, that is not over-engineering — it is the minimum substrate that admits a second user, a second repo, a second cost model. Without it, every later step is a refactor cliff.

The prior-attempt failure modes catalogued in `audits/F-01 … F-36` and in the quikode/tanren retrospectives are the regression-test corpus for v3 (§15.3).

---

## §1 — Naming, identity, top-level invariants

### §1.1 Project name

**Tanren.** The CLI binary is `tanren`. The repo is `cat-cave/tanren`. The runner image is `ghcr.io/cat-cave/tanren-runner`. There is no internal product called "autocoder" — that was the n8n-autocoder predecessor.

### §1.2 Architectural invariants

These are mechanical, enforced at the type system, configuration validation, and CI layers. Each is non-negotiable.

1. **No host code.** Every process Tanren operates lives in a container. The orchestrator is a container. Agent workloads run in runner containers. Database, secret manager, web dashboard, optional MCP service — all containers, all in one `docker compose` stack. The operator's host runs `docker compose up` and (optionally) the thin CLI. No other host-side state, no host-side credentials, no host-side worktrees, no host-side cache directories.

2. **One database.** Postgres 18, one schema, no SQLite fallback, no libSQL alternative, no per-backend code paths.

3. **One execution model.** SSH from orchestrator to runner container. Local Docker, manual SSH host, and cloud-provisioned VMs are all reached via the same `SshSubstrate` adapter; only the allocator differs. No `docker exec` for agent workloads. No bind-mounted credentials. No bind-mounted source.

4. **Two agent kinds, structurally distinguished.** Writers produce git diffs and are not parsed for completion signals. Answerers produce strict-JSON-schema responses and never touch the filesystem. Mixing them is a type error (§3).

5. **Three cost models, first-class.** Token-billed, flat-fee/self-hosted, subscription-window. Each is recorded with its real source (`ccusage`, `codexbar`, `provider_direct`, `opportunity_computed`); no `legacy_unknown` is acceptable. The cost dashboard handles all three simultaneously (an operator can run claude-max + gpt-pro + a local qwen + an OpenRouter API key in parallel and see all four).

6. **Credentials are managed, not discovered.** No auto-discovery of `~/.config/claude/credentials.json`. No `ANTHROPIC_API_KEY` envvar lookup at orchestrator startup. The operator goes through an onboarding flow once, credentials land in the secret manager, and every subsequent invocation pulls from there and transfers per-session to the runner.

7. **Real concurrency, real limits.** No hard-coded "3 concurrent codex CLIs." The orchestrator queries actual provider rate-limit headers, actual `ccusage`/`codexbar` window state, actual subscription state. Imagined limits are explicitly forbidden.

8. **Files are bounded.** Custom lint rule: 500-line maximum per source file. The intent is mechanical — a fresh project can hold this discipline; an old project cannot.

These invariants override every section that follows. If a future revision contradicts one of these, the revision is wrong.

---

## §2 — The minimum viable agentic-code workflow

This is the canonical loop Tanren orchestrates. **Every step is required for v0.** Without any step, the system veers off course on even simple tasks.

```
                            ┌──────────────┐
       ┌──────── spec ──────→  Spec-DAG    │
       │                    └──────┬───────┘
       │                           │ pop
       │                           ▼
       │                    ┌──────────────┐
       │   ┌────────────────│   Planner    │  (Answerer)
       │   │                │  (Answerer)  │  produces N subtasks
       │   │                └──────┬───────┘  for the spec
       │   │                       │
       │   │                       ▼
       │   │                ┌──────────────┐
       │   │     ┌─────────▶│  Subtask N   │
       │   │     │          └──────┬───────┘
       │   │     │                 │
       │   │     │                 ▼
       │   │     │          ┌──────────────┐
       │   │     │          │   do-task    │  (Writer)
       │   │     │          │   (Writer)   │  writes code, runs tests
       │   │     │          └──────┬───────┘
       │   │     │                 │
       │   │     │                 ▼
       │   │     │          ┌──────────────┐
       │   │     │          │  check-task  │  (Answerer)
       │   │     │          │  (Answerer)  │  "Is this subtask done?"
       │   │     │          └──────┬───────┘
       │   │     │                 │
       │   │     │   N + 1 ┌───────┴───────┐ done
       │   │     └─────────│ all subtasks? │──────┐
       │   │               └───────────────┘      │
       │   │                                      ▼
       │   │                               ┌──────────────┐
       │   │       not complete            │   Auditor    │  (Answerer)
       │   └───────────────────────────────│  (Answerer)  │  "Is spec complete
       │                                   └──────┬───────┘   and verifiable?"
       │                                          │ complete
       │                                          ▼
       │                                   ┌──────────────┐
       │                                   │  Draft PR    │
       │                                   └──────┬───────┘
       │                                          │
       │                                          ▼
       │                                   ┌──────────────┐
       │  CI failure                       │  Poll CI     │
       └───────────────────────────────────│  (loop)      │
                                           └──────┬───────┘
                                                  │ CI green
                                                  ▼
                                           ┌──────────────┐
                                           │  Mark ready  │
                                           └──────┬───────┘
                                                  │
                                                  ▼
                                           ┌──────────────┐
                ┌──────────────────────────│  Review?     │
                │ changes requested        └──────┬───────┘
       loop to planner                            │ approved (or none required)
                                                  ▼
                                           ┌──────────────┐
                                           │   Merge      │
                                           └──────────────┘
```

### §2.1 The steps, in plain prose

1. **Pop a spec from the spec-DAG.** Specs are persisted in Postgres; a spec carries its dependencies (must-complete-first specs), its acceptance criteria, and its scope.
2. **Planner Answerer reads the spec, plans the implementation.** Output: a structured plan with N subtasks, each with its own scope, acceptance criteria, and verification approach. The planner does not write code. It answers the question "how should this be implemented?"
3. **For each subtask, run a Writer agent (do-task).** The writer has filesystem access in a sandboxed runner container, writes code, runs tests, makes commits. It does **not** report completion. Its output is the git diff plus the workspace mutations it produced.
4. **For each subtask, run an Answerer agent (check-task).** The answerer reads the writer's diff and the subtask spec, answers the strict-JSON question "is this subtask complete to acceptance criteria?" If no, route back to the planner with a structured diagnosis.
5. **After all subtasks complete, run a single Auditor Answerer.** It answers "is this spec complete and verifiable?" against the spec's acceptance criteria. If no, loop back to the planner.
6. **Submit a draft PR** against the project's target branch.
7. **Poll for CI status.** If CI fails, loop back to the planner (with the CI failure context).
8. **CI green** → mark the PR ready for review.
9. **Poll for review.** If the project's policy requires review and none arrives within the configured window, escalate to a human-intervention notification (§12.3).
10. **If review arrives with changes requested**, loop back to the planner.
11. **If review arrives approved (or none required by policy)**, merge.

### §2.2 What is explicitly out of v0 but layers on top cleanly

These features extend the workflow above. They are not required for v0 ship; they are tracked in §20 as deferred surfaces that the v0 architecture must NOT preclude.

- **Mergify merge queues** (2-tier CI for time efficiency).
- **Conflict resolver** (intelligent rebase response after a merge conflict, with a hard requirement that branches be up-to-date with main before merging).
- **Mergify stacks and stack diffs** (higher merge velocity).
- **Chain PRs** (dependent work starts on the draft PR; "human review required" stops being a velocity killer).
- **Additional auditor layers**: performance, scalability, security, coding-standards-profile, demo-executor agent (browser-based end-to-end test of a feature from the spec's natural-language description).
- **Workflow variation per-project** (a project may declare its own planner/writer/answerer composition; v0 ships one canonical composition).

### §2.3 Why this is the minimum

Removing any of the five core agent invocations (plan, do, check, audit, plus PR/CI/review loop) breaks reliability on real tasks. The audits and retrospectives are explicit on this:

- Without the planner step, writers veer off course on tasks that decompose into multiple files or layers.
- Without the per-subtask checker, writers produce incomplete work that the auditor can't disentangle.
- Without the final auditor, "all subtasks done" is asserted, not verified.
- Without the CI loop, the writer's local tests don't prove the integration.
- Without the review-and-merge loop, the operator can't trust the PR.

v0 commits to all five. Optimizations (skipping the auditor for trivial specs, parallelizing subtasks) come later; the baseline is the full loop.

---

## §3 — Writers vs Answerers

**This is the most important structural distinction in Tanren.** Every prior attempt that hybridized agent roles paid for it in workflow brittleness. v3 enforces the split at the type system and the orchestration layer.

### §3.1 Writers

Writers write code. They:

- Have filesystem access in a sandboxed runner container.
- Make changes, run tests, create commits.
- Are given a task description and a workspace.
- Their **output is the workspace mutation** (the git diff). The orchestrator never parses their stdout for a "completion signal," never expects a JSON envelope, never asks them to self-report.
- Are evaluated **externally** by an Answerer.

Concrete consequence: if a Writer spends 45 minutes writing high-quality code and never emits a status JSON, the orchestrator does not panic. It closes the writer session, captures the diff, and routes to an Answerer. If a Writer hangs / times out / OOMs / crashes mid-session, the orchestrator captures the partial diff (or empty diff), still routes to an Answerer, and lets the Answerer judge what to do next.

Writers in v0:
- **opencode** (with ZAI, Wafer, OpenRouter, or any opencode provider — the operator's choice).
- **claude** (claude-code CLI; despite supporting structured output, it can also be used purely as a Writer).
- **codex** (codex CLI; same).

### §3.2 Answerers

Answerers answer one question. They:

- Are **read-only**. They have no filesystem mutation, no git diff, no commits.
- Are given a question, optionally a context (a diff, a spec, a CI log, a piece of code).
- Their **output is strict JSON conforming to a schema** the orchestrator defined and the answerer was told.
- Schema validation is a hard gate. A response that doesn't validate is treated as a `parse_failure` — but parse-failures are vanishingly rare because the CLIs being used (claude, codex) support structured-output mode natively.

Concrete answer types in v0:

- **Planner Answerer**: input = spec; output = list of subtasks with dependencies and acceptance criteria.
- **Check-task Answerer**: input = subtask + writer's diff; output = `{done: boolean, reason: string, suggested_fixes?: string[]}`.
- **Auditor Answerer**: input = spec + accumulated diffs; output = `{verified: boolean, criteria_status: {...}, reason: string}`.
- **Conflict-resolution-planner Answerer** (v1+): input = merge conflict; output = N-subtask plan to resolve.

Answerers in v0:
- **claude** (structured-output mode).
- **codex** (structured-output mode).
- **opencode** is **NOT a v0 Answerer** because it lacks first-class JSON-schema enforcement. It can be used as an Answerer post-v0 once a JSONL-with-schema-validation contract is in place, but v0 ships only claude and codex in the Answerer role.

### §3.3 Per-role provider routing

Best-fit defaults (operator-overridable per project):

- **Planner** (Answerer): `claude opus` (latest). Highest-quality structured planning.
- **Writer** (Writer): `opencode glm-5.1` via ZAI by default, fallback to `opencode + Wafer`. Cheap, capable, fast iteration; perfect for the "write code, don't talk about it" role.
- **Check-task** (Answerer): `codex gpt-5-codex` (or current). Fast, structured, code-aware.
- **Auditor** (Answerer): `codex gpt-5-codex` (latest) for general; `claude opus` for high-stakes specs.

Operators can route any role to any CLI via `[providers.<role>]` config. The role-to-CLI mapping is data, not code.

### §3.4 Why this distinction is load-bearing

A single agent being asked to both write code AND report on its own completion has two failure modes that compose:

1. Writer's code is good, completion-signal is missing → orchestrator can't tell if work is done.
2. Writer's code is incomplete, completion-signal claims "done" → orchestrator merges broken code.

By separating the roles, each agent does one thing. The writer writes; the answerer judges. The orchestrator never has to disambiguate.

The Tanren v0 codebase enforces this via the `ProviderAdapter` interface: a Writer adapter exposes `runWriter(prompt, workspace): Promise<WriterResult>` where `WriterResult = { commits: Commit[], diff: string, exitReason: 'completed'|'timeout'|'crashed' }` — there is no JSON output. An Answerer adapter exposes `runAnswerer<Schema>(prompt, schema): Promise<z.infer<Schema>>` — there is no filesystem access.

CI rule: a single source file may not import both `runWriter` and `runAnswerer` from the same adapter unless it is the orchestrator's role-dispatcher itself.

---

## §4 — The three cost models

Real operators conceptualize LLM cost in three distinct ways. **Tanren v0 supports all three simultaneously.** A solo-builder may use all three at once: claude-max subscription for planning, gpt-pro subscription for auditing, locally-running qwen-coder for writing, and an OpenRouter API key for fallback. The dashboard surfaces all four sources side-by-side.

### §4.1 Token-billed (pure API)

Operator pays per input/output token via a provider's API. Cost is a calculable real-dollar amount.

- **Real signal**: per-call token counts from the CLI's structured output (claude `usage.input_tokens`/`output_tokens`, codex similar, opencode via ZAI/Wafer/OpenRouter — varies by provider).
- **Recording**: every call writes a `cost_records` row with `pricing_mode='per_token'`, real dollar figure derived from rate tables (`src/engine/cost/rates/`).
- **Budget gate**: per-task cap, per-day cap, both per-project. Gate runs PRE-call: estimates upper-bound cost from prompt size + max output, refuses to spawn the writer if cap would be exceeded.

### §4.2 Flat-fee / self-hosted

Operator has paid for hardware (local GPU) or fixed-fee hosting (a self-hosted llama.cpp endpoint, a runpod box, etc.). Token usage below capacity is "leaving money on the table." Operator wants to MAXIMIZE usage of the asset they paid for.

- **Real signal**: capacity (tokens-per-second, fixed-fee-per-month), actual usage (token count per call, aggregated daily/monthly).
- **Recording**: `cost_records` row with `pricing_mode='opportunity_cost'`, dollar figure derived from `(fixed_monthly_fee / max_monthly_tokens) * tokens_used`.
- **Dashboard surface**: utilization percentage. "You used 31% of your qwen capacity this month — consider routing more work here."
- **Budget gate**: a "utilization floor" rather than a cap. The gate WARNS when utilization drops below a threshold (operator-defined), suggesting routing more work to this provider.

### §4.3 Subscription-window

Operator has a flat subscription (claude max, gpt pro, zai pro, etc.). The provider exposes an opaque "window" — a 5-hour block, a weekly limit, a session quota. Window resets at provider-defined times (claude resets on a rolling 5-hour basis; weekly reset; sometimes promotional resets). The operator has no idea what the window means in tokens.

- **Real signal**: query `ccusage` / `codexbar` / equivalent for the provider's reported window usage percentage and reset time.
- **Recording**: `cost_records` row with `pricing_mode='subscription_window'`, dollar figure derived from `(subscription_monthly_fee / observed_max_monthly_tokens) * tokens_used`. The denominator is updated from observed history; an operator's first month is conservative (assume claude-max = $200 / theoretical-max-tokens-per-month), refines over time.
- **Dashboard surface**: window utilization with reset timestamp. "Claude Max 5-hour window: 73% used, resets at 14:32 UTC." Weekly window: separate gauge.
- **Budget gate**: a "window pressure" awareness. The gate WARNS when the next planned call would push the window over operator-defined threshold (e.g. "this call brings you to 95% of the weekly window, with N days left — proceed?").

### §4.4 Per-team / per-enterprise variants

Solo-builder may use all three for themselves; team-builder and enterprise variants layer on:

- A team may share a single subscription pool: per-user budgeting OR shared budgeting, configurable.
- A team-lead may have a higher per-task budget than members.
- An enterprise might self-host exclusively (model 2 only) to maximize their on-prem investment, with strict no-API-fallback rules.

These layer cleanly on top of the v0 cost model because the cost record's `tenant_id` + `user_id` columns are present from day one (NULL in solo-builder; populated in team+).

### §4.5 Visibility and balancing

The dashboard (§12.2) surfaces the three cost models in one view. The operator sees:

- Real dollar burn per provider (model 1).
- Utilization % for self-hosted assets (model 2).
- Window utilization + reset times for subscriptions (model 3).
- Per-project, per-role attribution across all three.

This is non-negotiable for v0. Operators cannot make routing decisions if they can't see what they're using.

---

## §5 — Audience tiers

### §5.1 Solo-builder

One developer. May run Tanren on their laptop (using local Docker), on a homelab desktop (using local Docker, exposed via cloudflared for remote dashboard access), or on a small VPS (using manual-SSH or Hetzner allocator). May use any combination of the three cost models simultaneously.

**Solo-builder does not need any LLM CLI installed locally.** The CLIs live inside the runner containers (§7.4). The solo-builder needs Docker on the host they're running Tanren on; everything else flows from there.

### §5.2 Team-builder

2–10 developers sharing one Tanren instance. Adds:

- Multi-project (always supported via the `projects` table — v0 has the table from day one, solo-builder happens to have one row).
- Per-operator credential sets (the secret manager scopes credentials by user; an operator's claude-max token is theirs).
- Per-operator budgeting OR shared team budgeting (configurable).
- Web dashboard becomes the primary visibility surface (already exists in v0 — see §12.2).
- Shared GitHub App (one per team, not per operator).

The team-builder tier is unlocked by the credential-management substrate being correct from day one. If credentials were "auto-discover from `~/.config/claude`," there would be no honest way to handle two operators with two different claude-max accounts.

### §5.3 Enterprise

Compliance, audit export, RBAC, secret manager hardening (Vault as a first-class compose service, not just a layer), SSO. Triggered by the first compliance-driven customer requirement. The audit log already exists in v0 (the event log); enterprise adds the access layer and the export discipline.

---

## §6 — Architecture: the docker compose stack

Everything is a container. The operator's host runs `docker compose up` and (optionally) a thin CLI that talks to the orchestrator container.

### §6.1 The compose stack

```yaml
# Conceptual shape (real compose file in repo at compose.yml)
services:
  postgres:           # Postgres 18; single source of truth for state
    image: postgres:18
    volumes: [pgdata:/var/lib/postgresql/data]
    ...

  secret-manager:     # Vault (or simpler v0 stand-in; §20 open)
    image: hashicorp/vault:latest
    ...

  orchestrator:       # The Tanren engine; speaks to allocators
    build: ./services/orchestrator
    depends_on: [postgres, secret-manager]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # for local-docker allocator
    ...

  dashboard:          # Web UI; reads from Postgres, served via Hono/JSX
    build: ./services/dashboard
    depends_on: [postgres]
    ports: ["3000:3000"]
    ...

  cloudflared:        # Optional; for remote dashboard access on homelab setups
    image: cloudflare/cloudflared:latest
    ...

  ntfy:               # Optional; for push notifications (v0-eligible, small)
    image: binwiederhier/ntfy
    ...

  # v1 additions, slot-reserved in compose.yml as commented-out blocks:
  # api:              # HTTP API service
  # mcp:              # HTTP MCP service (NOT stdio)
```

### §6.2 Why no host code at all

The temptation to "put just one small thing on the host" is the same temptation that produced every audit finding in F-01..F-36 of the n8n-autocoder. Host code drifts: it accumulates one-off shell scripts, environment assumptions, "this only works on macOS" branches, and "the orchestrator assumes ccusage is on the path" footguns.

Tanren v3's position: **the host runs Docker. That is the operator's only host-side dependency.** Everything else — orchestrator, database, secret manager, CLIs, cost probes, ntfy, web dashboard, future API and MCP — runs in a container in the compose stack.

Consequences:

- **No `child_process.spawn` on the orchestrator host.** The orchestrator is a Node 24 process inside its own container. It spawns nothing on the host. It SSHs to runner containers (and remote VMs) for agent workloads. It uses `dockerode` against the docker socket (mounted via DooD) for container lifecycle.
- **ccusage and codexbar run in the orchestrator container's filesystem**, not the host's. The orchestrator can call them as subprocesses inside its OWN container — that is the orchestrator interacting with its own runtime, not host execution.
- **No host-side credentials.** All credentials live in the secret manager (a compose service). The orchestrator reads from there; the runner gets credentials per-session via the SSH transport.
- **The CLI is the only optional host-side thing**, and that decision is in §6.4 below.

This eliminates the entire "no-host-process-spawn" enforcement layer. There is no host process to spawn from. The closed substrate type, the lint rule, the doctor preflight, the CI grep gate — all collapse into "the orchestrator is a container; the only thing the operator runs on the host is `docker compose up`."

### §6.3 Provisioning: `docker compose up` is the install

The operator's first-time experience:

1. `git clone github.com/cat-cave/tanren`
2. `docker compose up`
3. Wait for `dashboard` to report healthy.
4. Open the dashboard.
5. Run through the onboarding flow (§13): enter credentials (claude OAuth, codex OAuth, opencode provider key, GitHub PAT or App credentials), register first project (paste repo URL, choose default branch).
6. Submit first spec via the dashboard or CLI.
7. Watch it run end-to-end.

The Docker images in the compose are either pre-built and pulled from ghcr.io (preferred — published per release) or built locally from the repo (for development). Compose handles both transparently.

### §6.4 The CLI: open question

There are two viable shapes for the CLI; both are defensible, the choice is between operator ergonomics and architectural purity.

**Option A — CLI lives inside the orchestrator container.** The operator runs `docker compose exec orchestrator tanren run "..."` (or aliased via a shell function in their dotfiles). All Tanren state and logic stays inside the container.

- Pro: total architectural purity. No host artifacts at all. The orchestrator container is the entire system.
- Con: ergonomically clunky. Every CLI invocation goes through `docker compose exec`. Tab completion, signal handling, terminal width detection, etc., all become harder.

**Option B — CLI is a thin host-side binary that talks to the orchestrator container.** The operator installs `tanren` as a small statically-linked binary (~5MB) that knows how to talk to the orchestrator over a Unix socket (mounted via compose) or HTTP-on-localhost.

- Pro: ergonomic. Native CLI feel. Tab completion via standard bash/zsh mechanisms. Future-proofing: when v1 ships a remote orchestrator (e.g. on a GCP VM), the same CLI talks to it over HTTPS — imagining a thinclient laptop with `tanren` installed, talking to a service on GCP that scales massively for concurrent workers.
- Con: introduces a host artifact (the CLI binary). Requires a build/distribution pipeline. If the CLI gets out of sync with the orchestrator version, errors are confusing.

**Recommended default**: Option B. The thinclient story is the right long-term shape, and the v0 CLI is genuinely thin — it's an argument parser + a JSON message to the orchestrator + an event-stream consumer for rendering. In either case, the CLI **does not execute agent code**, does not hold credentials, does not write to a database. It is a remote control for the orchestrator container.

### §6.5 Web dashboard: v0, not v1

The web dashboard ships in v0. The use case is not "teams need shared visibility" but "any operator needs visibility into a multi-step, long-running workflow." A solo-builder running Tanren on a desktop at home wants to see DORA metrics, run history, and cost dashboards from their laptop on the couch — exposed via `cloudflared` from the same compose stack.

The dashboard is **read-mostly**: lists runs, shows event log per run, surfaces the three cost models, exposes the spec-DAG, allows triggering a new run. It does NOT include credential-editing in v0 (credentials are set via the onboarding flow; rotation is a separate flow in v1). Editing project config is also v1 (a project config can be re-bootstrapped from the dashboard by re-running the project-registration flow).

Stack: Hono + JSX server-rendered, with HTMX for interactive bits (event-stream subscription, drill-down). No React, no SPA, no SSR/CSR split. The dashboard is a service in compose, reads Postgres directly via Drizzle.

### §6.6 HTTP API and HTTP MCP: v1

The MCP server in stdio mode is **not** in v0. STDIO MCP is a trap: it ties Tanren to whichever client process happens to be running, can't be reached from a second client, can't be load-balanced, can't be authenticated, can't be observed. The right surface is HTTP — and the right time to add it is when an HTTP API exists.

The HTTP API ships in v1 alongside the HTTP MCP service. Both are containers in the compose stack. Both authenticate via a token system managed by the secret manager. Both speak the same internal RPC to the orchestrator container.

The architectural slot for the API and MCP exists in v0: the orchestrator container exposes a Unix-domain socket (or localhost-only TCP) that the CLI talks to. The API service in v1 is a Hono server that proxies the same RPC over HTTPS. The MCP service in v1 wraps the same RPC in the MCP protocol. The CLI, the API client, and the MCP client all talk to the same RPC surface.

### §6.7 ntfy.sh: v0-eligible

ntfy.sh is free, low-effort, and useful for the agentic-code workflow: when a run produces a draft PR or needs human review, the operator (who might be away from the terminal) gets a push notification. v0 ships with ntfy as an optional compose service (enabled-by-default in `compose.yml`, operator configures their topic). Slack and Discord are deferred to v1.

---

## §7 — Execution substrate

### §7.1 One adapter, three v0 allocators, extensible

Tanren has exactly one execution adapter: `SshSubstrate`. It speaks SSH to a runner container (or VM). The orchestrator does not distinguish "local Docker" from "remote VM" at the exec layer — both are just SSH targets `{host, port, identity}`.

The **allocator** decides where the SSH target lives. v0 ships three:

| Allocator | What it does |
|---|---|
| `local-docker` | `docker run -d --rm -p 127.0.0.1:<rand>:22 ghcr.io/cat-cave/tanren-runner:v0`. Target is `{host: '127.0.0.1', port: <rand>}`. The orchestrator container reaches the local Docker daemon via the DooD-mounted socket. |
| `manual-ssh` | Operator pre-allocated a Docker+sshd host (or just an SSH-reachable VM with Docker installed). Target from config. |
| `hetzner` | hcloud API provisions a VM with cloudinit that installs Docker and starts the runner container. Target = `{host: <vm-public-ip>, port: 22}`. |

**Extensibility is first-class.** v1+ allocators (GCP, AWS, DigitalOcean, Fly, Lambda Labs, etc.) plug into the `Allocator` interface. Adding an allocator does NOT touch the substrate code; it adds a new module under `src/engine/allocators/`. Every allocator must return an `SshTarget`; that is the only thing the substrate trusts.

### §7.2 Workflow-level lifecycle (decoupled from container longevity)

The lifecycle unit is **a workflow run**, not a subtask. A run may span many subtasks; the same runner container can serve all of them. But the runner container is **not** assumed to persist forever — workflows are decoupled from container longevity. If subtask 5 of 12 dies because the VM rebooted or the container OOMed, the orchestrator allocates a new runner, replays the workspace state via `git checkout` to the last committed state, and resumes from subtask 6.

This implies:
- **Commits between units of work.** Each subtask, on success, makes a commit (or pushes to the remote feature branch). Workspace state is recoverable from the remote SCM.
- **Runners are interchangeable within a workflow.** Any runner can pick up the workflow's branch via `git clone` + `git checkout`.
- **Workflow state lives in Postgres**, not in the runner. The orchestrator tracks "subtask 5 of 12 complete, next is 6, runner died, allocate new runner."

Concretely:

```
worker.workflow(run_id):
  1. handle = await substrate.allocate({project_id, allocator})
  2. session = await ssh2.connect(handle.target, hostKey=pinnedFingerprint)
  3. await session.exec(['git', 'clone', repo_url, '/workspace'],
                        env={GH_TOKEN: <ephemeral, per-session, from secret manager>})
  4. for each subtask in workflow:
       4a. await session.exec([<writer-cli-argv>, '--task', subtask.id],
                              cwd='/workspace', env=<role-config>)
       4b. diff = await session.exec(['git', 'diff', '--no-color'], cwd='/workspace')
       4c. answerer_result = await answerer.check(subtask, diff)
       4d. if answerer says done:
             await session.exec(['git', 'commit', '-am', <message>], cwd='/workspace')
             await session.exec(['git', 'push', 'origin', branch], cwd='/workspace')
       4e. if runner dies between subtasks:
             goto step 1 with same run_id; step 3's git clone resumes from remote
  5. auditor_result = await answerer.audit(spec, accumulated_diffs)
  6. if auditor approves:
       open draft PR; poll CI; etc.
  7. await substrate.release(handle)
```

### §7.3 No bind mounts of host paths, except identically-mountable network volumes

The strict rule from prior briefs (no bind mounts at all) softens to: **no host-bind-mounts for agent-touching content**. A network-mounted shared data volume (e.g., 100GB of training data that a spec needs to operate on) is fine — IF the same mount works identically on a local Docker runner and on a remote Hetzner VM (e.g., NFS-mountable from both, or a Docker volume driver that operates remotely).

The lint rule `no-host-bind-mounts` forbids `Binds` and `Mounts` that point at the **orchestrator's host filesystem**. It permits `--mount type=volume` for named volumes and `--mount type=bind` only when the source is provably a network resource (the lint rule resolves the source path; if it resolves to a host directory, fail).

Agent-authored code, credentials, and worktrees are NEVER on the host. The runner container's filesystem owns the workspace.

### §7.4 Runner image: base + project build-from

The Tanren v0 runner image is intentionally a **base** that projects build on top of. The base image:

| Property | v0 base value |
|---|---|
| Image | `ghcr.io/cat-cave/tanren-runner:v0` |
| Base | `debian:trixie-slim` (current Debian stable as of 2026-05) |
| Packages | `openssh-server`, `git`, `gh`, `curl`, `ca-certificates`, `node` (current LTS), `python` (3.13+), `build-essential` |
| Pre-installed CLIs | `claude-code`, `codex`, `opencode`, `ccusage`, `codexbar` |
| sshd | as PID 1 via tini; pubkey-only; no password; runs as `tanren` user (uid 1000) |
| Workspace | `/workspace` owned by `tanren` user |

Projects build their own image **from** this base, adding language toolchains, dependencies, and project-specific tools:

```dockerfile
# A user's tanren-runner.Dockerfile for their Rust project:
FROM ghcr.io/cat-cave/tanren-runner:v0

USER root
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --profile minimal
RUN cargo install cargo-nextest

# Pre-pull the project to speed up `git clone` inside the container at runtime
USER tanren
RUN git clone https://github.com/myorg/myrepo.git /workspace && cd /workspace && cargo fetch
```

The project's runner image is declared in `[project.runner_image]` config. When Tanren provisions a runner for that project, it uses the project-specific image, not the base.

This gives:
- **Fast cold starts** for projects that have pre-installed dependencies in their custom image.
- **Reproducibility** — the runner image is content-addressable; CI runs against the same image the workflow used.
- **Operator freedom** to add tooling without modifying Tanren.
- **No "monkey-patch the runner at boot time"** — if the operator needs a tool, they add it to their image, not to a startup script.

### §7.5 Concurrency: real, not invented

Concurrency limits are derived from real signals, never guessed:

- **Per-provider rate limits**: read from provider HTTP headers (e.g., `anthropic-ratelimit-tokens-remaining`, `anthropic-ratelimit-requests-remaining`). When a provider's headers say "30 requests remaining in this window," that is the cap.
- **Per-CLI window state**: `ccusage` / `codexbar` queries return the actual subscription-window state. When claude-max says "73% of weekly window used," that is what we surface.
- **Per-runner-pool limits**: the operator declares `max_concurrent_runners` in config. This is a real limit (their own decision), not a fake "3 codex CLIs max" hardcoded somewhere.
- **Per-allocator limits**: Hetzner has a real per-project VM quota; the allocator reads it via `hcloud project info` and exposes it. Imagined limits ("8 VMs max") are forbidden.

When a real limit is unavailable (e.g., a provider doesn't expose its rate-limit headers), Tanren operates conservatively: enqueues new calls behind a single-flight mutex per provider until the unavailability is fixed, and emits a `rate_limit_unknown` observation to the event log so the operator knows.

---

## §8 — Credential management

Tanren's credential system is a v0 requirement, not a layered-on feature. Prior attempts deferred this; every later expansion (multiple users, multiple projects, remote execution) crashed into the unsolved credential problem.

### §8.1 What credentials Tanren handles

- **LLM provider credentials**: claude OAuth tokens, codex OAuth tokens, opencode-provider API keys (ZAI key, Wafer key, OpenRouter key, Anthropic direct API key, OpenAI direct API key, plus config files where required like opencode's ZAI config).
- **SCM credentials**: GitHub PATs, GitHub App installations (per-org), GitLab tokens (v1), Bitbucket (v1).
- **Allocator credentials**: Hetzner API tokens, AWS access keys (v1), GCP service-account JSON (v1), Cloudflared tokens.
- **Notification credentials**: ntfy.sh access tokens, Slack webhooks (v1), Discord webhooks (v1).
- **Tanren-internal**: the SSH keypair the orchestrator uses to talk to runner containers. Generated once at first compose-up, stored in the secret manager. Operator never touches.

### §8.2 The flow: store, transport, load

**Storage**: a dedicated secret manager service in the compose stack. v0 default: HashiCorp Vault (free, well-supported, fits the compose pattern). Alternative for low-friction setups: a postgres-backed encrypted-column scheme using `pgcrypto`, where the master encryption key lives in a Docker secret (managed via `docker compose secrets`). Both options are tracked in §20 as open issues; the brief commits to "a real secret manager service, not envvars," and the choice between Vault and pgcrypto is settled before v0 ship.

**Configuration is separate from secrets.** Settings (Hetzner VM tier, default branch, runner-image override) live in Postgres-backed configuration tables. Secrets (Hetzner API token, Wafer API key, claude OAuth refresh-token) live in the secret manager. The dashboard and CLI surface both, but the storage and access paths are distinct.

**Transport**: when the orchestrator needs to invoke a writer or answerer in a runner, it:
1. Reads the required credentials from the secret manager.
2. Opens an SSH session to the runner.
3. Injects credentials per-session via SSH env-var injection (`session.env('ANTHROPIC_API_KEY', value)` before `session.exec(['claude', ...])`).
4. For credentials that require a config file (opencode's ZAI config, gh's hosts.yml), the orchestrator writes the file to a tmpfs path in the runner via SSH stdin or SFTP, sets file mode 0600 to be safe, and reads it during the call. The file lives only for the lifetime of the SSH session; container teardown destroys it.

**Loading**: credentials are read by the orchestrator inside its own container. The orchestrator's container has access to the secret manager via the compose network (Vault sidecar listening on `vault:8200`, or postgres via the same connection string). No credentials live as envvars on the orchestrator container at startup — they are queried on demand and cached for the lifetime of the active workflow.

### §8.3 The three CLIs' credential shapes

Each CLI has its own auth model. v0 supports all three:

**claude-code**:
- OAuth (device token) — the canonical claude-max path. Token + refresh-token + expiry stored.
- API key (Anthropic direct) — for operators who pay per-token directly.
- Either path lands a credential in the secret manager via the onboarding flow.

**codex**:
- OAuth (device token) — the canonical chatgpt-pro path.
- API key (OpenAI direct).
- Same flow.

**opencode**:
- API key per provider (ZAI, Wafer, OpenRouter, Anthropic, OpenAI, local model endpoints, etc.).
- **opencode also requires a config file** (`~/.opencode/opencode.json` or `OPENCODE_CONFIG_PATH=...`) that maps providers to keys, sets default model, etc. The onboarding flow generates this config file from the operator's secret manager state and writes it into the runner via the SSH transport.

### §8.4 The onboarding flow

The operator's first interaction with credentials, via the web dashboard at `http://localhost:3000/onboarding`. Operators enter their information ONCE; future invocations pull from the secret manager.

1. **Pick the providers you want.** Checkboxes: claude, codex, opencode, plus per-opencode-provider options (ZAI, Wafer, OpenRouter, Anthropic-direct, OpenAI-direct, local-model-endpoint).
2. **For each picked provider, authenticate.**
   - For OAuth providers: dashboard opens a device-authorization flow; operator approves in their browser; Tanren receives the token and stores it.
   - For API-key providers: input field, paste the key, Tanren stores it.
3. **Configure GitHub access.** Either a PAT (input field, paste) or a GitHub App installation (Tanren guides the operator through `gh auth login` equivalent in-browser, captures the installation ID).
4. **Configure your first project.** Repo URL, default branch, project name. Tanren stores this as the first row in the `projects` table.
5. **(Optional) Configure ntfy / cloudflared / Hetzner.** Each is a separate page with the relevant fields.
6. **Done.** Tanren generates the orchestrator's SSH keypair, persists everything to the secret manager + postgres, and presents the dashboard's home view.

The operator never edits config files by hand for v0. Every credential flows through the dashboard's onboarding (and a per-credential rotation page in v1).

### §8.5 Token refresh, rotation, expiry

OAuth tokens expire. The orchestrator runs a background reaper:

- Every minute, check the secret manager for tokens within 5 minutes of expiry.
- Refresh proactively via the provider's refresh-token endpoint.
- If refresh fails (provider revoked, token invalid), emit a `credential_invalidated` event and notify the operator via ntfy.

API keys don't expire but can be rotated:

- Dashboard page: "rotate credentials" → operator pastes a new key → old key is marked `replaced_at=NOW`, new key is active → next workflow uses the new key.
- Old keys are retained for 30 days for forensic purposes, then purged.

### §8.6 429 and rate-limit handling

Per §1.2 invariant 7 (real concurrency, real limits):

- The orchestrator reads `X-RateLimit-*` headers from every provider response (the LLM provider, Hetzner, GitHub, etc.).
- When a 429 is received, the orchestrator does not retry blindly. It honors `Retry-After`, queues new calls behind the limit, and surfaces "provider X is rate-limited, retry at Y" to the dashboard.
- Workflows that have a fallback provider configured (e.g., writer = opencode-zai with fallback to opencode-wafer) automatically reroute on a 429. Workflows with no fallback wait (with operator-visible status).

This is **not** a "best effort, hope for the best" system. Every 429 is logged with provider, endpoint, retry-after, and the workflow that hit it. The dashboard shows the historical rate-limit incidents.

---

## §9 — Data model (Postgres only)

One backend, one schema, one source of truth. Postgres 18.

### §9.1 Core tables

```sql
-- Projects: every workflow operates against a project.
-- Solo-builder has one row; team-builder has N.
CREATE TABLE projects (
  project_id        TEXT PRIMARY KEY,         -- ulid
  name              TEXT NOT NULL,
  repo_url          TEXT NOT NULL,
  default_branch    TEXT NOT NULL DEFAULT 'main',
  runner_image      TEXT NOT NULL,            -- defaults to ghcr.io/cat-cave/tanren-runner:v0
  allocator         TEXT NOT NULL,            -- 'local-docker' | 'manual-ssh' | 'hetzner' | ...
  config            JSONB NOT NULL DEFAULT '{}',  -- project-specific config
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id         TEXT                       -- NULL in solo; populated in team+
);

-- Specs: a unit of work. Source of all workflows.
CREATE TABLE specs (
  spec_id           TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(project_id),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,          -- the operator's natural-language description
  acceptance_criteria JSONB NOT NULL,       -- structured list
  depends_on        TEXT[] NOT NULL DEFAULT '{}',   -- spec_ids that must complete first
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | active | done | abandoned
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id         TEXT
);

-- Runs: an attempt to satisfy a spec.
CREATE TABLE runs (
  run_id            TEXT PRIMARY KEY,
  spec_id           TEXT NOT NULL REFERENCES specs(spec_id),
  project_id        TEXT NOT NULL REFERENCES projects(project_id),
  trigger           TEXT NOT NULL,           -- 'cli' | 'dashboard' | 'api' (v1) | 'webhook' (v1)
  branch            TEXT NOT NULL,           -- the feature branch for this run
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  outcome           TEXT,                    -- 'pr_merged' | 'pr_opened' | 'failed' | 'abandoned'
  pr_url            TEXT,
  tenant_id         TEXT,
  user_id           TEXT                     -- which operator triggered (team+)
);

-- Tasks: a subtask within a run. Created by the planner.
CREATE TABLE tasks (
  task_id           TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(run_id),
  kind              TEXT NOT NULL,           -- 'plan' | 'write' | 'check' | 'audit'
  title             TEXT NOT NULL,
  parent_task_id    TEXT REFERENCES tasks(task_id),
  status            TEXT NOT NULL DEFAULT 'pending',
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  outcome           TEXT,                    -- 'ok' | 'failed'
  failure_kind      TEXT,
  agent_kind        TEXT NOT NULL,           -- 'writer' | 'answerer'
  cli               TEXT NOT NULL,           -- 'claude' | 'codex' | 'opencode'
  model             TEXT,
  attempt           INTEGER NOT NULL DEFAULT 1,
  tenant_id         TEXT,
  user_id           TEXT
);

-- Cost records: every LLM call. Three cost models all flow through here.
CREATE TABLE cost_records (
  id                BIGSERIAL PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(task_id),
  run_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  cli               TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(14,6) NOT NULL,
  pricing_mode      TEXT NOT NULL CHECK (pricing_mode IN
                      ('per_token','opportunity_cost','subscription_window')),
  cost_source       TEXT NOT NULL CHECK (cost_source IN
                      ('provider_direct','ccusage','codexbar','opportunity_computed')),
  cost_source_raw   JSONB NOT NULL,           -- the raw signal we derived from
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id         TEXT,
  user_id           TEXT
);

-- Event log: append-only audit trail of everything that happens.
CREATE TABLE events (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id            TEXT,
  task_id           TEXT,
  spec_id           TEXT,
  project_id        TEXT,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  tenant_id         TEXT,
  user_id           TEXT
);
CREATE INDEX events_run_id_ts ON events(run_id, ts);
CREATE INDEX events_event_type ON events(event_type);

-- Runner pool: per-runner accounting.
CREATE TABLE runners (
  runner_id         TEXT PRIMARY KEY,
  run_id            TEXT REFERENCES runs(run_id),     -- current owner; NULL when idle
  project_id        TEXT REFERENCES projects(project_id),
  allocator         TEXT NOT NULL,
  status            TEXT NOT NULL,           -- 'provisioning' | 'idle' | 'claimed' | 'reaping'
  ssh_host          TEXT NOT NULL,
  ssh_port          INTEGER NOT NULL,
  host_key_fingerprint TEXT NOT NULL,
  image_sha         TEXT NOT NULL,           -- forensic provenance
  container_id      TEXT,                    -- when allocator='local-docker'
  hcloud_server_id  TEXT,                    -- when allocator='hetzner'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at       TIMESTAMPTZ,
  tenant_id         TEXT
);

-- Rate-limit observations: every 429 and every near-limit signal.
CREATE TABLE rate_limit_observations (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_id           TEXT REFERENCES tasks(task_id),
  call_site         TEXT NOT NULL,           -- 'writer' | 'answerer' | 'gh.create_pr' | 'hcloud.provision'
  provider          TEXT NOT NULL,
  observation       TEXT NOT NULL,           -- '429' | 'window_pressure' | 'retry_after' | 'rate_limit_unknown'
  detail            JSONB NOT NULL,
  retry_after_s     INTEGER,
  tenant_id         TEXT,
  user_id           TEXT
);

-- Notifications: the outbox for ntfy / Slack / etc.
CREATE TABLE notifications (
  id                BIGSERIAL PRIMARY KEY,
  channel           TEXT NOT NULL,           -- 'ntfy' | 'slack' (v1) | 'discord' (v1)
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL,           -- 'pending' | 'sent' | 'failed'
  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,
  tenant_id         TEXT,
  user_id           TEXT
);
```

### §9.2 Why these columns are in v0

- **`projects` table** is mandatory because you cannot test the workflow without a project to test against. The solo-builder happens to have one row; that does not justify deleting the table.
- **`tenant_id` and `user_id` columns** are NULL in solo-builder. They exist in v0 so the team-builder transition is "add a non-NULL write" not "rewrite every query." Per §1.2 invariant: column exists, NULL in v0, non-NULL in v1+.
- **`cost_records.pricing_mode`** enumerates all three cost models (§4). A v0 cost-records row must have one of `per_token`, `opportunity_cost`, `subscription_window`. The dashboard's cost view depends on all three being first-class.
- **`runners.image_sha`** is the forensic record of which runner image produced a workflow's output. Combined with `cost_records.cost_source_raw`, the full audit trail of "what version of what tool generated this PR" is reconstructable.
- **`rate_limit_observations`** is first-class telemetry, not optional. Every 429 lands here. The dashboard reads this to warn the operator before they're about to push their claude-max into the weekly cap.

### §9.3 The queue: Postgres-native

Workflows enqueue using Postgres `SELECT ... FOR UPDATE SKIP LOCKED` plus `LISTEN/NOTIFY` for low-latency wake-up. No BullMQ, no Redis, no separate queue service.

The queue table:

```sql
CREATE TABLE job_queue (
  id                BIGSERIAL PRIMARY KEY,
  run_id            TEXT,
  task_kind         TEXT NOT NULL,           -- the worker that picks this up
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'in_progress' | 'done' | 'failed'
  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,
  tenant_id         TEXT,
  user_id           TEXT
);
CREATE INDEX job_queue_pending ON job_queue(task_kind, enqueued_at) WHERE status = 'pending';
```

Workers loop with `SELECT ... FOR UPDATE SKIP LOCKED` and wake on `LISTEN/NOTIFY` when a new job is enqueued. This is well-trodden Postgres territory (`pgmq`, `pg_jobmon`, `graphile-worker`). We hand-roll it because the volume is low and the dependency surface is small; if scale demands, we adopt `graphile-worker` (Postgres-native, 2026-current).

---

## §10 — Stack picks

Each pick is mechanical: pick the tool people are actually using in 2026, not the most-familiar option from earlier years. Each pick is verified against community consensus (sources cited in §22).

| Concern | Pick | Justification |
|---|---|---|
| Compiler | tsgo (TS 7.0) | 10× faster typecheck than tsc. Stable as of 2026-Q1. |
| Runtime | Node 24 LTS | Active LTS through 2028. Bun considered, deferred to v0+2-weeks evaluation pending its Rust-rewrite stabilization (open in §20). |
| Package mgr | pnpm 11.x | Current as of 2026-05. |
| Database | Postgres 18 (18.4 patch) | One backend, one schema, no SQLite path. Compose service. |
| ORM | Drizzle (postgres-only) | Schema-as-code, drizzle-kit migrations, no per-dialect compat. |
| Validation | Zod 4 | Every external boundary (provider stdout, MCP call, dashboard request, secret-manager response) `schema.safeParse(raw)`. |
| Errors | Plain discriminated unions | tsgo exhaustiveness via `switch (f.kind)`. No Effect, no neverthrow. |
| Linter | oxlint 1.x | 50-100× faster than ESLint. CI gate. |
| Formatter | oxfmt 1.x | Pairs with oxlint. Replaces Prettier. |
| Type-aware lint | oxlint type-aware mode (or eslint-typescript fallback for the one rule) | `switch-exhaustiveness-check` is non-negotiable. |
| Testing | Vitest 3 | Standard for Node TS in 2026. |
| Coverage | v8 native via Vitest | No c8. |
| Bundler | tsdown | Library-author default. |
| Queue | Postgres `SKIP LOCKED` + `LISTEN/NOTIFY` | Already in stack. No Redis. No BullMQ. |
| MCP | (deferred to v1; HTTP, not stdio) | v0 ships no MCP. |
| LLM SDK | none in orchestrator | Every LLM call goes through a CLI subprocess via `ProviderAdapter`. |
| Substrate | dockerode 5.x (lifecycle) + ssh2 1.17 (workloads) | One adapter, three v0 allocators. |
| Logging | pino | Structured JSON. |
| Web framework | Hono + JSX server-rendered + HTMX | Dashboard service in compose. |
| Frontend interactivity | HTMX (vendored) | No React/Solid/Vue in v0. |
| Secret manager | Hashicorp Vault (compose service) | v0; pgcrypto fallback considered (§20 open). |
| Notifications | ntfy.sh (compose service) | Free, push-to-phone. |
| Webhooks / remote access | Cloudflared (compose service) | For incoming webhooks and remote dashboard access from a homelab setup. |
| CI | GitHub Actions | Free for OSS. |
| Container runtime target | Docker Engine 29.x (29.5.1 as of 2026-05-18) | The operator must have Docker; that is the only host dependency. |
| 500-line-max custom oxlint rule | yes | Hard cap; prevents monolith files. |

### §10.1 oxlint custom rules

Beyond the standard oxlint rule set, Tanren ships custom rules:

- `no-host-process-spawn` — `node:child_process` allowed only in `src/engine/cli-runner/*` (subprocess invocation of CLIs INSIDE the orchestrator container, talking to ccusage/codexbar/etc.). All other source files fail CI on `child_process` import.
- `no-docker-bind-mounts` — `docker.run` / `docker.createContainer` may not pass `Binds`/`Mounts` pointing at host paths. (Network-mounted volumes via `--mount type=volume` are permitted.)
- `no-docker-exec-for-workloads` — `container.exec()` allowed only in `src/engine/allocators/local-docker.ts` for lifecycle operations (inspect, kill). Agent workloads MUST go via SSH.
- `file-line-max-500` — every source file's total line count must be ≤ 500. Exceptions require an inline-comment opt-out plus a §-numbered justification.
- `single-event-writer` — `db.insert(events)` allowed only in `src/engine/eventStore.ts`.
- `forbidden-failure-variants` — the `Failure` union's `kind` field may not contain `host_exec_failed` or any `host_*` variant.
- `writer-answerer-separation` — a source file may not import both `runWriter` and `runAnswerer` from `ProviderAdapter` (except the role dispatcher).

### §10.2 Why not Bun for v0

Bun's Rust rewrite is materially stable as of 2026-05, but the ecosystem of native-binding packages (dockerode, ssh2) has lingering compat issues for long-running daemon workloads. Node 24 LTS through 2028 buys us until v1 evaluation. The v0 decision is **Node 24**; the v1 re-evaluation is tracked in §20.

### §10.3 Why not OpenTelemetry for v0

Tanren's observability surface in v0 is: structured pino logs from each container + the event log in Postgres + the dashboard view. OpenTelemetry pays its cost (collector deployment, instrumentation discipline, sampling configuration) only at multi-host scale. v0 is single-compose-stack; OTel is v1 work when the first enterprise customer asks for OTLP export.

---

## §11 — Provider abstraction

### §11.1 The `ProviderAdapter` interface

```typescript
// src/engine/providers/types.ts

export type AgentKind = 'writer' | 'answerer';

export interface WriterAdapter {
  readonly kind: 'writer';
  readonly cli: 'claude' | 'codex' | 'opencode';
  runWriter(opts: {
    runner: RunnerHandle;
    prompt: string;
    workspace: string;
    env: Record<string, string>;
    timeoutMs: number;
  }): Promise<WriterResult>;
}

export interface WriterResult {
  diff: string;
  commits: Commit[];
  exitReason: 'completed' | 'timeout' | 'crashed' | 'token_limit';
  tokenUsage: TokenUsage;
  costRecord: CostRecord;
}

export interface AnswererAdapter<TSchema extends z.ZodTypeAny> {
  readonly kind: 'answerer';
  readonly cli: 'claude' | 'codex';   // opencode NOT a v0 answerer (no native schema enforcement)
  runAnswerer(opts: {
    runner: RunnerHandle;
    prompt: string;
    schema: TSchema;
    env: Record<string, string>;
    timeoutMs: number;
  }): Promise<z.infer<TSchema>>;
}

export type ProviderAdapter = WriterAdapter | AnswererAdapter<z.ZodTypeAny>;
```

The compile-time split (`WriterAdapter` vs `AnswererAdapter`) is what makes the §3 distinction structural. A function that wants to call a writer must have a `WriterAdapter`; a function that wants to call an answerer must have an `AnswererAdapter`. The type system refuses to mix them.

### §11.2 The three CLIs

**claude** (`claude-code` CLI):
- Writer mode: `claude --print --output-format text` — output is the model's text response (which includes any diffs the writer wrote inline; the writer is asked to also commit via `git`).
- Answerer mode: `claude --print --output-format json --output-schema <schema-file>` — structured JSON output validating against the provided schema.
- Auth: OAuth (device token, the canonical claude-max path) or Anthropic API key.

**codex** (`codex` CLI):
- Writer mode: similar, text streaming.
- Answerer mode: `codex --output-schema <schema-file>` — structured JSON.
- Auth: OAuth or OpenAI API key.

**opencode** (`opencode` CLI with multi-provider support — ZAI, Wafer, OpenRouter, Anthropic, OpenAI, local endpoints):
- Writer mode: JSONL event stream; writer's diff is extracted from the workspace, not parsed from the stream.
- **NOT an answerer in v0.** opencode does not enforce JSON schema natively. Post-v0, an "opencode answerer" can ship with an additional client-side schema-validation layer, but v0 explicitly excludes opencode from the answerer role.
- Auth: per-provider config file (`~/.opencode/opencode.json` or equivalent) plus API keys.

### §11.3 Cost resolution: the three models flow through one entry point

Per call:
1. Writer or answerer produces output.
2. The CLI's structured output includes a `usage` block (claude format) or equivalent (codex, opencode-provider-specific).
3. Tanren's per-CLI parser extracts `input_tokens`, `output_tokens`, `cached_tokens`.
4. Tanren classifies the pricing mode:
   - If the operator authenticated via API key → `per_token`. Cost = tokens × rate-from-tables.
   - If the operator authenticated via OAuth (subscription) → `subscription_window`. Cost = pro-rated share of the subscription fee, plus the window-percent-used signal from `ccusage`/`codexbar`.
   - If the provider is a local model endpoint → `opportunity_cost`. Cost = pro-rated share of the operator's declared monthly cost for the asset.
5. A `cost_records` row is inserted with all three fields populated honestly.

If for some reason the cost can't be resolved (CLI changed output format, ccusage isn't installed in the runner image, etc.), Tanren refuses to insert a placeholder. Instead, the task fails with `cost_resolution_failed`, the operator sees the failure, and they install the missing component. **There is no `legacy_unknown` cost source.** The CHECK constraint in §9.1 enforces this.

### §11.4 Routing per role

The operator configures, per-project, which CLI serves which role:

```toml
# project.toml
[providers.planner]    # an answerer role
cli   = "claude"
model = "claude-opus-4-7"

[providers.writer]     # a writer role
cli      = "opencode"
provider = "zai"
model    = "glm-5.1"
fallback = { cli = "opencode", provider = "wafer", model = "glm-5.1" }

[providers.checker]    # an answerer role
cli   = "codex"
model = "gpt-5-codex"

[providers.auditor]    # an answerer role
cli   = "claude"       # or codex; operator's choice
model = "claude-opus-4-7"
```

Routes are loaded at workflow-start, validated against the available CLIs in the runner image, and locked for the workflow's lifetime. Switching a route mid-workflow is forbidden — the same role uses the same CLI for the entire run, so cost attribution and provenance are clean.

---

## §12 — Operator surfaces

### §12.1 CLI

`tanren` is the thin host-side binary (per §6.4 Option B). Commands:

```
tanren init                     # First-time setup: launches the dashboard onboarding URL
tanren spec create              # Interactive: write a spec
tanren spec list                # List specs in the spec-DAG
tanren run <spec_id>            # Trigger a run for the given spec
tanren run "<inline-description>"   # Shorthand: create spec + run in one
tanren status [<run_id>]        # Show run status (live updates)
tanren tail <run_id>            # Follow event stream
tanren cancel <run_id>          # Cancel an in-flight run
tanren retry <run_id>           # Re-run from the last failed task
tanren dashboard                # Open the web dashboard
tanren doctor                   # Health check the compose stack
tanren version                  # Print tanren version + orchestrator version
```

The CLI talks to the orchestrator container over a Unix-domain socket (mounted by compose into a host directory the CLI looks at, e.g. `/var/run/tanren.sock`) or over localhost HTTP. Either is configurable.

### §12.2 Web dashboard

Served by the `dashboard` service in compose. Pages:

- **Home**: list of recent runs, current spec-DAG status, cost dashboard (the three models), runner pool status.
- **Spec view**: a single spec's full event timeline, all tasks, all diffs, all answerer outputs.
- **Cost dashboard**: real dollar burn (model 1), utilization charts (model 2), window pressure with reset times (model 3).
- **Projects**: list, add, edit (v0: limited editing; v1: full).
- **Onboarding**: §8.4 flow.
- **Settings**: ntfy topic, cloudflared tunnel, allocator config, role routes.

HTMX for interactivity. Hono+JSX for server-rendering. Reads Postgres directly via Drizzle. No SPA.

### §12.3 Notifications (ntfy)

v0 includes ntfy.sh as a compose service. Operator configures their topic, and:

- Run completes (PR merged or failed) → notification.
- Run needs human review (the `review_required` poll started) → notification.
- Allocator failure (Hetzner couldn't provision, local Docker daemon unreachable) → notification.
- Budget threshold crossed (per-task or per-day cap) → notification.

The `notifications` table in Postgres is the outbox; the ntfy delivery worker reads from it.

Slack, Discord, email: v1+.

---

## §13 — Onboarding (the operator's first hour)

This is what "v0 works for solo-builder" means concretely:

1. Operator runs `docker compose up`. Compose pulls the prebuilt images from `ghcr.io/cat-cave/tanren-*`. Postgres initializes; Vault generates a root token (stored in a docker secret); orchestrator and dashboard come up healthy.
2. Operator opens `http://localhost:3000`. Lands on the onboarding page.
3. Onboarding flow (§8.4): provider auth, GitHub auth, first project.
4. Operator runs their first spec from the CLI: `tanren run "add a /healthz endpoint that returns {ok: true}"`. Or via the dashboard: paste the description, click "Run."
5. Tanren provisions a runner (per project config; defaults to `local-docker`), runs the workflow, opens a draft PR.
6. Operator gets a notification (ntfy) when the PR is open.
7. Operator reviews the PR in GitHub, approves, Tanren merges.

The operator never installed claude-code, codex, opencode, ccusage, codexbar, or any LLM tooling locally. They installed Docker. That is the entirety of host-side dependencies.

---

## §14 — Acceptance gate (v0 ships when…)

There is no time-gate. v0 ships when **the full workflow above produces merged PRs against three real repos**, with verifiable correctness:

### §14.1 The gate

A fresh operator on a fresh `cat-cave/tanren` clone, after running through the onboarding flow, can:

1. Register a project pointing at a real repo they own (`cat-cave/tanren-fixture-easy`, `cat-cave/tanren-fixture-medium`, `cat-cave/tanren-fixture-hard`).
2. Submit a spec for each of the three projects.
3. For each: planner → writer/checker per subtask → auditor → draft PR → CI green → review (or auto-merge if policy permits) → merged PR.
4. All three runs visible in the dashboard with full event traces, full cost records (with at least one cost record per role, all with real `cost_source` values), full runner provenance.

**The gate passes when this works on three real repos, end-to-end, without operator intervention between steps within a run.** Time per run is not gated; reliability is.

### §14.2 The three fixture repos

- **`tanren-fixture-easy`**: minimal HTTP server (Node, Python, or Go); spec is "add a /healthz endpoint." Acceptance: PR opens, CI green, merged.
- **`tanren-fixture-medium`**: small CLI tool with a test suite; spec is "add support for `--verbose` flag with extra output." Acceptance: PR opens, CI green, merged, the new flag works in manual smoke test.
- **`tanren-fixture-hard`**: small full-stack app; spec is "add a per-user rate limit to the API endpoint." Acceptance: PR opens, CI green, merged, the rate limit actually limits in manual smoke test.

These are deliberately small and unambiguous. Larger / more-ambiguous specs are post-v0 territory.

### §14.3 The fallback if the gate doesn't pass

If repeated runs show the workflow getting stuck at a specific step, the diagnostic is in the event log. The remedy is per-step:

- Planner step fails repeatedly → the planner's prompt template is wrong, or the spec is too vague. Iterate on the planner prompt.
- Writer step produces no diff → the writer's role config (CLI, model) is wrong for the task. Iterate on the route.
- Checker step says "not done" for valid work → the checker's prompt or schema is wrong. Iterate.
- Auditor step never approves → the spec's acceptance criteria are unstated or too strict. Iterate.

The gate is **the workflow's quality bar**, not a stress test of the infrastructure. If the infrastructure works (containers spin up, SSH connects, agents run, PRs open) and the workflow doesn't converge, the diagnosis is at the workflow layer.

---

## §15 — Testing and quality

### §15.1 What we test

- **Unit tests** for every pure function in `src/engine/*`: cost-resolution arithmetic, schema validation, queue dispatch logic, allocator argument-building, prompt-template rendering. Vitest. Coverage gate ≥ 80% on these files.
- **Integration tests** for the substrate: spin up a runner, SSH in, exec a command, capture diff, release. Mock LLM responses but real Docker. Test against `local-docker` allocator in CI.
- **Contract tests** per CLI: pinned fixtures of real claude/codex/opencode output, parse them, assert the parser doesn't throw or misclassify. Run against the published runner image.
- **End-to-end tests** against the three fixture repos. Real LLM calls (CI-budget-gated, runs once per release tag). Asserts the full workflow.
- **Regression tests** from `audits/F-01 … F-36`. Each finding becomes a test that asserts the failure mode is structurally impossible.

### §15.2 What we don't test (and what we honestly admit)

**Semantic correctness of writer output is not tested by Tanren.** That is the answerer's job. Tanren tests that the answerer ran, returned valid JSON, and the auditor's verdict was honored. Whether the writer wrote *correct* code for an arbitrary natural-language prompt is an open research problem; Tanren delegates it to the answerer agents.

The auditor's verdict is the quality bar. The acceptance gate (§14) requires the auditor to approve. If the auditor approves bad code, that is a prompt-template bug (or a model-capability gap), tracked as a workflow-quality issue, not an infrastructure issue.

### §15.3 The audit findings as a regression-test corpus

`audits/F-01 … F-36` from the n8n-autocoder predecessor are lifted into Tanren as a `tests/regression/` directory. Each finding becomes a test (or a structural property — many findings are now structurally impossible because the substrate / type system makes them impossible). The CI `regression-tests` gate fails if any of these tests regress.

### §15.4 The 500-line file lint

The custom oxlint rule `file-line-max-500` is itself a quality bar: a file approaching 500 lines should be split. The rule is mechanical; refactoring under the threshold is the operator-developer's job. The rule's purpose is to prevent the monolithic files that produced the n8n-autocoder's worst maintainability problems (`events.ts` at 2900 lines, `run-dag-node.json` at 4155 lines).

---

## §16 — Budget enforcement

Costs include both agent costs AND infrastructure costs. Hetzner VMs are not free; an enterprise that provisions 50 VMs to run parallel workflows is paying real money for compute, separate from LLM costs.

### §16.1 What gets budgeted

- **LLM agent costs**: every `cost_records` row contributes. Per-task and per-day caps are enforced PRE-call (the budget gate refuses to spawn a writer/answerer if the cap would be exceeded).
- **Infrastructure costs**: for cloud allocators (Hetzner now; AWS/GCP/etc. later), every provisioned VM contributes to a separate `infra_costs` row. Per-day caps apply.
- **Combined per-project budget**: operator can set a per-project monthly cap that covers both agent + infra spend. Exceeding the cap pauses new runs (existing runs complete, no new ones start).

### §16.2 Where the budget UI lives

The dashboard has a Budgets page that shows:

- Current spend (this month, this week, today) per project, broken down by agent vs infra.
- Configured caps per project (per-task, per-day, per-month).
- Projected burn rate vs cap.

Editing caps is a v1 feature (operator edits via dashboard); v0 reads caps from `project.toml` and refuses to override without an explicit operator-initiated edit.

### §16.3 The cost-resolution-failed contract

Per §11.3: if a writer or answerer call cannot be cost-resolved (provider didn't return usage info, ccusage uninstalled in runner, codexbar broken, etc.), Tanren does NOT silently insert a placeholder cost record. The task fails with `cost_resolution_failed`, the operator sees it, the operator fixes it. The `cost_records.cost_source` CHECK constraint mechanically prevents `legacy_unknown` from being inserted.

---

## §17 — Migration

### §17.1 The new home: `cat-cave/tanren`

The first concrete action of v0 is to migrate `trevorWieland/tanren` to `cat-cave/tanren`. GitHub's repo-transfer feature handles the redirect; existing clones continue to work via the redirect.

After transfer:
1. Open a fresh branch on the migrated repo: existing main (the Rust attempt) is archived to `archive/v2`, and a new `main` is started empty.
2. Add `PROJECT_BRIEF.md` (this document) as the first commit.
3. Scaffold the compose stack and the orchestrator's TS source per §18.

### §17.2 What carries forward from `n8n-autocoder` and prior `tanren`

| Source | Status |
|---|---|
| `n8n-autocoder/audits/F-01 … F-36` | Lifted as regression-test corpus (§15.3). |
| `n8n-autocoder/custom-nodes/.../shared/costSources/*` | Lifted to `src/engine/cost/sources/`. Cleanest part of the n8n-autocoder. |
| `n8n-autocoder/custom-nodes/.../shared/githubApp.ts` | Lifted to `src/engine/providers/github/installationToken.ts`. |
| `n8n-autocoder/custom-nodes/.../exec/SSHExecAdapter.ts` + `sshPool` + `sshTransport` + `remoteAuthProvisioner` | Lifted to `src/engine/substrate/`. These ARE the substrate. |
| `n8n-autocoder/custom-nodes/.../shared/hcloud.ts` | Lifted to `src/engine/allocators/hetzner.ts`. |
| `n8n-autocoder/custom-nodes/.../prompts/*` and `schemas/*` | Lifted to `src/prompts/`. |
| `tanren/v2/<various>` (Rust) | Reference only. Concepts (behaviors, equivalent-operations rule) inform the v3 design. |
| `quikode/quikode/agents/json_protocol.py` | Conceptual ancestor of the WriterAdapter/AnswererAdapter split. Lift the IDEA, write fresh in TS. |
| `quikode/quikode/retry_classify.py` | Conceptual ancestor of the `Failure` discriminated union's classifier. |
| `quikode/quikode/evaluation_contract.py` | Conceptual ancestor of the spec's acceptance-criteria contract. |
| `tanren/v1/packages/tanren-core/src/tanren_core/dispatch_orchestrator.py` (recovered from git history) | Concepts (concurrent execute, teardown guards) inform the orchestrator design. |
| All n8n workflow JSON | NOT lifted. |
| All n8n custom-node packaging | NOT lifted. |
| All host-side scripts | NOT lifted. |

### §17.3 The old n8n-autocoder

The n8n-autocoder remains in its own repo as the predecessor. Tanren v3 is a fresh start, not a refactor of n8n-autocoder. No cutover is required — the user can use n8n-autocoder for as long as they want, or never again. Tanren v3 is the new platform.

---

## §18 — File and directory layout

```
cat-cave/tanren/
├── PROJECT_BRIEF.md           # This document (durable artifact)
├── ROADMAP.md                 # The implementation roadmap (separate doc)
├── compose.yml                # The full docker compose stack
├── compose.override.example.yml  # Optional local overrides
├── README.md
├── LICENSE
├── .github/
│   └── workflows/             # CI: lint, typecheck, test, build images
├── services/
│   ├── orchestrator/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── engine/
│   │   │   │   ├── eventStore.ts
│   │   │   │   ├── queue.ts
│   │   │   │   ├── failure.ts
│   │   │   │   ├── workers/
│   │   │   │   ├── providers/
│   │   │   │   ├── substrate/
│   │   │   │   ├── allocators/
│   │   │   │   ├── cost/
│   │   │   │   ├── credentials/
│   │   │   │   ├── notifications/
│   │   │   │   └── observability/
│   │   │   ├── api/        # Internal RPC surface for CLI/dashboard
│   │   │   ├── prompts/
│   │   │   └── main.ts
│   │   └── tests/
│   ├── dashboard/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── views/
│   │   │   └── main.ts
│   │   └── tests/
│   └── secret-manager/        # If we use a custom shim over Vault; otherwise this dir doesn't exist
├── runner/
│   ├── Dockerfile             # The base tanren-runner image
│   ├── entrypoint.sh
│   └── README.md              # Build-from instructions for project-specific images
├── cli/
│   ├── package.json
│   ├── src/
│   │   └── main.ts            # Thin host-side CLI
│   └── tests/
├── db/
│   ├── schema.ts              # Drizzle schema
│   └── migrations/
├── docs/
│   ├── architecture/
│   ├── operator-guide/
│   ├── audits/                # F-01 … F-36 lifted
│   └── design/
├── fixtures/                  # The three fixture repos (or refs to external repos)
│   ├── tanren-fixture-easy/
│   ├── tanren-fixture-medium/
│   └── tanren-fixture-hard/
└── scripts/                   # Helper scripts (build, publish, etc.)
```

Every source file is bounded to 500 lines (§10.1). Every service is its own Dockerfile-rooted package.

---

## §19 — Considered and rejected

| Option | Why rejected | Conditions to revisit |
|---|---|---|
| Host-process execution (any tier, any condition) | Security invariant (§1.2.1). Autonomous LLM agents writing code MUST be sandboxed. | Never. |
| Auto-discover local credentials (~/.config/claude, ANTHROPIC_API_KEY envvar) | Anti-pattern. Works for one user, breaks for two. Breaks remote execution. Breaks rotation. | Never. |
| SQLite as v0 default | One backend (§1.2.2). SQLite + Postgres dual-backend means code-paths-that-only-work-on-one. | Never for v0; v1+ might re-evaluate at scale if Postgres becomes overkill for embedded deployments. |
| MCP server in v0 (stdio or HTTP) | STDIO MCP is a trap (no auth, no observability, can't be reached from a second client). HTTP MCP requires an HTTP API to exist first. | When HTTP API ships (v1). |
| HTTP API in v0 | The CLI is sufficient for v0. API adds attack surface, auth, rate-limiting, versioning. | v1 with the dashboard's API consumers. |
| Time-gated acceptance | v0 builds the workflow; speed comes later. | Never re-introduce a time gate to v0. |
| Hybrid agents (one agent does both writing and structured-output reporting) | §3.4: workflow brittleness compounds. | Never. |
| Hard-coded concurrency limits (e.g., "3 codex CLIs max") | §1.2.7: real limits or no limits. | Never. |
| Bind-mounted credentials | §1.2.3: credentials live in the secret manager; transport per-session via SSH. | Never. |
| Bind-mounted worktrees | §7.3: agent code lives in the runner's filesystem. | Never. |
| One container per subtask | §7.2: workflows span containers via remote-SCM checkpoints. Per-subtask containers prevent in-workflow state continuity. | Never. |
| Bun in v0 | §10.2: ecosystem still has compat gaps for long-running daemon workloads as of 2026-05. | v1 re-evaluation. |
| Prettier in v0 | oxfmt is the 2026 standard, pairs with oxlint. | Never re-introduce. |
| BullMQ / Redis | Postgres has SKIP LOCKED + LISTEN/NOTIFY; no extra service required. | When team-builder hits Postgres queue throughput limits AND an observation in the event log shows it (not before). |
| Effect / neverthrow / ts-pattern | Plain discriminated unions with tsgo exhaustiveness are enough. | When a documented case shows the plain pattern frays. |
| OpenTelemetry in v0 | Event log + dashboard + pino are sufficient. | When first enterprise customer requires OTLP export. |
| Slack / Discord integrations in v0 | ntfy covers v0; chat-surface integrations are team-builder features. | When team-builder names chat as the primary notification surface. |
| schema_version column enforcement | Nobody reads it in any prior attempt. | When v1 has a second-version emitter and a read-side dispatch on the version. |
| opencode as a v0 answerer | No native JSON-schema enforcement; would require client-side schema validation that costs more than it saves at v0. | When client-side schema-validation contract is in place AND operator names opencode as preferred answerer. |
| n8n + TS DSL | Doesn't solve the observation problem; misaligned with the platform-not-workflow-engine framing. | Never. |
| Tanren-as-a-claude-code-replacement framing | Tanren is a platform, not a CLI swap. | Never re-introduce. |
| Workflow simplification (skipping planner / checker / auditor steps in v0) | §2.3: each step is load-bearing for arbitrary-task reliability. | When workflow-quality telemetry shows a specific step adds no value for a given project. |
| Time-to-first-PR (TTFPR) metric | Not meaningful for arbitrary tasks; only relevant for trivial canonical fixtures. | Never re-introduce as a primary v0 metric. |

---

## §20 — Open issues

These are decisions held open at brief-finalization. Each must be resolved before the relevant spec begins.

1. **Secret manager: Vault vs pgcrypto.** Vault is the right answer for v1+ scale, but adds a service to the compose stack. pgcrypto is simpler for v0 (no new service) but requires careful master-key management. Decision: probably Vault, but a final A/B writeup is owed.

2. **CLI distribution: Bun-script vs Go binary vs Node-bundled.** The CLI is a thin client; any of three works. Go gives the smallest distributable; Bun gives a single-file-script ergonomics; Node-bundled gives ecosystem consistency. Decision held; not a v0 blocker.

3. **Bun re-evaluation timing.** Bun's Rust rewrite is stable as of 2026-05, but native-bindings ecosystem for dockerode/ssh2 is in flux. The v0 default is Node 24; a re-evaluation is scheduled for first v0+1-month milestone.

4. **Workflow variation per-project.** The v0 spec ships ONE canonical composition (planner → writer/checker per subtask → auditor → PR). Projects with different needs (e.g., "we don't want the planner step for trivial typo fixes") will want overrides. The seam for that exists in the role-routing config but the per-project workflow-shape config is v1.

5. **Fixture repos: external or in-tree.** Should `tanren-fixture-easy/medium/hard` live as external repos (Tanren operates on them as it would a customer repo) or in-tree (faster CI loops)? Probably external for realism, in-tree mirror for CI speed.

6. **Per-spec acceptance criteria language.** The spec table includes `acceptance_criteria JSONB`. The schema for that JSONB is open: structured rule list? Free-text? A mix? The planner answerer's prompt template depends on this; final shape decided when the planner spec is written.

7. **Cancellation semantics.** `tanren cancel <run_id>` must clean up: cancel the SSH session, destroy the runner container, mark the run cancelled, emit a notification. The interaction with in-flight writer subprocesses (which are inside the runner) needs to be precisely specified.

---

## §21 — Roadmap construction notes

This brief describes WHAT, WHY, and HOW at the design level. The next deliverable is **`ROADMAP.md`**: an implementation fanout strategy with specs, descriptions, dependencies, and validation criteria, designed for subagents in parallel worktrees to execute concurrently.

### §21.1 Roadmap principles

- **No time estimates anywhere.** The roadmap describes work, not when work happens.
- **Every spec declares: what it produces, what it consumes, who depends on it, how it is tested.** Specs are nodes in a DAG.
- **Specs are bounded to subagent + worktree execution.** Each spec describes which files it owns (so concurrent worktrees don't conflict), which contracts it provides upstream (so dependent specs can build against it), and which dependencies it consumes downstream (so it can be parallelized with peer specs).
- **Each spec has a verification approach.** Not just "the code compiles" but "the integration test in `tests/...` passes" or "the contract test against the fixture repo runs green."

### §21.2 Roadmap implementation strategy

The roadmap is built in two phases:

**Phase A — Component proof-of-function.** Each substrate component (Postgres + Drizzle schema, secret manager, orchestrator queue, substrate adapter, allocator implementations, provider adapters, dashboard skeleton, CLI skeleton) is built as a standalone deliverable, with a smoke test that proves it works in isolation. This phase is highly parallelizable: many specs can execute concurrently in different worktrees because they touch different services and different files.

**Phase B — Workflow assembly.** The components from Phase A are wired together into the minimum viable workflow (§2). This phase is more sequential — the workflow imposes ordering on which components must integrate first. Spec dependencies are explicit in the roadmap.

The acceptance gate (§14) is the end of Phase B. The three fixture repos run end-to-end.

### §21.3 Spec template (preview)

Each spec in `ROADMAP.md` will look like:

```markdown
## SPEC-XXXX — <slug>

**Phase**: A | B
**Owns**: list of file paths this spec produces
**Consumes**: list of SPEC-XXXX dependencies (must be done first)
**Produces**: list of contracts / files / capabilities other specs can consume

**What**: 1-paragraph description of what this spec builds.
**Why**: 1-paragraph reference to the PROJECT_BRIEF section that motivates it.
**How**: implementation approach; key decisions; rationale.

**Test plan**: how the spec's verification works (unit, integration, contract).
**Quality bar**: what counts as "done" beyond tests passing.
**Real-functionality validation**: what observable, non-test behavior proves this works in production.

**Worktree-isolation safety**: which directories this spec exclusively writes to, so a parallel worktree on a peer spec can't race.
```

This template is materialized in the roadmap doc; the brief just declares its shape.

---

## §22 — Version verification (as of 2026-05-21)

Every version pin verified against current community consensus.

| Tool | v0 pin | Source |
|---|---|---|
| Postgres | 18 (18.4 patch released 2026-05-14) | postgresql.org news |
| Docker Engine | 29.x (29.5.1 released 2026-05-18) | docs.docker.com release notes |
| Node.js | 24 LTS (Active through 2028) | endoflife.date/nodejs |
| pnpm | 11.1.x | pnpm.io |
| tsgo / TypeScript | 7.0 stable (Jan 2026) | microsoft/typescript-go |
| Drizzle | 0.45.x stable | orm.drizzle.team |
| Zod | 4.x | npmjs.com/package/zod |
| oxlint | 1.x stable since June 2025 | oxc.rs |
| oxfmt | 1.0 stable | oxc.rs |
| Vitest | 3.x | vitest.dev |
| Hono | 4.12.x | hono.dev |
| HTMX | (vendored, 2.x) | htmx.org |
| dockerode | 5.0.x | npmjs.com/package/dockerode |
| ssh2 | 1.17.x | npmjs.com/package/ssh2 |
| pino | 9.x | getpino.io |
| MCP SDK | (deferred to v1) | modelcontextprotocol.io |
| Hashicorp Vault | 1.18.x | hashicorp.com/products/vault |
| ntfy.sh | 2.x | ntfy.sh |
| Cloudflared | current | cloudflare.com |

A `scripts/check-pin-rot.sh` runs quarterly and emits a soft CI advisory when a pin is more than 12 months behind upstream. The operator decides whether to bump.

---

## §23 — Receipts

- `audits/F-01 … F-36` (n8n-autocoder smoke test findings) — lifted as `tests/regression/` corpus.
- Prior `n8n-autocoder/docs/redesign/draft-architecture.md` — superseded by this brief.
- Prior `n8n-autocoder/docs/redesign/draft-ux.md` — concepts and onboarding flow lifted into §13, §12.
- Prior `n8n-autocoder/docs/redesign/draft-stack.md` — §10 lifts the table.
- Prior `n8n-autocoder/docs/redesign/draft-critique.md` — concerns are folded; the brief is the answer.
- Prior `PROJECT_BRIEF.md` (the n8n-autocoder rewrite version, deleted 2026-05-21) — superseded by this rewrite.
- `tanren/v1` (Python predecessor, recovered from git history) — adapter shapes lift; design rejected.
- `tanren/v2` (Rust predecessor) — design rejected; concepts (equivalent-operations rule, behaviors-as-IDs) inform v3.
- `quikode/` (Python pre-predecessor) — JsonAgent transport / failure_layer / evaluation contract concepts inform v3.

---

*— PROJECT_BRIEF.md for Tanren v3, written 2026-05-21. This document is the durable contract. ROADMAP.md takes it from here.*
