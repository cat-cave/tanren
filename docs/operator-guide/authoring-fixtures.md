# Authoring a new apex-difficulty fixture

This guide is for a contributor who wants to give Tanren a **new hard product to
build** so that more people, on more machines, can flush more engine bugs in
parallel. Read it before you invent a fixture — the single most important rule
(a fixture is _never_ engine code) is easy to break by accident.

If you have never driven Tanren before, read
[`apex.md`](./apex.md) first (the operator role — it is counterintuitive) and
[`apex-run-playbook.md`](./apex-run-playbook.md) second (the mechanical
drive-from-zero steps). This document sits alongside them: it does not tell you
how to _run_ a fixture, it tells you how to _author_ one.

---

## What a fixture actually is

An **apex-difficulty fixture is a set of rough operator notes** describing a
hard-to-build product — nothing more. You feed those notes to Tanren through the
**normal onboarding interview** (the same `POST
/orgs/:orgId/onboarding/interview/round` → `.../derive` surface any operator
uses; see the playbook §5), and then you watch Tanren try to build, deploy, and
self-heal the product on its own.

That is the whole thing. A fixture is:

- **rough notes** — a few paragraphs a non-technical product owner might write;
- **the credentials + targets** the product needs (a repo owner, a deploy
  provider, any external integration it talks to);
- **a symptom you can plant** later, worded the way a confused user would report
  a bug — so you can test the issue → triage → fix → re-verify loop.

**"apex" is a _class_ of fixtures, not a product and not a feature.** The
link-shortener-with-Slack described throughout [`apex.md`](./apex.md) and the
playbook is **one example** fixture. We want **many, and diverse** — not all web
apps, not all Slack, not all "count 100 of something." Each different product
shape stresses a different part of the engine, so a varied fixture pool flushes
bugs faster than re-running the same one.

### What a fixture is NOT

This is the rule that keeps the whole exercise honest:

- **A fixture is not engine code.** Nothing about a fixture may be hard-coded,
  documented, or custom-built _inside Tanren_. There is no "apex workflow," no
  "apex harness," no "apex mode," no fixture-specific branch, magic constant, or
  product name baked into `services/orchestrator`. (The one historical
  `TANREN_APEX_MODE` env flag was deliberately eradicated in #646 precisely
  because it was a fixture-shaped seam in the engine.)
- **A fixture is not scaffolding.** You do not pre-build a template, pre-seed the
  org `fragments` table, or hand-write any of the product repo. Tanren scaffolds
  every project the same way — by composing fragments and, on a miss, authoring
  the missing fragment through the F2 DAG (see
  [templating doctrine](../roadmap/templating-system.md)). A fixture must
  exercise that real path, not skip it.
- **A fixture is not checked into this repo.** The rough notes live in the
  _operator's_ run (or a personal notes file); they are an _input_ you type into
  the interview, not a file the engine reads. (Do not confuse apex fixtures with
  the `fixtures/` directory in this repo — those are seed repos for the separate
  [tanren-method benchmark](../roadmap/tanren-method-benchmark.md), a different
  program.)

**Why this rule matters.** apex exists to prove Tanren can autonomously build a
_max-difficulty_ project through its **normal, general** flow. If Tanren needed
anything apex-shaped to pass, the proof would be void — we would have shown only
that it can pass a rigged test, not that it builds hard projects generally.

### The corollary: a fixture that needs an engine change is a bug report

If you sit down to author a fixture and discover you _cannot_ express it, or it
_cannot_ run, without changing the engine — a missing operator API endpoint, an
unsupported deploy provider, an integration with no adapter — **that is an engine
gap, not a fixture to special-case.** File it as a GitHub issue (`label:bug` or a
node), fix it as one CI-gated PR through the normal contribution flow, and then
the fixture runs over the general surface like any other. "This hard product
surfaced a missing capability" is apex doing its job; "I hacked the engine so my
product would build" is apex being defeated.

---

## What makes a _good_ max-difficulty fixture

These are **properties that stress the engine**, described generally — they are
not a checklist baked into any code, and no two fixtures need to hit them the
same way. Aim for a product that naturally exercises as many as possible:

- **A real, external deploy target.** The product must end up live on the
  internet, not just on a laptop — deploy is a _creation dependency_, not an
  afterthought (see [`apex.md`](./apex.md) "Deploy is a creation dependency" and
  [`deploy.md`](./deploy.md)). This forces the provision → build → deploy →
  reachable-URL path to actually fire. A product with no plausible deploy story
  is a weak fixture.
- **A live external integration.** The product should talk to at least one real
  outside service (a chat platform, an email/SMS gateway, a payment or webhook
  provider, an object store). This exercises credential import, provisioning, and
  the notification/integration seams — and it is where a lot of real bugs hide.
- **A verifiable runtime behavior.** There must be some observable thing the
  built product _does_ that you can check without reading its code — a page that
  returns data, a message that arrives, a file that appears, an exit code. This
  is what lets you (as a non-technical operator) tell "it works" from "it's
  broken" the way a real user would.
- **A dependency-layered build.** The product should have more than one moving
  part that must be built in an order (a data layer under an API under a UI or CLI
  under a notifier). Layers create a multi-spec DAG with real dependencies, which
  is what the walker and the merge queue exist to coordinate.
- **A plantable bug for the self-healing loop.** There should be a natural place
  to introduce a _symptom_ — a real defect a user would notice — so you can test
  the back half: file the symptom as an issue into Tanren, then watch it
  auto-triage → spec → DAG-insert → fix → merge → re-verify. Word the plant as a
  **symptom, never a diagnosis** ("the confirmation email never arrives," not
  "the SMTP retry has an off-by-one").
