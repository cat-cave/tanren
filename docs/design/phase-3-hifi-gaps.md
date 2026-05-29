# Phase 3 Hi-Fi Design Gaps

**Purpose.** Eight Phase 3 specs are **design-blocked** — their backend foundations are
either built or well-understood, but their *interaction model / surface design* is not
locked in the hi-fi. This document is the input to that hi-fi/design work: for each
blocked surface it states **what the backend already provides** (the contracts and
affordances the design must build on), **what needs to be designed**, and the **open
decisions to lock** before engineering can build it.

Everything else in Phase 3 is already merged (Tier 1 loop + Tier 2 expansion, PRs
#71–#93). These eight are what's left, and they wait on design — not on more code.

Cross-reference: spec stubs in [`phase-3-specs.md`](../roadmap/phase-3-specs.md) (P3-0010,
0013, 0014, 0015, 0016, 0017, 0021, 0022); bucket prose in
[`phase-3.md`](../roadmap/phase-3.md); existing prototypes in `tanren-hi-fidelity/`.

---

## How to read each section

- **Backend in place** — what exists on `main` today that the design must target. Engineering will wire the surface to these; the design must respect their shapes.
- **Needs design** — the surfaces, flows, and interaction models to produce in the hi-fi.
- **Decisions to lock** — specific questions whose answers change the build. These are the blockers.

---

## 1. P3-0010 — Thick Forge (LLM-backed conversation)

Replace the templated v0 Forge narration with a real LLM author that reads the
conversation and invokes the tool surface.

**Backend in place**
- `forge_threads` + `forge_turns` persistence and the **Forge tool surface** (P2A-0019) — read-only stubs + operator-button write actions already exist; the ⌘K palette (P2B-0001) already sources items from the tool surface.
- The dashboard already proxies tool calls (`POST /forge/tools`) with the session cookie.
- Provider adapters now exist (P3-0012: Claude/Codex Answerers) — the LLM backend can call one. The spec note says this is a **pure swap** of the narration generator, no schema change.

**Needs design**
- The **conversation UI** itself: how a thick Forge thread looks and behaves on the project view (message layout, streaming, tool-call rendering, operator approvals inline vs. modal).
- How **tool invocations** surface in the conversation (proposed action → operator confirm → result), and how read vs. write actions differ visually.
- Where the conversation lives relative to the chat-primary project view (P2B-0003 already ships a chat-primary shell — does thick Forge replace its narration pane, expand it, or open a dedicated thread view?).
- Forge "personas"/voice and how much initiative it takes (suggest vs. act).

**Decisions to lock**
- Is thick Forge a **replacement** for the P2B-0003 narration pane or an **additional** thread surface? (This determines whether it's a swap or a new screen.)
- Tool-call confirmation model: inline approve, modal, or operator-button (P2A-0013) reuse?
- Streaming token display vs. turn-at-a-time.
- Which provider/model is the default Forge author, and is it operator-configurable?

---

## 2. P3-0013 — Spec DAG canvas + DAG-primary project view

The full SVG canvas of milestones/behaviors/specs with attention badges and
click-routing — and making it the *primary* project view.

**Backend in place**
- P2A-0018 product-entity model: `specs`, `spec_dependencies` (the directed edges), `milestones`, `behaviors`, `personas` — the graph data exists and is queryable. P3-0020's `stuck` insight already walks `spec_dependencies` (cycle-safe), so the dependency-chain traversal is proven.
- Run/spec status (live/done/review/blocked) is derivable from runs + the new `review.*`/`merge.*` events.
- The current project view (P2B-0003) is **chat-primary**, not DAG-primary.

**Needs design**
- The **SVG canvas layout**: node shapes per entity type (milestone/behavior/spec), edge rendering, auto-layout algorithm (the hi-fi shows a specific arrangement — lock it), zoom/pan, the legend overlay, and the "attention-numbered badges" + pulsing animations for live/review/blocked nodes.
- **Click-routing**: what each node type routes to (spec → run/detail; milestone → ?; behavior → ?).
- The **DAG-primary vs. chat-primary** switch: does the project view default to DAG with chat secondary, a toggle, or split? This is a significant reframe of P2B-0003's shipped layout.
- Empty/large-graph states (a 71-spec DAG from greenfield needs a scalable layout).

**Decisions to lock**
- DAG-primary as default, or a view toggle alongside the existing chat-primary view?
- The layout algorithm + node/edge visual language (this is the core artifact to lock).
- Interaction for dependency editing — view-only in v0, or can the operator re-wire edges on the canvas?

---

## 3. P3-0014 — Spec discovery flow

Forge classifies an insight (sales note, GitHub issue, exec memo) → proposes specs
with DAG-placement options → persists provenance.

**Backend in place**
- The product-entity model (P2A-0018) the proposed specs would slot into.
- Forge thread/turn + tool surface (P2A-0019) — discovery is a Forge-driven flow.
- Thick Forge (P3-0010) is its LLM engine → **depends on #1 being designed first**.
- The DAG (P3-0013) is where placement options render → **depends on #2**.

**Needs design**
- The **discovery interaction**: input (paste/import an insight) → Forge classification → proposed-spec cards → DAG-placement choices → accept/persist.
- The **three variants** (feature / bug / strategic) and how they differ in the UI.
- How **provenance** is shown (this spec came from X insight on Y date).
- The classification confidence / operator-override affordance.

**Decisions to lock**
- The shape of a "proposed spec" card and the placement-choice UX (depends on the DAG design, #2).
- How much the operator edits before persisting vs. accept-as-proposed.
- Where discovery is entered from (a dedicated surface? the Forge palette? the insight feed?).
- **Hard dependency:** lock #1 (thick Forge) and #2 (DAG) first — discovery composes them.

---

## 4. P3-0015 — Greenfield onboarding (full track)

The multi-round Forge vision interview → derived spec DAG (the hi-fi references a
~71-spec DAG) → sources / scheduled-audits / arrival surfaces.

**Backend in place**
- P2B-0009 shipped (or specced) a **thin** greenfield form; this full track supersedes it.
- Product-entity model to persist the derived personas/behaviors/specs.
- Thick Forge (P3-0010) drives the interview → **depends on #1**; the derived DAG renders via #2.

**Needs design**
- The **multi-round vision interview** flow: how many rounds, what Forge asks, how answers accumulate, how the operator revises.
- The **interview → DAG derivation** UX: how a conversation becomes a 71-spec DAG the operator can inspect/trust/edit.
- The **arrival** surface (post-onboarding landing) + the **sources** and **scheduled-audits** panels referenced in hi-fi 01b.

**Decisions to lock**
- Interview structure (rounds, branching, when it terminates).
- How much of the derived DAG is auto-generated vs. operator-curated before it's "real."
- Relationship to the thin P2B-0009 form (replace entirely, or thin form remains a shortcut?).
- **Hard dependency:** #1 + #2.

---

## 5. P3-0016 — Brownfield onboarding (full track)

The read-only recon agent + config-injection PR + DAG seed + governance picker —
the remaining hi-fi 01c steps beyond the minimal link flow already shipped.

**Backend in place**
- **Minimal existing-project link** already ships (P2B-0002): repo link via brownfield endpoint that reads `.github/workflows/`, `.mergify.yml`, `CODEOWNERS` and writes nothing.
- **GitHub App connectivity** (P3-0003) — needed for the config-injection PR to write to the target repo.
- **Governance posture** (P3-0023) — the strict/open/audit-only modes are built; this surface needs the *picker* UI.
- Answerer infrastructure for a read-only recon agent (reuse the Answerer pattern).
- Repo-sourced `tanren-ci.yml` (P3-0004) — the config-injection PR adds this + `.mergify.yml` + `CODEOWNERS` + a `.tanren/PROJECT.md` snapshot.

**Needs design**
- The **recon-agent step** UX: indexing progress, then the pre-filled personas/behaviors/architecture/risks for operator review/edit.
- The **config-injection PR** flow: preview of the files to be added, operator approval, the opened-PR confirmation.
- The **DAG-seed step** (agent gaps + GitHub issues → seed specs) — depends on #2/#3.
- The **governance-posture picker** placement + copy (wiring to P3-0023's modes).

**Decisions to lock**
- How much recon output the operator reviews/edits before it's persisted.
- Config-injection: always a PR (never direct write)? Which files are mandatory vs. opt-in?
- Where the governance picker lives in the flow and its default.

---

## 6. P3-0017 — `tanren-config` audit-gate repo pattern

An optional org toggle routing Bucket-B config writes through a PR in a separate
`tanren-config` repo before applying to the DB.

**Backend in place**
- The config write paths (P2A-0013 project/org config PATCH) the gate would intercept.
- GitHub App connectivity (P3-0003) to open PRs in the `tanren-config` repo.
- DB remains source of truth; the PR is a write gate (architectural decision already stated).

**Needs design**
- The **toggle** UI (org settings): enable/disable the audit gate, point at the `tanren-config` repo.
- The **gated-write UX**: when an operator changes config under the gate, what they see (the change is queued as a PR, not applied; a link to the PR; status when merged → applied).
- The **apply-on-merge** flow visualization.

**Decisions to lock**
- Which config categories are "Bucket-B" (gated) vs. applied directly.
- What happens to a config change while its PR is open (pending state, conflict handling).
- The `tanren-config` repo bootstrapping (operator creates it? Tanren scaffolds it?).

---

## 7. P3-0021 — Scheduled-audits library

Cron-driven background scans (security, mutation, perf, deps, type-coverage, a11y,
license, stale-specs) producing auto-generated specs.

**Backend in place**
- The **run executor** (P3-0001) can execute scheduled work; the **gate-check tiers** (P3-0004/0005) define scan commands.
- Spec creation (P2A-0013) to persist auto-generated specs — but turning a scan finding into a spec depends on **discovery (#3)**.
- The hi-fi references this as "01b step 3 right panel."

**Needs design**
- The **audits library** surface: list of scheduled scans, their cadence, last-run results, enable/disable.
- How a scan **finding becomes a proposed spec** (the bridge to discovery, #3).
- Scheduling UX (cron-like; "scheduled overnight audits" — P3-0018's heatmap already has a Forge-prompt CTA pointing here).

**Decisions to lock**
- The catalog of v0 scan types and their cadences.
- Finding → spec: auto-create, or propose-via-discovery (#3)?
- **Dependency:** the spec-generation half depends on #3 (discovery); the scheduling+scan-execution half could be designed independently.

---

## 8. P3-0022 — Issue-source ingestion

GitHub Issues → candidate specs via label-driven classification (Linear/Jira/webhooks
deferred further).

**Backend in place**
- GitHub App connectivity (P3-0003) to read issues.
- Discovery (#3) is the classification + proposal engine → **depends on #3**.

**Needs design**
- The **issue → candidate-spec** flow: which labels trigger ingestion, the classification result, the proposed-spec review (this is largely discovery, #3, with GitHub Issues as the input source).
- Where ingested candidates surface (the discovery surface? a dedicated inbox?).

**Decisions to lock**
- The label → classification mapping.
- **Hard dependency:** #3 (discovery) — this is discovery with an issue-source adapter.

---

## Cross-cutting decisions to lock first

These gate multiple surfaces; locking them unblocks the most:

1. **Thick-Forge interaction model (#1)** — gates discovery (#3), greenfield (#4), and the recon framing of brownfield (#5). **Lock this first.**
2. **DAG canvas visual language + DAG-primary vs. chat-primary (#2)** — gates discovery placement (#3), greenfield DAG derivation (#4), brownfield DAG-seed (#5). **Lock second.**
3. **Discovery flow (#3)** — gates scheduled-audits' spec-generation (#7) and issue-ingestion (#8). **Lock third.**

Recommended design order: **#1 → #2 → #3 → {#4, #5, #6} → {#7, #8}**. #6 (brownfield) and #17 (tanren-config gate) have the most backend already in place and the least dependency on the others, so they can be designed in parallel once #1/#2 are locked.

## What engineering needs from the design

For each surface, to start building we need: the **locked screen(s)** (layout + states), the **interaction flow** (click-by-click), and the **data each view reads/writes** mapped to the existing contracts named under "Backend in place." Where a surface composes another (e.g. discovery uses the DAG), the composed design must be locked first.
