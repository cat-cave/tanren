# Running Tanren in parallel — many operators, one hardening stream

**Audience:** you are about to run Tanren on your own machine, alongside other
people running it on theirs, to flush engine bugs faster and help graduate Tanren
from _in development_ to _in beta_. You have never seen the internals. This page
explains the parallel-operation model, what keeps each operator's run isolated,
and how a bug you hit becomes a merged fix that helps everyone.

New to Tanren? Read the single-operator path first, then come back:

- [`apex.md`](./apex.md) — what a max-difficulty run _is_ and the run rhythm.
- [`apex-run-playbook.md`](./apex-run-playbook.md) — concrete drive-from-zero steps.
- [`validation-credentials.md`](./validation-credentials.md) — the credentials a run needs.
- [`operator-driven-run.md`](./operator-driven-run.md) — the operator role in one run.

---

## 1. The model: separate installs, not a swarm feature

Parallel operation is **not** a feature _inside_ Tanren. There is no "swarm mode",
no fan-out orchestrator, no shared control plane. It is simply:

> **Separate humans, on separate machines, each running a separate Tanren install
> with their own credentials, each driving a different fixture.**

A **fixture** here is a set of rough operator notes for a hard-to-build product —
the kind of max-difficulty spec Tanren is meant to build autonomously (the
link-shortener-with-Slack used in earlier trials is just _one_ example). The whole
point of running many at once is variety: different products, not all web, not all
Slack, so different runs surface different engine bugs in parallel.

Nothing about a fixture is special to the engine — you drive it through Tanren's
**normal, general** flow (design → implement → native-validate → review → merge →
deploy → observe → triage → repair → live-verify), exactly as documented in the
operator playbook. Do **not** build any per-fixture scaffolding; if a run needed
custom harnessing to pass, it would prove nothing.

Because each operator runs a full, independent stack, the only thing shared between
operators is the **GitHub repository** — the code you all improve and the issue
tracker you all file into (see §3).

---

## 2. What keeps parallel runs isolated

Two operators must never see each other's data, spend each other's credits, or
collide on a deploy target. Three mechanisms enforce that. Two of them (org scope
and deploy-target keying) hold _even within a single install that hosts multiple
orgs_, so they are the backbone of isolation whether operators are on one machine
or many.

### 2a. Per-org credentials (BYOK)

Each operator supplies their **own** provider credentials — "bring your own key"
(BYOK). The provider mode is per-org and defaults to `byok`
(`services/orchestrator/src/engine/config/orgConfig.ts` — `providerMode` defaults
to `"byok"`). Credential resolution is org-scoped and **fails loud** if an org
scope is missing rather than silently degrading: a run without a real tenant scope
raises `UnscopedOrgError`, it does not quietly fall back to a shared key (see the
`OrgScope` discriminated type in
[`services/orchestrator/src/engine/credentials/resolveCredentials.ts`](../../services/orchestrator/src/engine/credentials/resolveCredentials.ts)).
Practically: your API spend and your linked accounts are yours; another operator's
run cannot draw on them.

### 2b. Isolated deploy targets

When Tanren deploys a project's product, the deploy-app name is **namespaced by
org**, so two operators (or two projects) never fight over one global app name. The
naming rule lives in
[`services/orchestrator/src/engine/provisioners/deployAppName.ts`](../../services/orchestrator/src/engine/provisioners/deployAppName.ts):

