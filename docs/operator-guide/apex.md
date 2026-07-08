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

> **Where the trials stand (through v79, plus 60 hardening PRs closing every
> pre-v80 audit finding).** Successive apex trials — v37–v46 ran on the
> previous WSL host through 2026-06-19; v47–v49 ran on the new NixOS host on
> 2026-06-23; v65–v79 ran roughly daily on the same host across 2026-06-28 →
> 2026-07-04. Trial-driven fixes landed on `main` include the never-discard
> re-drive paths (#585–#594), intelligent non-convergence detection (#593),
> merge re-gating (#601), the timeout/retry-cap eradication (#608/#609), and
> the v37–v79 clusters (runner org-scope + writer lockfile-regeneration + ssh2
> connect-timeout + watchdog structural probe + apex-mode env eradication +
> Fly `orgSlug` + child audit posture + task #21 runner-INSERT + derive
> synchronous-wait + F2 fragment-authoring observability + wandering-halt
> convergence + atomic 3-write PR enqueue + plan-stage stall recovery +
> writer squash-before-rebase + Go/Python/Rust compose smoke + planner
> one-concern-per-subtask sizing + watchdog neighbor-floor widened to 5 +
> pnpm bootstrap non-interactive + triage routing out-of-scope findings to
> new specs at v79 #734 — the issue-triage → new-spec mechanic firing on
> real findings).
>
> **The v79-era frontier was then HARDENED (2026-07-05 → 2026-07-07)** by
> 34 PRs (#738–#768) that closed every Codex-critic (#1–#18) /
> Codex-round-3 (#1–#4) / RA1 / RA2 finding across Waves D1..D4 + E-fix +
> F: the design-oracle finalize guard + `MalformedAncestorStackError`
> classification, the v79 loop-closure end-to-end fix (auditor prompt
> no-omit + `routeOne` scope-first + `ensureFindingCoverage` +
> PARTIAL-coverage P0 synthesis + newSpecs materialization via
> `acceptProposals` + `specs` provenance columns via migration 0025);
> `demo.failed` + `usage.accounting_failed` event schemas + severity
> promotions; the design-oracle silent-fallback trio + `design_contracts.mode`
> column via migration 0026; a unified `subscribeWithReconnect` helper
> across 4 subscribers; per-stage `task.failed` emit-on-throw with 4 typed
> classifier arms; the timeout-eradication lint extended (PR #750);
> wandering-halt always-halts; walker stable `orderKey`; budget
> fails-closed on null-org; triage newSpecs dedupe via migration 0027;
> the notify wake-latch; mutation-weekly workflow restored (task #17);
> and the PR-F #693 doctrine debris sweep.
>
> **A subsequent Wave H + F2 hardening push landed 2026-07-07 — 26 more
> PRs (#774–#799)** preemptively closed the F2 authoring path (what was
> the honest v80 frontier at the start of that window). **Wave H #774–#787
> (14 PRs)** landed the canonical fixed-point signature + ATOMIC
> `createValidated` persistence seam (audit finding H2 / task #150 — one
> INSERT with `status='validated'`, no draft→flip window that the unified
> loader would silently ignore); guaranteed JIT env build reaching
> off-baseline toolchains; design contract unified on project-scope; the
> orgId invariant enforced at hydration; allocators reclassified
> provisioning vs fixed-pool vs delegated with the provider resource id
> persisted; demo non-web arms with adapter-aware surface dispatch;
> triage provenance columns SELECTed and exposed downstream; durable
> manual_external deploy attestation with human-review parked state;
> notifications with no silent stubs and a durable no-route record;
> rejecting unknown deploy tokens with `testRunner` derived per runtime.
> **F2 Round I #788–#791** added per-attempt `fragment.authoring.attempt`
> events (writer trajectory visibility) and prompt hardening (exemplars,
> slot-kind guidance, prior-org fragments, product context), plus the
> runtime-validity smoke wired in prod (#791 — #789 shipped it as dead
> code without the prod wiring, a `next@^99.0.0` fragment would persist
> as validated). **Round II #792–#795** hardened the parser to a
> balanced-brace `apply()` body walker with non-vfs statement rejection
> (`fragmentBodyWalker.ts` — the prior lazy regex truncated at the first
> `}` inside a template literal); added the iteration ceiling
> `FRAGMENT_AUTHORING_ITERATION_CEILING = 24` (arch-allow: timeout-class
> — integer count, NOT wall-clock, doctrine-compliant safety net over
> the 8-entry signature window); sanitized the signature (strips
> clock/id noise); added the batch compose post-authoring gate; and
> shipped real dep resolvers for python/go/rust. **Round III #796–#799**
> landed parseStringLiteral single-pass unescape with splitArgs
> single-quote tracking; sanitizer regex anchors with an explicit
> `org_id` filter defense; RETRACT-WITH-DELETE — the post-authoring
> batch compose rejection now DELETES the persisted row so the org's
> `fragments` table stays free of cross-run contamination (Round-III
> H1); `succeeded` DEFERRED until the batch gate passes (H4); failed
> emit carrying the REAL attempts count (H7); `skipped` batch arm
> EXPLICITLY handled as failure (M6 — no silent commit); empty
> `apply()` body rejected (M4 — the no-op stealth-downgrade class);
> pip/go/cargo live invokers wired in prod (#799 — same class as #791).
>
> The autonomous-loop machinery AND the F2 authoring pipeline are
> complete and hardened by regression pins. The full autonomy loop has
> **STILL NOT closed end-to-end** — no single run has produced merged
> spec → product build → issue→triage→fix → deploy → a working URL;
> those remain to demonstrate live.
>
> The **native design subsystem** is part of the build: WS-D1..D4 are merged
> and the design loop (author → inject → verify → re-drive) closes end-to-end
> in a CI-gated eval harness (no live LLM). A real run now captures a
> `DesignContract` at derive and exercises design fidelity at the
> contract-coverage + static-readability bar (rendered-pixel fidelity / WS-D4a
> live-render is scoped out). Post-Wave-D2/D4 the subsystem also fails LOUD
> on every corrupt / inaccessible / malformed state via the typed error
> union above, and the `design_contracts.mode` column (migration 0026) plus
> the org-scope requirement gate the writer-injection + oracle paths so
> scaffold specs no longer double-flag against the seed surface.

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

## Templating: every project DAG seeds from a fragment-composed template

apex creates a greenfield project — and a greenfield project under Tanren's
doctrine does **not** scaffold from scratch into an empty repo. EVERY project DAG
seeds from a **fragment-composed template**: derive runs `selectFragmentConfig`
over the captured lifecycle against the unified library (bundled core fragments +
the org-scoped fragments persisted by F2), composes the VFS deterministically, and
materializes it into a fresh seed repo BEFORE the writer runs. When the composed
config references a fragment the library doesn't have, derive spawns the
**per-fragment authoring DAG (F2)** — one run per missing fragment, each a
writer → validate (BNF parse + smoke composition) loop that converges by progress
to a validated `Fragment` persisted into the org's `fragments` table. A
fixed-point failure halts loud (`FragmentAuthoringFailedError` → `409
fragment_authoring_failed`); there is **no silent skip** and **no from-scratch
fallback**. Full doctrine: `docs/roadmap/templating-system.md` (PR-F #693
collapsed templating to this single fragment-only scaffold path — the
`engine/templates/creation/` meta-flow + the `template.*` event vocabulary are
gone).

**Do NOT pre-seed fragments before an apex run.** apex MUST exercise the F2
authoring path end-to-end; if it breaks, that is the bug apex exists to flush
(the modern shape of how #498 was found — an early run surfaced that the
templating system had never been exercised). Let the no-match fire and watch
`fragment.authoring.{started,succeeded,failed}` in the event stream — NOT the
removed `template.selection.*` / `template.creation.*` events.

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

The runs **through v79** — plus the 34-PR hardening wave (#738–#768) landed
2026-07-05 → 2026-07-07 and the 26-PR Wave H + F2 hardening push (#774–#799)
landed 2026-07-07 — advanced the autonomy-loop (DAG-build, walker
auto-execution, fragment composition + F2 per-fragment authoring, and the
never-discard re-drive + recovery paths), run-discipline, and code-integrity
proofs. The autonomous-loop machinery AND the F2 authoring pipeline are now
complete AND hardened with regression pins. Live-run risks previously
identified by the Claude E sweep have since been fixed on `main`: the
fixed-point signature no longer counts whitespace/comment as progress
(canonicalized via `canonicalizeBodySignature` — parses to ops when possible,
lexically normalized as fallback); the `markValidated` split window is
closed by the atomic `createValidated` seam (task #150 — no orphaned draft);
and the runtime-language recognizer + body-parse rejection vocabulary were
significantly hardened by the state-aware `fragmentBodyWalker.ts` +
non-vfs-statement rejection (Round II #792). **What is NOT yet proven for
v80: closing the full autonomous loop end-to-end.** No single run has yet
produced merged spec → product build → issue → triage → merged fix →
deploy → a working URL. That end-to-end close is exactly what apex still
has to prove. The F2 pre-hardening means the run should reach further into
the greenfield product-build loop than any prior trial before surfacing
the next real bug; the loops **past a CI-green merged PR** (deploy → the
full issue-loop firing end-to-end → audits → CI-intelligence →
notifications) remain to demonstrate live.
