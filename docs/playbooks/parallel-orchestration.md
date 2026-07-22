# Playbook — driving Tanren forward with parallel agents

This is the durable, tool-agnostic playbook for how a coding agent (or a human
coordinating several) should drive substantial work on this repo: many units in
parallel, each landing as its own reviewed, CI-green PR, without stepping on
itself. It is written so a **non-Claude** agent can follow the same shapes
manually; where a capability is specific to the Claude Code harness it is called
out, always paired with the generic fallback and the _purpose_ it serves, so the
intent survives the tool.

The north star: **the codebase is the source of truth.** Anything an orchestrator
"knows" that isn't in the repo is a liability. Work in a way that leaves the repo
self-describing — a fresh clone on another machine can be picked up cold.

---

## Scope & lifespan — this is bootstrap-era strategy

This playbook describes the **interactive** way humans and agents drive Tanren's
development _today_, while Tanren is being built up to the point where it can build
itself. It is a means to an end, not the end.

**Once Tanren can maintain Tanren** (the path is in `docs/roadmap/dogfooding.md`),
this manual orchestration is **superseded.** The platform itself becomes the
orchestrator — the DagWalker plans and schedules the work, the native intelligent
merge queue coordinates the PRs, and worktree-per-run isolates execution — and it
does so with far more capacity, parallelism, and consistency than a human-driven
interactive loop ever could. The disciplines below (disjoint slices, a worktree
and PR per unit, verify-against-code, monitor discipline, sweep-on-delete) are
exactly the behaviors Tanren already embodies natively; this doc is how a _human +
assistant_ approximate them by hand until the self-hosting handoff.

So treat this as the **scaffolding for the bootstrap**. Until Tanren handles
Tanren, it is the live discipline that keeps the build clean. After that handoff it
becomes a historical record of how the bootstrap was done — not a procedure anyone
still runs by hand.

---

## The non-negotiable rules

These are learned the hard way; violating them costs more than the work itself.

1. **One unit of work per PR, each through full CI.** The gate (`just ci` +
   `just smoke` for stack changes) is the arbiter, not the agent's confidence.
   Never merge without green CI and up-to-date-with-`main`.

2. **Parallel work runs in isolated git worktrees — one per agent.** An agent that
   edits the shared working tree while another is mid-edit _will_ collide. Every
   code-producing agent gets its own worktree (own branch, own checkout).
   - _Claude-specific:_ spawn subagents with `isolation: "worktree"`.
   - _Generic fallback:_ `git worktree add ../wt-<task> -b <branch>` per agent;
     each runs in its own directory.
   - _Local convention (this box):_ worktrees live under
     `/scratch/worktrees/tanren/<name>` — the 8TB RAID0 NVMe scratch mount is
     faster than the boot drive, and `/tmp` is explicitly NOT used (slower,
     boot-drive-bound). On other boxes, any fast-disk path is fine.

3. **Fan out only over DISJOINT file sets.** Two agents that touch the same file
   produce merge conflicts and lost work. Before fanning out, partition the work
   by path so no two agents own the same file. If a file is genuinely shared
   (e.g. `package.json`, `justfile`, a migration, a nav registry), that work is
   **serial** — one agent, or do it yourself. Disjoint slices merge in any order.

4. **A delete must be paired with a repo-wide reference sweep.** Deleting a file
   (a doc, a module) leaves dangling references — imports, links, comments,
   allow-lists. Either the deleting change also repoints every referrer, or you
   schedule an explicit cleanup pass in the same wave. `git grep` the deleted path
   to prove zero references remain before declaring done.

5. **Verify against reality, not against documents or memory.** Status docs go
   stale; comments lie; an orchestrator's recollection drifts. Confirm every claim
   against the actual source, `git log`, tests, and CI before acting on it.

6. **Clean up after yourself.** Merged worktrees and branches accumulate into
   gigabytes and orphaned refs. After merging, prune the worktree
   (`just prune-worktrees`) and delete the merged branch.