- **A non-technical operator can describe it.** If expressing the product forces
  you to name frameworks, databases, or CI tools, it is too technical — that is
  the operator handing Tanren the answers, which bypasses exactly what is under
  test. Good notes talk about _what the product does for a person_, never _how_.

**Diversity beats polish.** A rough, weird, only-half-thought-out product that is
_different_ from the existing fixtures is more valuable than a beautifully
specified clone of the link-shortener. The goal for this phase is breadth of
engine coverage, not a portfolio of pretty demos.

---

## How to express a fixture

A fixture has two parts: the **rough notes** you will type into the interview,
and the **credentials/targets** the product needs.

### The rough notes

Write two-to-four short paragraphs _as the product owner_, in the voice
[`apex.md`](./apex.md) demands: what the thing is, who uses it, what "working"
looks like, and where it should live once built. Do not write specs, name
technologies, or answer as an engineer. You do not need to write the whole thing
up front — the interview is multi-round (playbook §5); you can start with the
one-line description and let Tanren's questions pull the rest out of you.

Keep one symptom in your back pocket (do not build it into the notes) for the
self-healing loop later.

### The credentials and targets

Every fixture needs, at minimum, a place for the code to land and a place for it
to deploy; most also need one integration credential. You provision these once,
per org, over the operator credential API — the playbook §3–§4 walks the exact
calls. For the full inventory (which credential, where it lives, what it proves,
and the priority tiers) read:

- [`validation-credentials.md`](./validation-credentials.md) — the
  real-connection matrix: GitHub App, deploy provider (Vercel / Fly), Slack, and
  the rest, with the canonical secrets layout and the `$50` ceiling.
- [`integration-provisioning.md`](./integration-provisioning.md) — the
  org-grant-vs-project-artifact split: what you must supply as an operator versus
  what Tanren creates for itself (a Slack channel, a deploy app, a preview URL are
  Tanren-created artifacts, **not** operator prerequisites — do not hand-create
  them).

If your fixture needs an integration Tanren has no adapter for, that is the
"engine gap → file an issue" case above, not a reason to wire something
fixture-specific.

> **Note on links.** An `external-onboarding.md` does not currently exist in this
> repo; the credential/target setup lives in the two docs above plus the playbook.
> If a dedicated external-onboarding guide lands later, link it here.

### Deploy is not optional

Because deploy is a creation dependency, name a **supported, linked** deploy
provider (`deploy.vercel` or `deploy.flyio`) in the derive call. If you omit it
or name an unlinked provider, derivation fails loud (`deploy_provider_missing` /
`deploy_not_linked`) — by design; Tanren refuses to create a product with no real
path to a live URL.

---

## Sketches: three diverse candidate fixtures

These are **illustrations of range only** — each is a paragraph of rough notes to
show what a good, non-web, non-Slack, non-"count-100" fixture can look like. They
are not blessed, pre-built, or checked in anywhere; treat them as starting points
and invent your own.

### Sketch A — a command-line tool (not a web app)

> "I want a little command-line program my team can install and run in their
> terminal. You point it at a folder of photos and it renames and sorts them into
> dated subfolders, and it can also upload the whole sorted set to our cloud
> bucket so everyone can see them. When an upload finishes it should drop a note
> into our team chat so people know new photos are up. I want to be able to
> download and install it from a real release page, not copy files around by
> hand. Success is: a non-technical teammate runs one command and their mess of
> photos comes out tidy and shared."

_Why it's good:_ a CLI (no web surface at all), a real cloud-storage integration,
a real release/distribution "deploy" target, a chat notification, and an obvious
plantable symptom ("the chat note never fires after big uploads").

### Sketch B — a scheduled data pipeline (a background service, no UI)

> "Every morning I need something that pulls yesterday's numbers from our sales
> system, cleans them up, and drops a single tidy summary file into shared
> storage — and emails me and the finance folks a two-line 'here's yesterday'
> digest. Nobody should have to click anything; it just runs on its own every
> day. If a day's data is missing or looks broken, it should email us that
> instead of silently doing nothing. It needs to run somewhere real and reliable,
> not on my machine. Success is: I stop having to build the spreadsheet by hand
> and I trust the digest enough to forward it."

_Why it's good:_ a headless scheduled service (stresses the deploy path for a
non-request-driven workload), an external data source, an object-store output, an
email integration, an error-path behavior to verify, and a natural symptom ("the
digest arrived but the totals are for the wrong day").

### Sketch C — a small hardware/IoT-style event service (a non-web backend)

> "We have a handful of temperature sensors in our storage room that can post
> their readings to a URL. I want something that catches those readings, keeps a
> history, and — this is the important part — texts whoever is on call if the
> room gets too warm for more than a few minutes. On-call should be able to reply
> to silence it for an hour. It has to be reachable from the internet so the
> sensors can reach it, and it has to be dependable because spoiled stock is
> expensive. Success is: the room stays monitored without anyone watching a
> screen, and the on-call text is fast and trustworthy."

_Why it's good:_ an ingest endpoint (not a human-facing UI), a real deploy target
the sensors must reach, an SMS integration, a stateful time-window behavior that
is genuinely verifiable, and a rich symptom surface ("the alert texts even when
the room is fine" / "the silence reply doesn't stop the pings").

---

## Where this fits

- The operator role + what is under test (read first): [`apex.md`](./apex.md)
- The mechanical drive-from-zero steps: [`apex-run-playbook.md`](./apex-run-playbook.md)
- The general operator flow: [`operator-driven-run.md`](./operator-driven-run.md)
- Credentials + targets: [`validation-credentials.md`](./validation-credentials.md) ·
  [`integration-provisioning.md`](./integration-provisioning.md) · [`deploy.md`](./deploy.md)
- Why every project scaffolds through fragments (never pre-seeded):
  [templating doctrine](../roadmap/templating-system.md)
