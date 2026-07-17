<!-- cspell:ignore rootlessport regen -->

# Mission-complete orchestration playbook

How a **no-code root orchestrator** drives the 142 consumer nodes to merge, fast,
across Claude native subagents **and** shelled-out codex / grok / opencode — without
the convergence thrash that throttled the first attempt.

Read alongside: `README.md` (the mission), `LEDGER.md` (live status, the source of
truth), the per-node `nodes/*.md` specs + `nodes/cards/*.md`.

---

## 0. Why the first attempt was slow (the failure to design against)

It was **not** lane starvation. It was **convergence thrash**:

- Every node was pinned to an exact base SHA. `main` moved, so the node was
  **re-audited at each new SHA** (restack → re-audit → repair → re-audit). One node
  (gv-1) burned **13** prompt rounds this way.
- The same node got 5–13 adversarial audits because each finding triggered a repair
  that triggered a fresh audit against a fresh base.
- Serialized barriers (event-vocab freeze waves, migrations, `screens.ts`/nav) were
  hand-run as multi-PR ceremonies **inline with** consumer work, so they blocked the
  fan-out instead of clearing the runway ahead of it.

The whole design below exists to make **each node land in one audit pass against a
stable base**, and to **front-load all serialized work** so consumer lanes are truly
disjoint.

## 1. The rules

### Rule 0 — Keep each node light (≤ ~1000 lines); chain, don't bloat

A node is a **PR-sized** unit of work: target **≤ ~1000 changed lines**. If a node
wants more, either **break it into a chain of smaller PRs** (each independently
reviewable + auditable, stacked so they flow through the gate fast) or **justify the
size explicitly** in the card (why it can't be split — e.g. an irreducible foundation
that establishes shared vocabulary). Big entangled PRs are the enemy of throughput:
they take a slow, high-risk single audit and they block everything stacked behind
them. Prefer many small green PRs landing back-to-back over one 400-file slab.

> **Precedent:** in-1 (the integrations foundation) landed at ~382 files / +45k —
> the **justified exception**, because it establishes the whole `integration_*`
> vocabulary + RLS backbone that in-2..22 consume. It also, tellingly, bundled
> _global spine-lineage FKs_ that broke an out-of-card smoke test — exactly the
> cross-cutting blast radius a light node avoids. Going forward: a node that needs a
> cross-cutting spine change (a shared FK, a global invariant) **splits that change
> into its own serialized migration/prep PR** rather than folding it into a feature
> node. Chain PRs flow; slabs stall.

### Rule 1 — Barrier pre-flight (one serialized prep PR per wave)

Before any fan-out, a **single** prep PR claims everything shared for the whole wave:
the migration slot(s) (next free `0043+`), every event-vocab freeze the wave's nodes
emit, and any `screens.ts` / nav / `main.ts` edits. Merge it first. Consumer cards in
that wave then touch **zero** barriers → they are genuinely path-disjoint → they never
serialize or collide. This collapses the old freeze→sub→consumer ceremony into wave
setup.

### Rule 2 — Frozen wave base; audit once

The integration base advances **only at wave boundaries**. Every node in a wave builds
against and is audited against the **same frozen SHA**. No per-SHA re-audit, no restack
spiral. A node gets **one** adversarial audit pass: GO, or one repair then re-GO. If it
can't converge in one repair, it drops back to `todo` and is re-scoped — it does not
enter an open-ended audit loop.

### Rule 3 — Role + model routing as fixed lanes

| Lane                 | Model                                                                            | Job                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Root**             | Claude (this orchestrator)                                                       | Lease cards, run barrier pre-flight, freeze the wave base, gate evidence, merge, update `LEDGER.md`. **Never authors production code.** |
| **Implementor** ×3–4 | Claude native subagents (worktree-isolated) + **codex/luna** for heavy authoring | One card each, disjoint paths, build to `just affected-typecheck` + the node's tests green.                                             |
| **Auditor**          | **grok**                                                                         | One adversarial pass per node vs the card's validation column **+ a negative control**. Binary GO / NO-GO.                              |
| **Mechanical**       | **opencode / glm**                                                               | Spelling, line-cap splits, audit-fix nits, card/manifest reconciliation.                                                                |

Claude subagents (Agent tool, `isolation: "worktree"`) and codex (its own
`.codex/worktrees`) run **concurrently** — that is the 6–7 lanes. Reserve any
ultra-tier model (`sol`) only for poison-everything audits (integration, apex design).

### Rule 4 — Deterministic harness, not per-round prompt files

Do **not** hand-write a prompt file per audit round (that produced the 604-file
graveyard). Drive each wave with the **Workflow tool** as a `author → audit → gate`
pipeline, one item per node, structured results. The root reads `LEDGER.md`, selects
the next dependency-ready path-disjoint set, and fans it through the pipeline.

## 2. The loop

```
read LEDGER.md → pick a wave (dependency-ready, path-disjoint node set)
  → barrier pre-flight PR (migrations + events + shared files) → merge; FREEZE base SHA
  → fan out N cards to implementor lanes @ frozen base (Claude subagents ∥ codex)
  → each node: ONE grok audit (GO / one repair / GO) + a negative control
  → root gates evidence: provable (named events an apex run asserts)
                       + callable (HTTP surface) + visible (dashboard)
  → merge each green audited SHA immediately (no batch-at-end)
  → update LEDGER.md rows in the merging PR → advance base → next wave
```

## 3. Definition of done (per node — all four, no credit otherwise)