---

## The workflow shapes

Pick the shape that fits; compose them. Each is described generically — the
Claude harness has a `Workflow` primitive that encodes them deterministically, but
the shape is what matters, and any agent can run it by hand.

### Understand → map

Parallel readers over independent subsystems, each returning a structured summary;
combine into one map. Use before touching code you don't fully know.

### Audit → synthesize → execute → cleanup

The backbone for any large change (a doc sweep, a refactor, a migration):

1. **Audit** — fan out read-only agents over disjoint territories (with deliberate
   _overlap_ on the highest-value areas so gaps get caught), each **verifying
   against code** and returning concrete findings.
2. **Synthesize** — one agent (or you) merges the findings into a single,
   code-grounded plan: the true current state + the exact per-file actions. Write
   the plan to a file the executors read, so they stay consistent.
3. **Execute** — fan out over the disjoint slices of the plan; each produces a
   CI-green PR.
4. **Cleanup** — the reference sweep (rule 4), prune worktrees/branches, verify
   the end state (`git grep` for danglers, run the full gate).

### Adversarial / independent verification

For findings that matter (bugs, security, "is this real?"), spawn an _independent_
verifier prompted to **refute** the claim, ideally several with different lenses
(correctness, security, does-it-reproduce). Majority-refute kills the finding.
This catches plausible-but-wrong conclusions that a single pass — and green CI —
miss. Several real merge-safety bugs in this repo were caught this way, not by CI.

The strongest independent verifier is a **different model**. The implementer's
own blind spots survive its own review; a second model with a different training
prior does not share them. So the preferred critic is the cross-model lane below,
not another instance of the implementer.

### The cross-model critic / triage lane (Codex)

A second model is used as a first-class lane alongside the primary implementer:
the implementer writes the code; an independent critic refutes it. In this repo
that critic is **Codex (GPT-5.5) via `codex exec`** — the implementer is strong at
building, the critic is strong at catching what the builder missed. Four uses:

- **Critic** — adversarial, _refute_-prompted review of a diff or a finding,
  before merge. Cite `file:line`, classify BLOCKING vs non-blocking, end with a
  SHIP/FIX-FIRST verdict. (The live-validation "critic arc" records three independent
  critic rounds coming back clean; it is contributor process evidence, not an
  apex-specific engine proof.)
- **Triage / root-cause** — when a run or CI fails, the critic investigates the
  root cause independently rather than the implementer re-reading its own work.
- **Lull-audit** — during downtime, sweep for _negative implementations_ (silent
  fallbacks, legacy/back-compat, weak lint rules, sloppy error handling,
  deploy-config-vs-userland-config violations); surfaced items become queued work.
- **Forward-look** — audit loops no run has exercised yet (issue-triage, deploy,
  scheduled tasks) to surface gaps _before_ a live run wastes a full push hitting
  an obvious bug.

Run it read-only and backgrounded so it can't mutate the tree and the watch is
harness-tracked:

```sh
codex exec -s read-only --skip-git-repo-check - < prompt.txt > out.md 2>&1
```

It streams its reasoning, so the structured report is at the _tail_ of the output
and the file can exceed read limits — grep for the section headers rather than
reading the whole file. _Generic fallback:_ any second-model CLI (or a human
reviewer with a different mental model) prompted to refute serves the same intent;
the point is **independence of perspective**, not the specific tool.

### Loop-until-dry

For unknown-size discovery (dead code, bugs, edge cases), keep spawning finders
until _K_ consecutive rounds surface nothing new. A fixed count misses the tail.

---

## Monitor discipline

Long-running work (CI runs, live agent runs, deploys) must be watched **without
silent polling**:

