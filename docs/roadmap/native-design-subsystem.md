# Tanren owns design — a native, domain-general design subsystem

> Status: **subsystem CORE built, merged, and live-wired into the spec loop;
> remaining work is dogfood + apex + templates (WS-D5..D8).** The foundation
> workstreams are done on `main`: **WS-D1** (the `DesignContract` entity, #596),
> **WS-D2** (writer injection, #598), **WS-D3** (design agent + design phase,
> #599), and **WS-D4** (the domain-aware design oracle, #597) — now **wired
> end-to-end into the live spec loop** (#602) with the missing-contract loud-fail
>
> - dangling-ref consistency hardening (#600). The **design verify→re-drive loop
>   is closed**: the Forge interview captures the design intent → the design agent
>   authors the `DesignContract` → the writer injects it on every generation → the
>   design oracle verifies behavior-coverage + persona-scoped fidelity → its
>   findings re-drive the writer, all in the **same DAG, no handoff**.
>
> **Integration-review outcome (the close-out check on the wiring):** the writer
> leg is verified **closed** (the contract reaches the writer prompt on every
> generation); the **moat is real** — persona + behavior coverage is enforced
> _structurally_ (the design phase asserts exhaustive behavior coverage + strict
> ref resolution; the oracle resolves typed entity refs strictly, no guessing);
> and the **domain-generality is sound** (the contract shape, the agent's
> dimension set, and the oracle's verification mode are all domain-derived, never
> web-baked, never branched-on in code). The two **P1 gaps** the review found —
> the oracle being **unwired** (capability complete but not called) and the
> interview capture being a **silent no-op** when no contract was captured — are
> both **CLOSED** (#602 wires the oracle into the loop; #600 makes a
> missing/dangling contract a LOUD halt).
>
> **Honest next step — not yet exercised on a live run.** The subsystem is
> **code-complete + wired**, but it has **NOT yet been exercised end-to-end on a
> real live run**: the current apex run captured **no** `designContract`, so the
> design phase + oracle no-op there (the oracle returns `hasContract: false` and
> the loop skips design verification — `loopStages.ts:164`). Exercising the full
> loop on a live run with a real captured `designContract` is the **next
> validation step** (WS-D8).
>
> The remaining plan below — **WS-D5..D8** — is what is left. WS-D5 is **assessed
> as SUBSUMED** by the domain-general D1/D3/D4 implementation (verdict + evidence
> in its entry); **WS-D7 (dogfood)** and **WS-D8 (apex integration)** are the
> headline remaining work. It does **not** block or halt the current apex
> fixture — but once a live run carries a real contract, design becomes an added
> requirement of apex (WS-D8).

## The north star (the why)

Tanren becomes the **entire platform**. A non-technical operator — the owner's
running example, "someone like my dad" — opens Tanren, **describes and designs a
tool conversationally**, watches it progress, sets a budget, has it deployed, and
iterates. They run an entire software department with zero awareness of what
happens beneath the surface. One surface, one conversation, a real shipped
product.

**Design is the missing pillar of that one-surface experience.** Tanren already
owns the engine (jj / `MergeAuthority` / `CodeHost`, replacing
Mergify/Actions/external-VCS — see `docs/architecture/tanren-owns-the-engine.md`)
and is moving to own the environment, the templates, and the verification oracle.
But it does **not** own design. For an operator who cannot read a diff, "what the
product looks and feels like" is not a nice-to-have — it is half the product. A
platform that builds the behavior but improvises the design is not the platform
the north star describes.

## Where design is today (≈ nonexistent)

There is no design _phase_, no design _entity_, no design _artifact_, and no
visual _verification_ for the products Tanren builds. Concretely:

- **The only design artifacts are the hand-done `tanren-hi-fidelity/` bundle** +
  the design tokens it carries — and they serve **Tanren's OWN dashboard**. They
  are a **human reference** exported from Claude Design (claude.ai/design) so a
  coding agent can recreate the dashboard; the build _engine_ never reads them
  (see `tanren-hi-fidelity/README.md` and `docs/design/hifi-revision-process.md`).
- **A single 80-char `designDna` interview hint** is the entire design surface in
  the model, and it is **purely decorative**: it is used only for merge-conflict
  framing (the conflict resolver's product-vision context) and as a slug fallback.
  It **never reaches the writer**. The agent that generates the product gets
  **zero design context**.

So for products Tanren builds, UI/UX fidelity is whatever the LLM writer
improvises from functional specs. That is the gap this subsystem closes.

## Two reference tools (capability references, NOT dependencies)

Two tools define the capability bar. We **absorb their concepts natively**; we do
**not** integrate either, and we depend on neither.

- **Claude Design** (claude.ai/design) — conversational design authoring that
  exports a handoff bundle for a coding agent. This is the surface our hi-fi
  bundle came from.
- **open-design** (github.com/nexu-io/open-design) — an **agent-native harness**
  that wraps coding-agent CLIs, where:
  - the durable unit is a **Markdown design contract** (`DESIGN.md` + `tokens.css`)
    that is **injected on every generation**,
  - the output is **code + a PR**,
  - quality is **enforced by evals** (with explicit craft / anti-ai-slop
    references), and
  - it **self-extends** — "plugins create plugins."

The striking finding: **open-design's architecture is ~the same as Tanren's** —
spec-as-contract, writer→checker→gate, spec→merged-PR, and template-creation —
just **design-shaped**. Its concepts therefore port nearly 1:1 onto Tanren's
existing machinery. We take the concepts; we do not take the tools.

## Tanren's structural advantage — there is NO handoff seam

Both Claude Design and open-design **end at "handoff to a coding agent."** Their
design contract is thrown over a wall to a _separate_ build tool.

**Tanren has no wall.** The writer that consumes the design contract **IS Tanren's
build engine, in the SAME DAG.** So design is not a phase that terminates at a
handoff — it is a phase that **flows continuously into the build and iterates with
it**:

- the design oracle's verdict **re-drives the writer** (a fidelity miss is a
  finding that routes work, exactly like any gate/audit finding);
- a **design change re-propagates** through the same never-discard
  base-shift / jj-rebase machinery that re-propagates any base shift
  (`docs/architecture/tanren-owns-the-engine.md` §3) — design↔code never drift;
- there is one source of truth and one loop, not a design tool plus a separate
  coding agent stitched together.

This makes Tanren **categorically more integrated** than design-tool +
separate-coding-agent. It is the same advantage that "owning the engine" bought on
the merge side, applied to design.

## The model — three pillars

### Pillar 1 — a domain-general design CONTRACT

A first-class, **persisted, versioned `DesignContract` entity** — the durable
design artifact, **injected into the build on every generation** (the same way
`tanren-owns-the-engine` makes the gate config / `auditPosture` durable inputs to
the decision).

Its **shape is DOMAIN-ADAPTIVE, not web-baked.** Tanren builds anything (see the
general-build-engine doctrine — a "repo" could be a fan-translation where a bug is
a grammar error):

- a SaaS app's design = tokens / components / layout;
- a mobile game's = art direction / UI / game-feel;
- a novel translation's = typography / voice / layout / cover.

open-design's web-centric `DESIGN.md` (its nine web sections) is **one INSTANCE of
the contract, not the model.** This is the same generality discipline as the
project-declared lifecycle (`docs/roadmap/stack-flexible-contract.md`) and the
oracle taxonomy — **never bake the domain into core.**

### Pillar 2 — a domain-aware design ORACLE

Verification of design fidelity **against the contract**, where **what "good
design" means and how to verify it are domain-derived**:

- visual render / screenshot for web UI,
- prose / typography for a novel,
- art / feel for a game.

This **replaces today's static read-only demo** (which cannot even render UI). It
fits the existing checker / auditor / gate model and the oracle taxonomy directly:
the design oracle is an answerer that inspects the built artifact against the
contract and emits findings; `auditPosture` and the `MergeAuthority` already know
how to turn findings into a verdict.

### Pillar 3 — a unified design↔code loop (no handoff)

Design is a **phase in the same DAG** that feeds Tanren's own writer and
**iterates with the build** — the structural advantage above, made concrete: one
DAG, one writer, one merge authority, the design oracle's verdict re-driving the
writer and re-propagating through base-shift.

## open-design concepts → Tanren-native forms

We do not adopt open-design. We map its concepts onto machinery Tanren already
has:

| open-design concept                     | Tanren-native form                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| design-system-as-injected-contract      | the **`DesignContract` entity**, injected into the writer on every generation              |
| skills                                  | **design templates** in the template registry (`docs/roadmap/templating-system.md`)        |
| "plugins create plugins"                | the **template-creation meta-DAG** (Tanren builds + validates templates with its own loop) |
| code-migration: `repo + DESIGN.md → PR` | literally Tanren's **spec → merged-PR** — a design-apply is a **spec kind**                |
| evals + craft refs (anti-ai-slop)       | the **design oracle** + craft / quality rules in the checker / auditor suite               |
| file-on-disk + `history.jsonl`          | **already Tanren's git-native model** (jj `WorkspaceVcsCore` + the event log)              |

The point of the table: the design subsystem is **mostly a re-shaping of existing
Tanren machinery**, not a new parallel stack.

## The Tanren-native moat — design no other tool can do

Every feature must feel **cohesive** with the platform and **exploit the native
tooling we have already built.** The goal is **NOT** to clone open-design or Claude
Design — it is to use everything Tanren uniquely has to build something no one else
**CAN.** Standalone design tools all **end at "handoff to a coding agent."** Tanren
**IS the whole pipeline**, so design can tie into **every** native subsystem. This
is the moat — and it is deliberately ambitious.

- **First-class personas → strict persona resolution.** Claude Design has to
  **ask** the designer "who is this page for? add a role toggle? assume default
  admin? which roles matter?" — it has no model of the product's roles, so it
  guesses. Tanren resolves it **strictly**: products already carry **first-class
  personas** (`docs/architecture/product-entities.md`), so every design surface is
  resolved against the **actual persona set** — persona-scoped views, no guessing,
  no ambiguity. The `DesignContract` **binds to the persona graph** (WS-D1).
- **First-class behaviors → exhaustive design coverage + closing the
  designer↔implementor gap.** The given/when/then **behaviors** become design
  **acceptance criteria**: the design agent gets an **exhaustive checklist** — every
  behavior must have a designed surface / flow — and the design oracle **verifies the
  hi-fi covers every behavior**. Crucially, the **implementor builds from the SAME
  behaviors** the design was designed against — **eliminating the
  designer↔implementor disconnect** that plagues every handoff tool (where the
  design and the code are authored against different, drifting understandings of the
  product).
- **Native CI gate (`.tanren/ci.yml` over SSH) → design as a real gate tier.**
  Design / visual fidelity is a **gated check** (the design oracle is a tier in the
  native gate that feeds `MergeAuthority`), **not an afterthought export**. A
  product that fails its design contract does not merge.
- **`MergeAuthority` + never-discard base-shift → design-system changes
  propagate.** A token / design-system change is a **versioned, gated, merged
  artifact** that **re-flows through all dependent UI work via jj-rebase**
  (never-discard — `docs/architecture/tanren-owns-the-engine.md` §3) instead of
  silently drifting. Change a color token once; every dependent surface is rebased
  onto it and re-gated, not left stale.
- **Native bisection → visual / design-regression bisection.** When the design
  oracle detects fidelity drift, **bisect to the exact commit that broke the design
  contract** — the same prefix-node proof reuse that powers behavior-regression
  bisection, applied to design.
- **Demos → the hi-fi IS a live demo artifact.** The design is not a static export;
  it is a **runnable, previewable demo tied to the run.** The non-technical operator
  **watches design progress live** — the dad-test: see the product take shape, not
  read a spec.
- **Issue triage loop → design iteration through the native loop.** Operator design
  feedback and visual bugs become **issues → triaged → spec → design rework**,
  through the **SAME** issue-ingestion → triage → DAG loop as any other work — not a
  separate design tool with its own backlog.

**Thesis.** Design woven into **personas + behaviors + the CI gate + the merge
queue + bisect + demos + triage + the unified no-handoff loop** is a design
capability **structurally impossible for a standalone design tool** — because a
standalone tool has none of those subsystems and ends at the handoff Tanren does
not have. **This is the moat.**

## Vision guardrails — what NOT to do

- **No Figma-style canvas / GUI.** open-design itself rejects this —
  "kill the canvas, keep the craft." Design intent is conversational + contractual,
  not a drag-and-drop surface.
- **No baked UI stack or domain.** The contract's shape and the oracle's mode are
  **project / domain-declared**, never hardcoded (same discipline as the
  stack-flexible contract and the oracle taxonomy).
- **No dependency on Claude Design or open-design.** They are capability
  references. We absorb the concepts natively.

## Dogfooding bar

The subsystem is **"real"** when **Tanren generates its OWN `DesignContract`** (the
Tanren brand) **+ the dashboard hi-fi via the native subsystem** — replacing the
hand-done `tanren-hi-fidelity/` bundle. Until Tanren can design itself through its
own subsystem, the subsystem is not done (the same dogfooding bar the rest of the
platform is held to — see `docs/roadmap/dogfooding.md`).

## Apex integration (a gated future requirement)

The design subsystem does **NOT** block or halt the current apex fixture. apex
continues on its current bar.

**Once the subsystem is "ready to test"** (WS-D1..D4 testable), **design becomes
an added requirement of the apex fixture**: the built product must carry a real
`DesignContract` and pass the design oracle. The apex bar **gains a design
dimension** — the deployed product is no longer judged on behavior alone, but on
design fidelity against its own contract. This is a gated future requirement, not
a current gate (WS-D8).

## Actionable workstreams (the landable plan)

Ordered, each a CI-gated PR-sized unit. Dependencies noted.

- **WS-D1 — `DesignContract` entity (foundation).** A domain-general, persisted,
  versioned design-contract entity + schema. Its shape **adapts to domain** — it is
  **NOT** the web nine-sections. Captured / expanded from the Forge interview's
  design intent, **superseding the 80-char `designDna`** hint. This is the durable
  artifact. **The contract binds to the persona + behavior links** — every design
  surface resolves against the actual persona set, and the behaviors become the
  contract's design acceptance criteria (the moat). _(Foundation — WS-D2..D8 depend
  on it.)_
- **WS-D2 — inject the contract into the writer.** Thread the `DesignContract` into
  the writer / build prompt (today the writer gets **zero** design context). The
  **smallest immediate fidelity lift** and the proof of the no-handoff loop.
  _(Depends on WS-D1.)_
- **WS-D3 — design PHASE + design agent.** A native design-agent role that
  **authors the `DesignContract`** (and optional prototype artifacts) from
  interview intent + domain, as a **DAG phase** before / alongside the build. **The
  agent works the behavior checklist** — every behavior must end with a designed
  surface / flow, resolved per persona (the moat). _(Depends on WS-D1.)_
- **WS-D4 — domain-aware design ORACLE.** A design / visual verification answerer
  that **judges fidelity vs the contract**, domain-aware (render / screenshot for
  web, prose / typography for a novel, etc.), **replacing the static demo** and
  feeding findings back to **re-drive the writer**. **Checks behavior coverage**
  (every behavior has a designed surface) **and persona-scoped fidelity** (each
  surface is correct for its resolved persona), as a gate tier (the moat).
  _(Depends on WS-D1; pairs with WS-D5.)_
- **WS-D5 — design as a domain in the oracle taxonomy / entity model.** _(Originally
  specced: wire "design" into the product-entity model
  (`docs/architecture/product-entities.md`) and the oracle taxonomy so the contract's
  **shape** and the oracle's **mode** are domain-derived. Pairs with WS-D1 + WS-D4.)_

  **VERDICT: SUBSUMED by the domain-general D1/D3/D4 implementation — recommend
  closing.** The thing WS-D5 was meant to add (domain-derivation of both the
  contract shape and the oracle's verification mode, and design wired into the
  canonical entity model + oracle/answerer registry) is already what D1/D3/D4
  built, by construction. Grounded:
  - **Contract shape is domain-derived, never web-baked, never branched on.**
    `domain` is a descriptive label Tanren explicitly never switches on, and
    `dimensions` is a project/domain-declared adaptive set, not a fixed web schema
    (`services/orchestrator/src/engine/design/designContract.ts:21-28`,
    `:138-143` the `domain` label, `:156-160` the declared `dimensions`). The
    design agent **derives** the dimension set from the domain at author time
    (`designAgent.ts:113-118`, `designPhase.ts:188-194`).
  - **The oracle's verification mode is domain-derived.** `verificationMode` is a
    free string the oracle answerer **declares** from the contract — there is NO
    Tanren-side branch and NO registry of "domain → mode" anywhere
    (`designOracle.ts:11-13` "Tanren NEVER branches on the domain", `:147` the mode
    is read back off the answer; the event schema carries it as a plain string,
    `engine/events/schemas/answerer.ts:400-407`). A repo-wide search finds no
    `verificationMode` registry outside the design path. This IS the
    domain-derivation WS-D5 asked for — implemented as "the agent chooses," the
    same posture as the stack-flexible lifecycle's `stack` label.
  - **Design IS wired into the product-entity model.** The `DesignContract` binds to
    the canonical `personas` + `behaviors` entities (`product-entities.md`'s
    Persona→Behavior→Spec model) via TYPED `personaRefs`/`behaviorRefs`, resolved
    STRICTLY through the same `PersonaStore`/`BehaviorStore` the rest of the system
    uses (`designContract.ts:145-155`, `designPhase.ts:89-119`,
    `designOracle.ts:153-198`). It does not need a parallel entity; it rides the
    existing graph.
  - **Design IS registered in the canonical oracle/answerer registry.** `designOracle`
    is a first-class `AnswererRole` in the single-source answerer catalog — the
    registry that actually drives the system's codegen + drift test
    (`engine/answerers/schemas/catalog.ts:28`, `:88-93`). (Note: the
    `engine/oracle/` package is a different thing — the entity-change **RISK**
    taxonomy, `entityRiskTaxonomy.ts`; the design oracle is an **answerer**, so the
    answerer catalog is its correct canonical home, and it is already there.)

  **Only residual (doc-only, not a code gap):** `docs/architecture/product-entities.md`
  still enumerates only Persona / Behavior / Milestone / Spec and does not yet
  mention the `DesignContract` entity or its persona/behavior binding. That is a
  one-paragraph doc touch (fold it into a future WS-D7/doc-sweep PR), NOT a scoped
  WS-D5 implementation PR. **No code work remains for WS-D5.**

- **WS-D6 — design templates via template-creation.** Design capabilities as
  **templates Tanren creates + validates** (open-design's "skills" /
  "plugins-create-plugins"), through the existing template-creation meta-DAG
  (`docs/roadmap/templating-system.md`). _(Depends on WS-D1, WS-D3.)_
- **WS-D7 — dogfood.** Regenerate **Tanren's own `DesignContract` + dashboard
  hi-fi natively**, replacing the hand-done `tanren-hi-fidelity/` bundle. _(Depends
  on WS-D1..D4, ideally WS-D6.)_
- **WS-D8 — apex integration (HEADLINE remaining work — the first LIVE exercise).**
  Add the **design dimension** to the apex fixture's requirements — the built product
  must carry a real `DesignContract` and pass the design oracle. D1..D4 are now
  testable (the gate above), so this is unblocked. **This is also the missing
  validation:** the subsystem is code-complete + wired but has NOT yet run end-to-end
  on a live run — the current apex run captured **no** `designContract`, so the design
  phase + oracle no-op there (`designOracle.ts:101-104` / `loopStages.ts:164` return
  `hasContract: false`). A future apex run where the interview captures a real design
  intent — so the design phase authors a contract and the oracle verifies the built
  product against it — is what first exercises the full verify→re-drive loop on real
  credentials. _(Gated on WS-D1..D4 being testable — now satisfied.)_

## Where this fits

- **`docs/architecture/autonomy-engine.md`** — the writer / checker / auditor /
  gate model the design phase and design oracle plug into; the DAG that the design
  phase becomes a node in.
- **`docs/architecture/tanren-owns-the-engine.md`** — the doctrine this doc
  extends: own the hard part natively (jj / `MergeAuthority` / `CodeHost`). The
  never-discard base-shift / jj-rebase machinery (§3) is what re-propagates a
  design change; `auditPosture` + `MergeAuthority` (§4–§5) are what turn the design
  oracle's findings into a verdict.
- **`docs/architecture/product-entities.md`** — where the `DesignContract` entity
  and the "design" domain are wired into the product information model (WS-D1,
  WS-D5).
- **The general-build-engine doctrine** (`docs/roadmap/stack-flexible-contract.md`,
  the oracle taxonomy) — why the contract's shape and the oracle's mode are
  domain-declared, never web-baked.
- **`docs/operator-guide/apex.md`** — the live-validation fixture that gains a
  design dimension once the subsystem is testable (WS-D8).
- **`docs/roadmap/templating-system.md`** + **`docs/roadmap/dogfooding.md`** — the
  template-creation meta-DAG that design templates ride on (WS-D6), and the
  dogfooding bar the subsystem must clear (WS-D7).
- **`docs/design/hifi-revision-process.md`** + **`tanren-hi-fidelity/README.md`** —
  the hand-done bundle this subsystem ultimately replaces.
