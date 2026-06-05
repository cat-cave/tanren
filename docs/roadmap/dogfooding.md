# Dogfooding — the path to Tanren building Tanren

The ultimate proof of Tanren is that **Tanren builds and maintains Tanren**: a
change to this repo flows through Tanren's own DAG → per-PR execution → native
gate → merge, with a human only setting intent. This doc is the forward map from
"apex works" to "self-hosting", including the parts apex _cannot_ validate and the
update/deployment problems self-hosting forces us to answer. It is deliberately a
design/strategy note, not a tracker — `ROADMAP.md` holds the live to-do.

---

## What apex proves, and the gap it leaves

apex is a **greenfield** fixture: a paragraph of operator notes → a brand-new
deployed product. It exercises DAG-build, parallel per-PR execution, the native
Action-less gate, the merge queue, conflict handling, budget, and (still to land)
deploy + the issue/feature/scheduled-audit loops.

Dogfooding is **brownfield change against a large, evolving TypeScript monorepo**
(this one, ~1000+ source files). The risks are different and largely unproven:

- **Brownfield recon + import at scale** — understanding an existing architecture
  well enough to plan a _change_, not a fresh feature. The importer exists
  (`engine/forge/brownfield/**`); it has never been driven against a repo this size.
- **Change-spec planning** — "add X to the existing Y" requires the planner to
  read and respect current structure, not scaffold from zero.
- **Conflict resolution under real concurrent change** — many in-flight PRs against
  a shared, dense codebase, far past apex's greenfield pressure.
- **A heavy real gate** — Tanren's own gate is `just ci` (~75 s) + `just smoke`,
  not apex's trivial fixture CI. The native gate must run the real thing over SSH.

---

## Bridge tiers (new validation fixtures, in order)

1. **Brownfield-apex.** Point the apex driver at a _pre-existing_ non-trivial repo
   (a fork of a real OSS project, or a snapshot of this repo) and drive a change —
   add a feature, fix a planted bug. This is the single highest-value unproven
   capability and the concrete next experiment after greenfield-apex is green.
2. **Interactive / UX validation.** apex drives the HTTP API only; the human
   surface — onboarding wizard, ⌘K Forge chat, DAG canvas, review handoff — is only
   validatable _interactively_. The Playwright e2e seam exists but is thin; growing
   it into a real UX lane is its own post-apex track (see "the surface shifts" in
   `ROADMAP.md`).
3. **Self-change tier.** Drive a real change to _this_ repo through a Tanren
   instance, with the gate pointed at `.tanren/ci.yml` → `just fast-check`/`just ci`.
   This is dogfooding proper, and depends on (1) being solid.

---

## The update problem (the hard part of self-hosting)

Self-hosting forces a question apex never asks: **once Tanren merges a change to
its own code, how does the running Tanren adopt it — without bricking itself?**

### Two loops

- The **outer loop**: the running Tanren control plane that is _doing the building_.
- The **inner change**: a PR to Tanren's own source, which merges through the outer
  loop's normal gate→merge like any other unit of work.

Merging the inner change does **not** update the outer loop — the running instance
is now on stale code. Adoption is a separate, deliberate step.

### Principles for self-update

1. **Update is a gated deploy, never a hot-swap mid-run.** A merged self-change
   produces a new immutable build/image; rolling the control plane onto it is an
   explicit deploy action (drain in-flight runs → migrate → blue-green/restart →
   health-gate → keep the old image for rollback). Never swap code under a run.
2. **The deployer must not be able to brick itself.** Tanren cannot be the _only_
   thing that can deploy Tanren — a bad self-change would then have no recovery
   path. There must be an out-of-band escape hatch (a human, or a minimal external
   deploy/rollback path) independent of Tanren. This is the self-hosting echo of
   the apex finding that a deploy target must always have a loud, recoverable
   failure mode, never a silent brick.
3. **Migrations get the same migrate-before-rollout discipline** the app already
   uses (owner-run migrate step, drain, then deploy). A self-change carrying a DB
   migration is the riskiest case and must run against a staging instance first.
4. **Stage before production.** A self-change runs the FULL gate plus a
   smoke/e2e against a _staging_ control plane before the production instance
   adopts it. "Green unit CI" is necessary, not sufficient, for a self-update.

### How should Tanren handle updates _in general_ (any app it maintains)?

The same shape generalizes beyond self-hosting:

- **Immutable artifact per merge**; deploy is explicit, not implicit, for stateful
  services (auto-deploy-on-merge is fine for stateless previews — `deployOnMerge`
  already does this — but a stateful prod service needs the gated variant).
- **Migration before rollout**, health-gated rollout, automatic rollback on a
  failed health gate.
- **The deployer-can't-brick-itself rule** applies to every deploy target Tanren
  manages, not just itself.

This is a build-it-later capability (it needs a real deploy target + a staging
tier), but the _design_ belongs here now so the self-update model isn't improvised
under pressure.

---

## Pre-dogfood polish (do before pointing Tanren at itself)

So the repo is something Tanren can cleanly reason about and Tanren isn't asked to
maintain cruft it would never itself generate:

- Finish the remaining DAL cluster cleanups + residual hardening (`ROADMAP.md` §4).
- Keep the gate honest and fast (Turborepo + affected loops are wired; the gate is
  `just ci`).
- Author the `.tanren/ci.yml` that points the native gate at this repo's real
  checks.
- Land the brownfield-apex fixture (tier 1 above) — the bridge experiment.

The end state: a fresh clone of this repo, on a different machine, can be
understood and continued from the docs alone — which is exactly the property a
self-hosting Tanren needs in order to read, plan against, and safely change its own
source.

Reaching this handoff also **retires the interactive build discipline** in
`docs/playbooks/parallel-orchestration.md`: that playbook is the bootstrap-era
strategy for driving Tanren by hand: once Tanren maintains Tanren, the platform is
the orchestrator and is far more capable than the manual loop it replaces.