- **Harness-tracked + completion-notified.** Start the watch so the system wakes
  you when it finishes, rather than blocking or guessing.
  - _Claude-specific:_ background `Bash`/`Agent` tasks notify on completion;
    `ScheduleWakeup` for timed re-checks.
  - _Generic fallback:_ a backgrounded script that writes a result file and exits;
    poll it on a bounded cadence.
- **Strictly timeout-bounded.** Every monitor has a hard cap and reports
  `TIMED OUT` rather than hanging forever. A PR that never goes green must surface,
  not silently stall the whole effort overnight.
- **Alert on failure.** On CI failure / `needs_attention` / a stall, emit a loud,
  visible signal — do not let a red result sit unseen.

**Milestone notifications (ntfy etc.).** Pushing a ping to an external channel
(e.g. `ntfy.sh/<topic>`) on a _major_ milestone — a run reaching v1, a long CI
finally going green, a human-decision escalation — is a useful operator
convenience for unattended work. It is **subject to operator opinion**: some
operators want it, some find it noisy. Treat it as an opt-in courtesy on
significant events, not a hardcoded behavior, and keep the _what counts as major_
list short. (In the Claude harness this can be a Stop/Notification hook in
`settings.json` so it fires automatically; manually, it's a `curl` at the end of a
monitor.)

---

## Sizing: when to fan out vs. just do it

Fanning out has real overhead (worktree setup, coordination, N PRs to shepherd).
It pays off when the work is **large and partitionable into disjoint slices**.
It does NOT pay off — and often backfires — when:

- The change is small, or the pieces are interdependent (shared config, a single
  module). Do it yourself, serially, on one branch.
- The slices would overlap on files (rule 3). Re-partition, or serialize.
- The task needs sustained judgment/context you hold and can't cheaply transfer.

Default to the smallest structure that fits. A two-file change is a single commit,
not a workflow.

---

## Claude-specific capabilities → generic intent

| Capability (Claude Code)                               | Purpose it serves                                       | Generic fallback                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Worktree-isolated subagents                            | Parallel writers that can't collide                     | `git worktree add` per task; one process each                                                      |
| `Workflow` (deterministic fan-out / structured output) | Encodes audit→synthesize→execute with validated returns | A driver script (any language) that shells out to N agent invocations and parses their JSON        |
| Background tasks + completion notifications            | Watch CI/runs without blocking or silent polling        | Backgrounded script → result file → bounded poll                                                   |
| Persistent file-based memory                           | Carry durable preferences/decisions across sessions     | A checked-in `docs/` note or a local scratch file — but prefer putting durable facts _in the repo_ |
| `ScheduleWakeup` / timed re-entry                      | Re-check external state on a cadence                    | `sleep`/cron + a re-run                                                                            |
| Structured task list                                   | Track multi-step progress visibly                       | A markdown checklist                                                                               |

The deeper point: these are **conveniences over a spine Tanren itself must own.**
A self-hosting Tanren can't assume a Claude harness — it re-implements the same
intent natively (the DagWalker is the orchestrator, the native merge queue is the
PR coordination, worktree-per-run is the isolation). When extending Tanren, prefer
putting the capability _in Tanren_ over relying on the operator's harness.

---

## Anti-patterns (observed failures)

- **A subagent without worktree isolation shares the main tree** and collides with
  whatever else is editing it. If you must use a non-isolated helper, do not edit
  concurrently — hand off serially.
- **Parallel deletes without a reference sweep** leave a trail of dead links.
- **Trusting a planning doc's "status"** — build plans describe intent at a point
  in time; the code is what shipped. Re-verify.
- **Letting branches/worktrees accumulate** — prune on merge; a periodic reaper
  catches the rest.
- **Silent monitors** — a watch with no timeout and no failure alert turns a
  five-minute CI hiccup into a lost night.

---

## The one-line version

Partition into disjoint slices → a worktree + a PR per slice → verify against code,
not docs → watch with bounded, alerting monitors → sweep references on delete →
prune on merge → leave the repo speaking for itself.
