# Tanren owns design — a native, domain-general design subsystem

> ⛔ **FROZEN — superseded; live design work is the ds-0..8 bucket in `docs/roadmap/mission-complete/nodes/design.md`.** Status: **subsystem CORE built, merged, and live-wired into the spec loop;
> remaining work is dogfood + live fixture validation + templates (WS-D5..D8).** The foundation
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
> **Live exercise state (updated 2026-07-07).** The subsystem is
> **code-complete + wired**. The first live design-phase elaboration ran in
> apex v45/v46 (and again in v47-v49): the interview captures a real
> `designContract` and `runDesignPhase` elaborates it live on real
> credentials. PR #713 (round-2 H1) made the designOracle prompt + triage
> seam `specMode`-aware so a seeded-scaffold spec doesn't receive
> coverage-gap findings against the seed surface. **Wave D1..D4 (2026-07-05
> → 2026-07-07) hardened it further:** PR #738 added the design-oracle
> finalize guard (a throw between run-finalizer and the terminal event pair
> cannot strand `running`); PR #745 replaced the silent-fallback tripwires
> with a typed error union — `DesignContractCorruptError` (persisted-record
> parse failure) / `DesignOracleActorConfigError` (actor wired without
> `orgId`) / `MalformedDesignOracleResultError` (missing/malformed
> `hasContract`) — every corrupt / inaccessible / malformed state now fails
> LOUD; PR #756 added `design_contracts.mode` (migration 0026) with
> `(project_id, mode, version)` unique index threaded through all readers.
> The apex frontier has moved past the v49 derive-halt class (task #21 via
> #703/#705) and is inside the product-build loop; a captured
> `designContract` reaches the writer prompt on every generation via the
> seam wired in #602. The **full verify→re-drive loop has not yet closed
> on a real deployed product** — no run has reached deploy → oracle
> verification → merged design-driven rework in one autonomous pass. The
> remaining step is a normal-flow apex-class fixture run carrying a real `designContract`
> through deployment and oracle verification (WS-D8).
>
> **Documented gap (Wave D4 tradeoff):** with `design_contracts.mode`,
> `deriveDesignContract` only persists on `from_scratch`. Scaffold specs
> (`specialize_seed` mode) see NO design context by construction — intentional
> (scaffolds specialize toolchain, not product identity) but widens the
> silent-skip surface vs pre-#756. Non-scaffold specs still resolve the
> persisted `from_scratch`-mode contract as before.
>
> The remaining plan below — **WS-D5..D8** — is what is left. WS-D5 is **assessed
> as SUBSUMED** by the domain-general D1/D3/D4 implementation (verdict + evidence
> in its entry); **WS-D7 (dogfood)** and **WS-D8 (live fixture validation)** are the
> headline remaining work. It does **not** block the current apex fixture, whose
> ordinary project requirements include a design contract for the general pipeline to validate live (WS-D8).

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

## Apex-class fixture validation (unblocked — close the live loop)

WS-D1..D4 are testable; the gate (WS-D8) is satisfied. The design-phase
elaboration first ran live in apex v45/v46 (and again in v47-v49); trials since
have advanced past the derive halt into the product-build loop. The fixture's
ordinary project requirements include a real `DesignContract`; the general design
oracle must evaluate it just as it would for any design-governed project. The
remaining validation step is a normal-flow run of an apex-class fixture where the
oracle verifies the built product (see WS-D8).

## e2e readiness — the design loop is wired + closes (first live elaboration exercised in apex v45/v46 — and again in v47-v49)

**Verdict: code-complete + wired, first live elaboration exercised.** WS-D1..D4
are merged and the full loop **closes end-to-end** with no live LLM, proven by a
durable, CI-gated eval harness
(`services/orchestrator/tests/designLoopE2E.test.ts`). In apex v45/v46 the
design-phase elaboration ran live for the first time (interview captured a real
contract; `runDesignPhase` elaborated it on real credentials), and apex v47-v49
re-exercised the same path on the new NixOS host; every trial since has
threaded a captured contract into the writer prompt via the seam wired in #602.
The verify→re-drive loop has not yet closed on a completed run (no deployed
product has yet been verified against its contract). The harness drives the
WHOLE loop over **one stateful in-memory entity graph**, so the contract literally
flows through the persistence seam — the design **phase**'s `DesignContractStore.create`
persists the version that the **writer-context** and the **oracle** then read via
`getLatest` (not three disconnected fakes handed pre-baked rows). The only fakes are the
two LLM seams (the design **agent** and the oracle **answerer**), which return canned
`DesignAgentAnswer` / `DesignOracleAnswer`.

**What WORKS end-to-end (proven by the harness, no live run):**

- **Authoring → persistence.** `runDesignPhase` (WS-D3) elaborates the captured
  design-intent seed into a versioned `DesignContract` covering the **full** behavior
  set (exhaustive-coverage assertion — a dropped behavior throws, never a silently
  incomplete contract; a dangling persona/behavior/dimension ref throws). The contract
  lands as HEAD version 1 and round-trips back through the schema.
- **Injection (the no-handoff half).** `resolveDesignContext` / `renderDesignContractBlock`
  / `loadDesignContextBlock` (WS-D2) load the SAME head contract and render a writer
  block carrying the contract identity / intent / domain, the **resolved personas by
  NAME** (the no-"assume admin" moat), the **behavior acceptance-criteria** (given/when/
  then), and every domain-derived, persona-scoped **dimension**.
- **Verification → re-drive currency.** `runDesignOracleStage` / `runDesignOracleLoopStage`
  (WS-D4) read the SAME head contract, **strictly resolve** its refs (an unresolvable ref
  throws — malformed graph state), drive the answerer, and normalize a coverage gap + a
  fidelity finding into the **frozen `Finding`** currency (P0–P3 + stable id, `fixHint:null`
  → absent key) — the SAME triage input as auditor/demo findings, so a genuine fidelity
  gap re-drives the writer like any other gate finding. (The live loop wiring is separately
  covered by `designOracleWiring.test.ts`: a `designOracle` task + verdict event, findings
  reaching triage, and clean no-op when no contract / no design actor.)
- **Re-elaboration gap (#619).** A behavior added AFTER derive surfaces a loud **P2**
  finding (`design-re-elaboration:<project>:<behavior>`); the already-designed behaviors
  are not double-flagged.
- **No-op paths are clean, not silently wrong.** No-contract → `hasContract: false`,
  empty findings, the oracle answerer is **never invoked**, and the writer loader yields
  `undefined` (the writer simply gets no design block). An `unscopedPlatform` (no-org)
  run yields no writer block **even when a contract exists** — it never reads off the
  wrong scope.

**What is SCOPED OUT (accepted, the follow-on):**

- **True VISUAL fidelity → WS-D4a live-render.** The oracle is **static** (read-only
  sandbox): it verifies behavior-**coverage** + static / source-readable fidelity
  (tokens / principles present in the code), and emits `design-not-verifiable` (info) for
  genuine visual fidelity (rendered pixels / screenshots). That needs the unbuilt
  **WS-D4a live-render** path and is **accepted as out-of-scope**. The oracle currently
  exercises design fidelity at the **contract-coverage + static-readability** bar, not the
  rendered-pixel bar.
- **Automatic re-elaboration trigger.** Re-running the design phase to mint a new
  contract version on a behavior-graph change is the durable follow-up; #619 ships the
  **loud-gap detection** floor, which surfaces + re-drives the gap, not the silent
  auto-re-author.

**Exact preconditions for any live project run to exercise design meaningfully:**

1. **Capture a COMPLETE persona/behavior set up front.** The design phase runs **once at
   derive**, so its `behaviorRefs` are the derive-time behavior set. Behaviors added later
   are surfaced as P2 re-elaboration findings (not auto-covered) — so a thin up-front
   capture means most design surfaces start as gaps. Capture the real persona + behavior
   set in the interview before derive.
2. **The run must carry `context.orgId`.** `designOracleSeam` (`plannerRunSeams.ts`)
   only wires the oracle when the run has an org — a no-org run silently **skips** design
   verification (it cannot resolve the entity graph). Confirm the run carries `orgId`;
   apex-class fixtures do because they use the normal org-scoped project flow. The same
   scope gate governs the writer-injection side
   (`loadDesignContextBlock` returns `undefined` for `unscopedPlatform`).
3. **A real `DesignContract` MUST be captured, or derive fails loud.** Greenfield derive
   requires the design step to capture a contract; an absent one is a loud
   `MissingDesignContractError` (#600), never a silent no-op that would disable the whole
   subsystem. A genuinely design-light project still declares an explicit minimal
   contract. Normal project intake must capture a design contract (even a minimal one).

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
- **WS-D8 — apex-class fixture validation (HEADLINE remaining work — close the live loop).**
  Require the fixture, through normal project intake, to declare a real
  `DesignContract`; the same general design oracle used by any design-governed project
  must pass it. D1..D4 are testable
  (the gate above), so this is unblocked. **Live state (updated 2026-07-04):** the
  design-phase elaboration first ran live in apex v45/v46 (and again in v47-v49);
  the interview captures a real contract and threads it into the writer prompt
  via the seam wired in #602. Task-#21 (the runner-INSERT retry loop + derive
  synchronous-wait circuit breaker that halted v49) is resolved (batch PR #705
  with the sister allocator lane #703), so the deploy leg is no longer blocked by
  that class. Round-2 audit finding H1 also made the designOracle prompt +
  triage `specMode`-aware (PR #713) — a seeded scaffold no longer surfaces
  coverage-gap findings against the pre-existing seed surface. Successive trials
  through v79 have surfaced halts inside the product-build loop (writer subtask
  sizing, plan stall recovery, template composition semantics, PR-enqueue timing,
  triage → new-spec routing on out-of-scope findings — the frontier fixed by v79
  / PR #734), each closer to but not yet at the deploy leg. The **full
  verify→re-drive loop has not yet closed** on a real deployed product — no run
  has yet reached deploy → oracle verification → merged design-driven rework in
  one autonomous pass. The remaining validation step is a normal-flow apex-class
  fixture run carrying a real `designContract` through deployment and oracle verification.
  _(Gated on WS-D1..D4 being testable — satisfied; deploy-leg blockers cleared.)_

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
