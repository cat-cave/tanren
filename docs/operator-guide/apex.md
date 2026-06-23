# `apex` — the test of Tanren (operator role + what's actually under test)

`apex` is the one real, end-to-end run that proves **Tanren works**. Read this
before driving it — the role it puts you in is counterintuitive, and getting it
wrong invalidates the result. The full design (domain, DAG shape, proof
checklist) is `docs/architecture/autonomy-engine.md` §4; this doc is the **operating
contract for the human/orchestrator driving the run.**

> **The concrete drive-from-zero steps** (rebuild the stack from fresh
> `origin/main`, auth, wire creds, kick off, monitor) live in the companion
> **[apex-run-playbook.md](./apex-run-playbook.md)**. Read THIS doc first (the role
> and the rhythm below), then drive from the playbook.

> **Where the trials stand (through v49).** Successive apex trials — v37–v46 ran
> on the previous WSL host through 2026-06-19; v47–v49 ran on the new NixOS host
> on 2026-06-23. The chain has surfaced a long list of real bugs — all fixed on
> `main`: the never-discard re-drive paths (#585–#594), the intelligent
> non-convergence detection that replaced hardcoded attempt caps (#593), merge
> re-gating that routes a gate failure to writer rework instead of bricking the
> DAG (#601), the timeout/retry-cap eradication (#608/#609 — a run is never killed
> by elapsed time; recovery is progress/sign-of-life based), the v37–v46 cluster:
> runner-release org-scope leak (#636), writer must regenerate+commit derived
> companions (lockfile) before the frozen gate (#637), ssh2 connect-config
> socket idle-timeout killing long codex runs (#638), descendant
> `ancestor_not_ready` hot-loop (#639), and the job-stall watchdog gap where a
> lock-heartbeat fooled a mtime-only probe (#640 — structural file-count+bytes
> probe + progress-based backstop), and the v47–v49 cluster: the apex-mode
> env-var eradicated so apex now configures its autonomous posture via the same
> governance API any operator uses (#646), `.env.validation.local` bash-source
> breaking on unquoted commas (#656), Fly link route required-`orgSlug` (#658),
> and the template-build child project born without the autonomous audit posture
> (Lane T1, #659 — synthetic child now gets `AUTONOMOUS_AUDIT_POSTURE` +
> `insightThresholds.ciInsightFlakyMinShas: 1`). **v47** (dry run, 2026-06-23)
> drove §1-§4 cleanly on the new env; **v48** (real run, 2026-06-23) drove
> §1-§5; **v49** drove past this session's env + code cleanups into the live
> writer-checker-auditor LLM loop running real scaffold work and halted on a
> **legitimate pre-session tanren-code finding**: a runner-INSERT retry loop
> (`duplicate key value violates unique constraint "runners_pkey"`) between the
> run-executor and the job-reaper, compounded by derive's synchronous wait having
> no inner-failure circuit breaker (8-hour curl hang). Task #21 tracks both fixes
> — runner-INSERT idempotency + a progress/sign-of-life-based circuit breaker for
> derive's synchronous wait. The full autonomy loop has **STILL NOT closed
> end-to-end** — no merged spec, no product build, no issue→triage→fix, no deploy
> yet; those remain to demonstrate live.
>
> The **native design subsystem** is part of the build: WS-D1..D4 are merged
> and the design loop (author → inject → verify → re-drive) closes end-to-end
> in a CI-gated eval harness (no live LLM). A real run now captures a
> `DesignContract` at derive and exercises design fidelity at the
> contract-coverage + static-readability bar (rendered-pixel fidelity / WS-D4a
> live-render is scoped out).

## What is under test — and what is NOT

**Under test: Tanren itself.** Does the assembled machine — Forge ideation, the
DagWalker, parallel execution, merge coordination, the issue-ingestion → triage →
spec → DAG-insert → fix loop, budget/cost/DORA, live-preview-deploy — actually
run end-to-end against real resources, on real credentials, with no human in the
per-spec loop?

**NOT under test:**

- **Whether the URL shortener works.** It is a disposable fixture. Nobody cares if
  it ships broken. It exists only to give Tanren something real, outward-facing,
  and dependency-layered to build.
- **How efficiently Tanren reaches the goal.** This is **not** a benchmark run.
  Quality and speed are not being scored yet.

## The target right now is "functional but weak"

The bar for this phase is **the machinery runs**, not that it runs well. A run
that produces mostly broken code, needs many iterations, generates a pile of bug
reports, and posts **awful DORA metrics is a SUCCESS** — as long as every cycle
Tanren is designed to perform actually fired: notes became a brief, the DAG
executed itself, parallel specs merged, a filed issue got auto-triaged and
addressed, a deploy happened.

Only once we are confident Tanren is **functional but weak** do we build the
benchmarking suite (Workstream B) that takes it from weak → powerful. We are not
there yet. Do not optimize; just get the cycles to close.

## Your role: a non-technical end user — NOT a coding agent

You are driving Tanren as if you were a customer who **cannot read or write code**
and only knows what they wanted. This is the hard rule, because you (the
orchestrator) are a capable coding agent and every instinct will be wrong here:

- **Never fix the generated repo yourself.** Not a typo, not a missing index, not
  a broken test. The moment you hand-edit Tanren's output you have stopped testing
  Tanren.
- **When the product is broken, file an issue — into Tanren.** Report the symptom
  the way a user would ("the Slack bot never posts when a link passes 100 clicks"),
  through the **issue-ingestion adapter**, and then **monitor**: did Tanren
  auto-triage it, turn it into a spec, insert it into the DAG, prioritize, execute,
  and merge a fix? That loop firing on a real artifact is a core thing apex exists
  to prove.
- **Don't give it the answers.** Report symptoms, not diagnoses or fixes. The point
  is to find out whether the edge cases and conditions Tanren is **designed** to
  handle actually work — feeding it the solution bypasses exactly what's being
  tested.
- **Observe and record, don't intervene.** Stalls, wrong triage, dropped specs,
  budget halts — these are findings about Tanren, not problems for you to patch
  around. A stall is a Tanren bug to fix in Tanren (see next rule), not in the
  fixture repo.

## You may interact with Tanren only over the API

The only surface you touch is Tanren's **real external API** (the same one a real
operator/integration uses) — onboard, import credentials, link the repo, submit
the rough notes, drive Forge conversation, file issues, read status/cost/DORA. No
internal seams, no direct DB writes, no manual git operations on the target repo.
The `e2e-no-mock-imports` arch check enforces the no-internal-seam rule
mechanically.

**Corollary — missing endpoints get added to Tanren.** If, acting as the end user,
you need to do something and there is no API endpoint for it, that is a **Tanren
gap, not a reason to reach inside.** Add the endpoint (one CI-gated PR, real
implementation) and continue over the API. Apex surfacing a missing operator
endpoint is apex doing its job.

## Deploy is a creation dependency

`apex` is not a greenfield project with deploy added later. Before autonomous
greenfield creation, link a supported org deploy provider (`deploy.vercel` or
`deploy.flyio`) through the integration API, then include that provider in the
greenfield/onboarding request. If no provider is named, or the named provider is
not linked for the org, creation fails loudly with `deploy_provider_missing` or
`deploy_not_linked`; Tanren must not create an apex project that has no real path
to a live deploy.

## Templating: every project DAG seeds from a VALIDATED template

apex creates a greenfield project — and a greenfield project under Tanren's
doctrine does **not** scaffold from scratch into an empty repo. EVERY project DAG
executes against a known-solid **validated template**. On a no-template no-match,
project init triggers **template-creation just-in-time** (research → author →
build → validate-with-negative-controls → publish) and the scaffold **seeds from**
the created template — or **halts loud** (`TemplateRequiredError` → `409`). The
from-scratch authoring survives only as the BUILD step of template-creation:
**"the from-scratch flow IS the create-a-new-template flow."** Full doctrine:
`docs/roadmap/templating-system.md`.

**Do NOT pre-create a template before an apex run.** apex MUST exercise
template-creation-from-scratch; if it breaks, that is the bug apex exists to flush
(it is how #498 was found — an early run surfaced that the templating system had
never been exercised; subsequent runs through v36 hardened creation/budget
integrity, e.g. #592/#605). Let the no-match fire and watch
`template.selection.no_match` + `template.creation.*` in the event stream.

## The run rhythm (drive → halt → fix-on-`main` → drain → rebuild → v(N+1))

apex runs on a strict, repeatable rhythm. Each run is **disposable**; `main` only
moves forward:

1. **Drive a run until a real halting bug** (a halt signal — see the playbook §6).
2. **NEVER patch the run or hand-fix the generated repo.** A halt is a finding
   about Tanren, not a problem to patch around (the non-technical-user rule above).
3. **Fix the root cause on `main`, cleanly** — zero compat residue, real
   implementation, CI-gated.
4. **Then, in the same window, DRAIN the full backlog** — the deferrals,
   side-quests, and bug-fixes — via parallel agent waves, to lift the platform a
   quality tier. The "optional" enhancements are often exactly what clears the bar.
5. **Rebuild from fresh `origin/main`** (the playbook §1) and start a fresh
   **v(N+1)**.

## Done, for this phase

Confidence that the full loop closes at least once, weakly, on real
resources: rough notes → authored brief/DAG → autonomous parallel execution →
real merges with conflict resolution → a planted-bug issue auto-triaged and fixed
→ a live deploy — every change a merged PR, driven entirely over the API. The
output artifact is **that provenance trail**, not a working URL shortener. Then,
and only then, we formulate the benchmark.

## The proof portfolio (the goal)

apex is the vehicle for a portfolio of validated proofs that **Tanren is an
autonomous software org**. The proofs:

- **autonomy-loop** — each loop the machine is designed to run (DAG-build, walker
  auto-execution, parallel merge, issue-triage→fix, deploy, audits, CI-intelligence,
  notifications) demonstrated live + validated.
- **run-discipline** — the clean tear-down → fix-on-`main` → fresh-v(N+1) rhythm
  above, exercised repeatably.
- **critic-arc** — independent adversarial Codex refute-rounds over the code come
  back clean (treat a clean multi-round refutation as the bar).
- **cleanroom** — a fresh agent with no memory drives the whole run via the API
  only (the playbook is written to make it reproducible).
- **standing code-integrity** — the adversarial Codex audit over the platform code.

The runs **through v49** advanced the autonomy-loop (DAG-build, walker
auto-execution, template-creation, the never-discard re-drive + recovery paths),
run-discipline, and code-integrity proofs. The loops **past a CI-green merged PR**
(deploy → issue-loop → audits → CI-intelligence → notifications) remain to
demonstrate live in the next run.
