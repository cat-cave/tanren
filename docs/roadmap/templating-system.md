# Templating system — every project DAG seeds from a validated template

This is the doctrine-of-record for Tanren's project templating, and it is
**load-bearing**: the orchestrator code cites this file by section
(`§2` = the creation meta-flow, `§3` = the no-match auto-trigger + the
seed/from-scratch relocation). The doctrine is **owner-stated and enforced in
code** — it is not aspirational.

> **Status (merged on `main`, #462 + #498).** The from-scratch-into-a-project
> bypass is **deleted**. The template gate, just-in-time creation, the
> `assertSeeded` invariant, the `TemplateRequiredError` → `409` halt, and the
> durable `template.selection.*` / `template.creation.*` events are live (#498).
> **Wave 5 — the maintenance dimension (#462) — is also merged**: the
> template-maintenance scheduler, `lts`/`nightly` channels, nightly→lts
> graduation, and freshness/revalidation (`engine/templates/maintenance/**`; see
> §4). The system is first exercised end-to-end by the next apex run — DO NOT
> pre-create a template; apex MUST flush the creation-from-scratch path (see below).

---

## The doctrine (the one rule)

**There is NO "from-scratch into a project" path.** EVERY project DAG executes
against a known-solid, **validated** template. The from-scratch authoring still
exists, but it is **only the BUILD step of template-creation** — not a project
path. Stated as the owner did:

> **"the from-scratch flow IS the create-a-new-template flow."**

So when a project's architecture step finds no matching validated template, project
init does exactly one of two things — never a third:

1. **Create a template just-in-time** (§2) — research → author-from-scratch →
   build → validate-with-negative-controls → publish — then the project scaffold
   **seeds FROM** the freshly-created, validated template, OR
2. **Halt loud** (`TemplateRequiredError` → HTTP `409`) if creation cannot produce
   a validated template.

A project DAG **never** proceeds from-scratch into an empty repo. The derive
invariant guard (`assertSeeded` / `assertNoFromScratchProjectScaffold`,
`engine/forge/interview/interviewTemplateGate.ts`) asserts this after selection:
the from-scratch scaffold branch is reachable **only** on the `template_build`
scaffoldOrigin (where the derive authors the TEMPLATE itself).

---

## §2 — the template-creation meta-flow

`createTemplate(request)`
(`engine/templates/creation/createTemplate.ts`) runs a five-step meta-DAG and
either registers a **validated** template or fails LOUD without publishing. It
REUSES live infra at every step (research/build are seams; authoring feeds the
existing `deriveProductGraph`; validation is `runValidationHarness`):

1. **RESEARCH** — web-research current best practice + tooling for the stack.
2. **AUTHOR** — emit the template-build spec set as an `InterviewCapture`, then
   materialize the project graph via the existing greenfield `deriveProductGraph`.
   _This is the from-scratch authoring — relocated here, reachable ONLY as the
   build step of template-creation._
3. **BUILD** — drive that project through the existing spec-loop / DagWalker to the
   conforming template repo.
4. **VALIDATE** — run `runValidationHarness` (positive + **negative** controls +
   auditor) over the built repo → a `TemplateValidationProof`.
5. **PUBLISH** — **only if** the proof validates: register it in the
   `TemplateStore` (status `validated`, manifest carrying the proof + provenance +
   channel) + emit `template.registered`. An invalid template is **never**
   registered — a loud finding, not a publish.

---

## §3 — the no-match auto-trigger + the seed/from-scratch relocation

The architecture step queries the registry by capabilities for a **validated**
template (`validated` / `official` tiers only — a `draft`/`degraded` template is
not a usable match) BEFORE deriving the scaffold specs
(`engine/templates/creation/noMatchHook.ts`):

- **A validated match exists** → the `scaffold` spec **shrinks** to template
  instantiation (adapt product names / deploy target / env; plus partial-match
  adaptation criteria for a partial match). The writer instantiates the seed; it
  does not author from scratch.
- **No validated match** → the no-match auto-trigger runs the creation meta-flow
  (§2). On success the scaffold seeds from the new template; on failure the project
  init halts loud (`TemplateRequiredError`).

The `build` and `deploy` scaffold specs are identical either way — they always
route through the conventional `just build` / `just deploy` targets the materialized
**stack-flexible contract** established (now embodied in code — the `justfile` +
`.tanren/ci.yml` contract; see `docs/operator-guide/ci-config.md`):
Tanren bakes in no stack; the contract files are materialized deterministically
from the captured lifecycle, never LLM-authored.

### Durable events

The whole path is observable through durable events (schemas in
`engine/events/schemas/templates.ts`):

- `template.selection.no_match` — selection found no eligible validated template.
- `template.creation.started` / `template.creation.published` /
  `template.creation.failed` — the just-in-time meta-flow lifecycle.
- `template.registered` / `template.status_changed` — registry lifecycle.

---

## §4 — the maintenance dimension (a template is a first-class Tanren project)

Creating a validated template is not the end of its life. A template tracks an
upstream stack that **moves**, and its "meaningful, not green-by-accident" proof
goes **stale**. Wave 5 (merged, #462; code at `engine/templates/maintenance/**`)
makes every registered template a **first-class project Tanren maintains on a
schedule**, reusing the scheduled-audit machinery rather than reinventing it.

- **The maintenance scheduler (`maintenance/loop.ts`, booted by `boot.ts`).**
  A long-lived per-process loop (the same `start`/`stop`/`tick` shape + cross-org
  system-scoped fan-out as `AuditSchedulerLoop`). Each tick re-validates due
  templates by re-running the **same** validation harness the creation flow proved
  them with (`maintenancePass.ts` → `revalidator.ts` → `runValidationHarness`) —
  it does not reinvent validation; it provisions the registered repo onto a runner
  and re-proves it.

- **`lts` / `nightly` channels (`channelPolicy.ts`).** A template's channel decides
  **which** upstream versions it accepts and **how often** it bumps, stack-agnostic
  by construction (stable-vs-pre-release is a generic marker, never an ecosystem's
  semver rules):
  - **`lts`** — conservative: accepts only a stable release, rejects pre-releases,
    slow (monthly) cadence — the proven floor real projects seed from.
  - **`nightly`** — aggressive: accepts the latest including pre-releases, fast
    (daily) cadence. It is the **canary** — a breaking upstream release fails the
    nightly validation **first**, before it can reach an LTS template or a real
    project.

- **nightly→lts graduation (`graduation.ts`).** Because nightly re-validates the
  full harness on every aggressive bump, the maintenance loop (a) keeps `lts`
  pinned safe (never auto-takes the cutting-edge bump), (b) files any breakage as a
  finding/spec, and (c) graduates a version nightly→lts **only** once its nightly
  validation has stayed **green continuously for an aging window** — a pure,
  clock-injected predicate.

- **Freshness + revalidation (`freshness.ts` + `revalidator.ts`).** A template's
  registry status drops to **`degraded`** (so selection, which already filters
  degraded, stops choosing it) on two triggers: its `validationProof` is older than
  the freshness horizon, or a maintenance pass surfaced an unresolved **P0/P1**
  finding. **Fail-closed:** a proof that cannot be dated reads as expired, never as
  fresh, so an unparseable/stale proof degrades rather than silently seeding
  projects.

---

## apex interaction — do NOT pre-create a template

apex MUST exercise **template-creation-from-scratch** end-to-end. **Do not
pre-create or pre-seed a template before an apex run** to "help it along" — if the
creation-from-scratch path breaks, that is precisely the bug apex exists to flush
(this was the #498 finding: v32 surfaced that the templating system had never been
exercised and the from-scratch path was wrong). Let the no-match fire, watch the
`template.creation.*` events, and if it halts, root-cause and fix on `main` per the
apex rhythm (`docs/operator-guide/apex.md`). The drive steps are in
`docs/operator-guide/apex-run-playbook.md` §5b.

---

## Relationship to the stack-flexible contract

The templating system sits **above** the stack-flexible contract (now embodied in
code — the `justfile` + `.tanren/ci.yml` contract; see
`docs/operator-guide/ci-config.md`):

- The **contract** is the generality mechanism — Tanren knows no stack; a project
  declares its lifecycle in a `justfile` + `.tanren/ci.yml` and Tanren runs it
  uniformly.
- The **template** is the validated, pre-built seed a project starts from instead
  of authoring the contract-conforming repo cold. A template is a real conforming
  repo (added as a REPO, never as TypeScript) that already satisfies the contract.

> **Superseded line.** Earlier stack-flexible prose said the architecture step
> "may seed from a template if it matches; otherwise the agent authors from-scratch
> against the contract." That from-scratch **fallback no longer exists** for a
> project path — a no-match creates a validated template just-in-time or halts. The
> from-scratch authoring survives only as the BUILD step of template-creation.
