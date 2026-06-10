# Templating system — every project DAG seeds from a validated template

This is the doctrine-of-record for Tanren's project templating, and it is
**load-bearing**: the orchestrator code cites this file by section
(`§2` = the creation meta-flow, `§3` = the no-match auto-trigger + the
seed/from-scratch relocation). The doctrine is **owner-stated and enforced in
code** — it is not aspirational.

> **Status (merged on `main`, #498).** The from-scratch-into-a-project bypass is
> **deleted**. The template gate, just-in-time creation, the `assertSeeded`
> invariant, the `TemplateRequiredError` → `409` halt, and the durable
> `template.selection.*` / `template.creation.*` events are live. The system is
> first exercised end-to-end by the next apex run — DO NOT pre-create a template;
> apex MUST flush the creation-from-scratch path (see below).

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
**stack-flexible contract** established (`docs/roadmap/stack-flexible-contract.md`):
Tanren bakes in no stack; the contract files (`justfile` + `.tanren/ci.yml`) are
materialized deterministically from the captured lifecycle, never LLM-authored.

### Durable events

The whole path is observable through durable events (schemas in
`engine/events/schemas/templates.ts`):

- `template.selection.no_match` — selection found no eligible validated template.
- `template.creation.started` / `template.creation.published` /
  `template.creation.failed` — the just-in-time meta-flow lifecycle.
- `template.registered` / `template.status_changed` — registry lifecycle.

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

The templating system sits **above** the stack-flexible contract
(`docs/roadmap/stack-flexible-contract.md`):

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