- The base name is `<orgSlug>-<projectName>`.
- If that would exceed the provider cap (30 chars, Fly's limit), the project part
  is truncated and a deterministic 6-character hash suffix is appended:
  `<orgSlug>-<projectPart>-<6charHash>`.
- The org-slug prefix is **load-bearing and never dropped** — the code throws if
  the org slug is missing rather than emitting an un-namespaced name.

So a Fly deployment lands at `https://<orgSlug>-<project>...fly.dev`, unique per
org. Verified against the source above.

### 2c. Row-level security, per tenant

Tanren's database enforces **row-level security (RLS)**: the default runtime role
(`tanren_app`, `NOBYPASSRLS`) sees **zero** rows unless the connection is scoped to
an org first. Scope is set per request/job via the session context in
[`db/src/orgScope.ts`](../../db/src/orgScope.ts); a query off an unscoped client
returns nothing (a deliberate deny-by-default). A small privileged
`tanren_system` (`BYPASSRLS`) role exists only for platform-level bootstrap, not
for tenant queries. Net effect: even inside one shared Postgres, one org's runs,
specs, and artifacts are invisible to another org.

> **Takeaway:** org scope (2a, 2c) and deploy-target keying (2b) mean isolation is
> a property of _the org_, not _the machine_. Separate machines are the simplest
> way to run in parallel, but they are not what provides the isolation.

---

## 3. The shared contribution loop

Parallel runs are worth it because they feed **one** hardening stream. When your
run hits an engine bug (not a bug in the product Tanren is building — a bug in
Tanren itself), the loop is:

1. **File it** as a GitHub issue typed `bug`. Include the trial it surfaced on
   (e.g. "surfaced on a v-N run") and the halt class — that provenance is valuable
   and welcome. The repository carries issue and PR templates under `.github/` and a
   root [`CONTRIBUTING.md`](../../CONTRIBUTING.md) that spell out the format.
2. **Claim it.** One unit of work per person; comment to claim so two operators do
   not fix the same bug twice.
3. **Fix it in an isolated git worktree**, one PR per unit of work. Open a PR; the
   template enforces the checklist.
4. **Central audit before merge.** Every PR passes the two-layer gate below before
   it lands. No operator merges around it.

This is how many operators' runs converge: dozens of independent trials each throw
off real bugs, and they all flow through a single, audited merge queue on the
shared repo. (The live roster is GitHub issues, typed `bug` or `enhancement` and
ordered by `blocked_by`/`blocks`; the historical
`docs/roadmap/mission-complete/LEDGER.md` is deprecated and kept for history only.)

### The two-layer gate (never bypass CI)

1. **Local, mechanical.** Run `just fast-check` (typecheck, lint, format,
   architecture and drift checks) and `just ci` (the full build + test gate),
   **plus the smoke-only RLS tests** — real Postgres is ground truth, and note that
   `just ci` does **not** run the RLS integration suite. Both recipes are defined in
   the repo `justfile` (verified: `fast-check`, `ci`, and `smoke` targets exist).
   For a faster inner loop, `just affected-typecheck` / `affected-build` /
   `affected-test` run only what changed versus `origin/main`.
2. **Adversarial cross-model review.** A reviewer tries to _refute_ the change's
   fail-closed claims against a concrete negative control (a bad input that must be
   rejected). CI-green is necessary but not sufficient — a skipped test class can
   hide a real bug.

If a "flake" keeps failing, root-cause it; do not route around the gate.

---

## 4. Caveat: more than one run on a single host

You _can_ run more than one project on a single machine, but only if the **runner
allocator** gives each run its own isolated sandbox. The allocator is the component
that hands a run the container/host its work executes in. Which one boots is chosen
by the `TANREN_ALLOCATOR_KIND` environment variable
(`services/orchestrator/src/engine/allocators/buildAllocator.ts` —
`resolveBootedAllocatorKind`; unset defaults to `sidecar`). The kinds and their
isolation class (`services/orchestrator/src/engine/allocators/poolPolicy.ts`):

| Kind (`TANREN_ALLOCATOR_KIND`)                            | Taxonomy       | Per-run isolation?                                 |
| --------------------------------------------------------- | -------------- | -------------------------------------------------- |
| `static`                                                  | `fixed_pool`   | **No** — one shared, long-lived container          |
| `manual_ssh`                                              | `fixed_pool`   | No — a single pre-existing pool host               |
| `sidecar` (default)                                       | `delegated`    | Yes — the sidecar owns per-run container lifecycle |
| `hetzner`, `digitalocean`, `gcp`, `aws_ec2`, `kubernetes` | `provisioning` | Yes — a real resource created + destroyed per run  |

The **`static` allocator is unsuitable for parallel runs on one host.** It hands
every allocation the _same_ single dev-compose `runner` container (it is explicitly
`fixed_pool`: "the dev-compose static runner is a single long-lived container",
and `release()` only clears the mirror row — the container survives across runs).
Two runs sharing it would collide in one workspace. See
[`staticRunnerAllocator.ts`](../../services/orchestrator/src/engine/allocators/staticRunnerAllocator.ts).
It exists to keep `just smoke` working while preserving the security boundary (the
orchestrator holds no Docker socket), not to host concurrent product builds.

For concurrent runs on one machine, use a **per-run-isolating** allocator: the
`delegated` sidecar (each run gets its own container from the sidecar service) or a
`provisioning` cloud allocator (each run gets a fresh resource, torn down on
release). Taxonomy definitions:
[`contracts/allocator.ts`](../../services/orchestrator/src/engine/contracts/allocator.ts).

The simplest and most robust parallel setup, though, remains **one operator, one
machine, one install** — no shared allocator to reason about at all.

---

## 5. In-development → in-beta: what "ready to onboard others" means

Tanren today is _in development_: the autonomy engine is merged and the operator
path is live, but no single run has yet closed the full autonomous loop end to end
(notes → build → planted issue auto-triaged → merged fix → live deploy → a working
product) with no human in the inner loop. That honest state is tracked in the
top-level project docs — do not overclaim it.

_In beta_ is the point at which a newcomer can, from these docs alone:

1. Stand up their **own** install from a clean checkout, with their **own**
   credentials, following [`apex-run-playbook.md`](./apex-run-playbook.md).
2. Drive a fixture of their choosing through the **normal** operator flow, with no
   per-fixture scaffolding.
3. When they hit an engine bug, **file → claim → fix → audit → merge** it through
   the shared loop in §3.

The path from here to there is mechanical and additive: keep the onboarding docs
truthful and command-accurate, keep the contribution loop and its two-layer gate
enforced, and keep running **more distinct fixtures in parallel** so the bug stream
is broad. Each independent operator who can complete steps 1–3 unattended is one
more proof that the general pipeline — not a rigged demo — builds hard projects.
When enough operators can do that on enough different fixtures, Tanren is in beta.
