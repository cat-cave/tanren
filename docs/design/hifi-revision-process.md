# Hi-fi revision process

How an incoming hi-fidelity design revision becomes work. The full-product
vision **for Tanren's own dashboard** is mocked in **Claude Design**
(claude.ai/design), exported as a handoff bundle, and lands in
`tanren-hi-fidelity/`. This document is the SOP for turning the _next_ revision
into tracked changes — it is the process; the bundle is the artifact and the audit
(`phase-3-hifi-gaps.md`) is the output.

> **Scope — this is about Tanren's dashboard, not the products Tanren builds.** The
> hi-fi bundle is a **human reference** so the build recreates Tanren's _own_ UI; the
> build engine never reads it. Designing the apps Tanren _ships_ is a separate,
> now-built concern: the **native design subsystem** (`DesignContract` → design
> agent/phase → writer injection → design oracle, all in one DAG, no handoff). Its
> canonical doc is `docs/roadmap/native-design-subsystem.md`. Do not route hi-fi
> revisions through that subsystem, and do not treat this SOP as the way Tanren
> designs customer products — these are two different design pipelines.

## Inputs and where they live

- **`tanren-hi-fidelity/`** — the installed bundle. `README.md` (read first),
  `chats/` (the design conversation — where the _intent_ lives), `project/` (the
  HTML/CSS/JS prototypes — the visual target). Treat prototypes as pixel-spec,
  not as code to copy.
- **`docs/design/phase-3-hifi-gaps.md`** — the current, real **hi-fi ↔
  implementation audit** and the single home for vision-delta tracking: where the
  build is behind the hi-fi (build work), where the hi-fi is behind the build
  (hi-fi edits), and the vision-level intent changes a revision introduces. This is
  the durable output of every revision pass; keep it current, purge stale notes.

## Steps for a new revision

1. **Import the bundle.** Replace/overlay `tanren-hi-fidelity/` with the new
   export on its own branch + PR. Keep it a clean, reviewable import (don't mix
   import with implementation).
2. **Read the chats, then the primary prototype.** The transcripts say what the
   user actually wants and where they landed; the final HTML is just the output.
   Follow the prototype's imports so you understand the whole surface.
3. **Diff against the current build — a real audit, not trust in old docs.**
   Enumerate every page/screen/flow/feature the revision specifies and check each
   against what is _actually wired_ in `services/dashboard/**` (routes, screens
   registry, islands, nav) and `services/orchestrator/src/engine/**` (Forge
   features, adapter seams, capabilities). Verify in code; never carry a stale
   gap note forward.
4. **Produce two sets, with evidence (hi-fi source + code path) per item:**
   - **Set 1 — hi-fi is behind the build.** The product moved past or
     purposefully diverged from the mock (new adapter/config surfaces, tenancy/
     quota, intentional UX changes). These are **edits the user makes to the
     hi-fi** when revising it.
   - **Set 2 — the build is behind the hi-fi.** Missing pages, lacking/stubbed
     Forge features, partial or deferred flows, polish the design calls for.
     These are **build work** → specs.
5. **Record the deltas.** Both the vision-level intent changes and the full
   two-set audit land in `phase-3-hifi-gaps.md`, replacing its body (purge what no
   longer reflects reality).
6. **File the build work.** Turn Set 2 into roadmap specs
   (`docs/roadmap/**`), dependency-ordered, each shippable per-PR-through-CI.
   Don't start building before the user confirms scope on anything ambiguous.

## Principles

- **The hi-fi is a vision artifact**, not a phase plan — ROADMAP carries the
  phasing. Items present in the hi-fi but intentionally deferred are named
  explicitly in the audit, not silently dropped.
- **Audit from code, not from docs.** A gap note is only as good as the last time
  someone verified it against the implementation. Re-verify every pass.
- **Two directions, always.** Drift runs both ways: the build races ahead of the
  mock as often as it lags it. Capture both so the hi-fi and the product can be
  reconciled deliberately.
