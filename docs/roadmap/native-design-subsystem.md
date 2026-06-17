# Tanren owns design — a native, domain-general design subsystem

> Status: **roadmap / not built.** This is the design rationale + the landable
> plan for a Tanren-NATIVE design subsystem. Nothing here is wired yet; the
> workstreams (WS-D1..D8 below) are the ordered, CI-gated, PR-sized units of
> work. It does **not** block or halt the current apex fixture — but once the
> subsystem is "ready to test," design becomes an added requirement of apex
> (WS-D8).

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
  artifact. _(Foundation — WS-D2..D8 depend on it.)_
- **WS-D2 — inject the contract into the writer.** Thread the `DesignContract` into
  the writer / build prompt (today the writer gets **zero** design context). The
  **smallest immediate fidelity lift** and the proof of the no-handoff loop.
  _(Depends on WS-D1.)_
- **WS-D3 — design PHASE + design agent.** A native design-agent role that
  **authors the `DesignContract`** (and optional prototype artifacts) from
  interview intent + domain, as a **DAG phase** before / alongside the build.
  _(Depends on WS-D1.)_
- **WS-D4 — domain-aware design ORACLE.** A design / visual verification answerer
  that **judges fidelity vs the contract**, domain-aware (render / screenshot for
  web, prose / typography for a novel, etc.), **replacing the static demo** and
  feeding findings back to **re-drive the writer**. _(Depends on WS-D1; pairs with
  WS-D5.)_
- **WS-D5 — design as a domain in the oracle taxonomy / entity model.** Wire
  "design" into the product-entity model (`docs/architecture/product-entities.md`)
  and the oracle taxonomy so the contract's **shape** and the oracle's **mode** are
  **domain-derived**. _(Pairs with WS-D1 + WS-D4.)_
- **WS-D6 — design templates via template-creation.** Design capabilities as
  **templates Tanren creates + validates** (open-design's "skills" /
  "plugins-create-plugins"), through the existing template-creation meta-DAG
  (`docs/roadmap/templating-system.md`). _(Depends on WS-D1, WS-D3.)_
- **WS-D7 — dogfood.** Regenerate **Tanren's own `DesignContract` + dashboard
  hi-fi natively**, replacing the hand-done `tanren-hi-fidelity/` bundle. _(Depends
  on WS-D1..D4, ideally WS-D6.)_
- **WS-D8 — apex integration.** Add the **design dimension** to the apex fixture's
  requirements — the built product must carry a real `DesignContract` and pass the
  design oracle. _(Gated on WS-D1..D4 being testable.)_

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