1. **Merged** to `main` with full green hosted CI + up-to-date-with-`main`.
2. **Provable** — fires the named events its `nodes/*.md` apex-proof column asserts,
   with a negative control.
3. **Callable** — exposes the HTTP surface in its spec.
4. **Visible** — surfaces its state/action in the dashboard.

Only then flip the `LEDGER.md` row to ✅ and count the credit.

## 4. Serialization rules (hard barriers — never concurrent)

- **Migrations** — single owner per slot, next free `0043+`. One migration per wave,
  claimed in the pre-flight PR.
- **Event registry** (SP-8 path) — freezes happen in the pre-flight PR only; consumers
  emit already-frozen names.
- **`screens.ts` / nav / `main.ts`** — single-owner barrier; batch into the pre-flight
  PR or serialize explicitly.

Everything else fans out at `min(16, cores-2)`.

## 5. Immediate sequencing (from the DAG + LEDGER in-flight)

1. **in-1 (#966)** — the integrations foundation everything stacks on; 44 commits
   ready. Reconcile card, rerun smoke from scratch, one grok audit at the exact SHA,
   hosted CI, merge. **First.**
2. **gv-2** — near-done, audit GO; rebase, commit the spelling fixes, gates, merge.
3. **rv-4** — rebase onto post-in-1 base, finish migration/HTTP/UI tail, merge.
4. **mq-2** — re-port cleanly over the post-in-1/rv-4 base (it collides today), merge.
5. First true fan-out wave: a path-disjoint set of dependency-ready governance +
   runtime consumers (e.g. gv-3, gv-6, rv-7, rv-20) behind one pre-flight PR.

## 6. Spec-debt gate (before the full tier)

`bh-15..35` (21) and `gv-16..34` (19) are **not individually specced** (see the
`LEDGER.md` honesty flag). They cannot enter the build loop until broken out into real
per-node cards. That break-out is a `sol`/`grok` authoring pre-task, scheduled after
the MVP tier (the ~78-node v97 acceptance target) is landing steadily — not counted as
node credit.

## 7. Hygiene

- Per-round scratch does **not** accumulate in the repo. `.codex/` is gitignored; if a
  wave produces prompt/report scratch, archive+prune it (see `~/tanren-archive/` for
  the 2026-07-16 graveyard sweep). The durable artifacts are: `LEDGER.md`, the node
  cards, and merged PRs.
- **`just compose-down` before retiring a merged worktree.** `just smoke` leaves a
  compose stack running (registry on `:5000`, postgres, etc.); removing the worktree
  does _not_ stop it, so the next worktree's smoke fails to bind `:5000`
  (`rootlessport ... address already in use`). Tear the stack down first, then
  `git worktree remove`.

## 8. Wave-2/3 learnings (2026-07-17)

- **Build migration/event nodes off _latest_ `origin/main`, never a stale wave
  base.** The drizzle snapshot chain is cumulative (`prevId` → prior snapshot id).
  A node based on pre-barrier main re-carries the already-merged migrations and its
  `0050_snapshot.prevId` points at the wrong ancestor → a painful conflict + snapshot
  regen at rebase time (ds-0). Re-create the worktree from `origin/main` after each
  migration-bearing merge lands.
- **RLS proof tests MUST assert as the non-superuser `tanren_app` role.** The
  `tanren` owner (what `createDbPool()` uses) is a **superuser** — it BYPASSES row
  level security even under `FORCE ROW LEVEL SECURITY`, so a cross-org "sees zero
  rows" assertion run as owner silently passes-by-bypass (or fails to isolate). Seed
  as owner; run the org-scoped assertions through a pool connected as `tanren_app`.
  The gold-standard self-contained pattern (provision ephemeral db → migrate → seed
  via owner → assert via `tanren_app` → drop) is
  `services/orchestrator/tests/integrationEventsRead.rls.integration.test.ts` — copy
  it. Also remember to seed the `organizations` + `projects` rows (FK) before any
  tenant insert.
- **A pg-gated test is DEAD unless wired into a `smoke-rls-*` recipe.** Hosted CI
  runs `just ci` but **not** `just smoke`, and the test `skipIf`s itself off its env
  gate — so an unwired RLS test never runs anywhere (silent green = cosplay). Add a
  `smoke-rls-<node>` recipe **and** append it to the master `smoke:` list, and make
  the recipe's env var **match the test's actual gate var** (e.g. `TANREN_GV7_PG_TEST`,
  not the generic `TANREN_RLS_DB_TEST`) — a mismatch skips the suite.
- **Codex division of labor: codex WRITES + typechecks; the root runs the gates.**
  Codex times out (~25min, exit 124) when asked to run the full gate set itself; the
  code is complete + typechecks regardless. Have it write + `tsc -b` only, then the
  root runs lint/knip/spelling/architecture/drift + smoke. Model routing: **terra/sol**
  for heavy barrier/migration authoring, **luna** for node code + mechanical fixes,
  **grok** for the adversarial audit.
- **Strip `tsconfig.tsbuildinfo` before committing** — it is not gitignored and a
  build artifact; `git rm --cached` it out of the node diff.
- **Parallel smokes:** `TANREN_PORT_OFFSET` ≥ 1000 (offset 100 collides
  orchestrator@100 = allocator@0 = 3200) **and** a matched
  `TANREN_SEED_VAULT_ADDR=http://127.0.0.1:$((18200+offset))` (seed-platform-creds
  hardcodes 18200).
