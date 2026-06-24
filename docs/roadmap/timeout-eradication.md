# Timeout / retry-cap eradication — the complete inventory + the program

This is the **coordinating artifact** for a multi-PR program with one owner-stated,
**BINDING** goal: **Tanren must contain NO arbitrary timeouts, retry caps, attempt
caps, or wall-clock deadlines anywhere.** Every safety / hang-detection / robustness
mechanism must be a legitimate **PROGRESS / SIGN-OF-LIFE** solution. The doctrine of
record is the memory `feedback_no_timeouts_progress_based` (Trevor, 2026-06-17,
emphatic that this class keeps recurring); the existing models it generalizes are
`workflow/convergenceDetector.ts` and `worker/runHeartbeat.ts`.

> **Status (program COMPLETE — with EIGHT disguised survivors caught post-program by
> apex + critic-arc, all fixed).** The full eradication wave landed: #609 (foundation — `ActivityWatchdog`,
> `retryUntilConverged`, timeout-eradication lint in REPORT mode), #612–#618
> (M1..Reframe waves), #621 (progress backstop — watchdog surfaces a recoverable
> stall when work signature stops advancing), and the final wave CI-gated the lint
> so the class can never reintroduce. The doctrine stands: progress/sign-of-life
> based; `ActivityWatchdog` is the sole running-command hang detector.
>
> **EIGHT DISGUISED survivors the lint missed, found by successive apex trials +
> critic-arc audits and since fixed:**
>
> - **#638 — ssh2 `timeout:` connect-config socket option.** In ssh2, the `timeout`
>   field in the connect config is NOT a handshake bound — it is a socket-lifetime
>   IDLE timeout that fires whenever the socket has no TCP traffic (regardless of
>   whether a command is running). A long codex reasoning gap (>30 s, no stdout)
>   would kill the connection. Removed; the lint was extended to flag
>   `ssh2 connect-config timeout:` explicitly
>   (`scripts/check-architecture-timeouts.mjs`).
> - **#640 — `ActivityWatchdog` liveness probe fooled by a lock-file heartbeat.** The
>   probe used to return the single newest mtime under the workspace. A stalled tool
>   holding a heartbeat lock file (playwright `__dirlock`, re-touched every few
>   seconds while a download was wedged) advanced the newest mtime forever with zero
>   real work, so the watchdog never fired and the job hung for hours. Fixed with a
>   STRUCTURAL probe — total workspace file count + total bytes — which a
>   re-touched lock file cannot advance. Also added a progress-based
>   job-liveness backstop and reduced `keepaliveCountMax` from 1440 → 40 (≈ 6 h →
>   10 min of transport-level dead-socket detection; the keepalive is a TCP-layer
>   ping, not a work-budget).
> - **Task #21B (apex v49) — derive's synchronous wait has a progress-based
>   circuit breaker [RESOLVED].** v49 drove past this session's env + code
>   cleanups into the live writer-checker-auditor LLM loop running real scaffold
>   work and halted on a legitimate pre-session tanren-code finding: a
>   runner-INSERT retry loop (`duplicate key value violates unique constraint
"runners_pkey"`) between the run-executor and the job-reaper, compounded by
>   derive's synchronous wait having no inner-failure circuit breaker (8-hour
>   curl hang). The doctrine extension landed in
>   `services/orchestrator/src/engine/templates/creation/childRunProgressProbe.ts`:
>   a PROGRESS / SIGN-OF-LIFE based circuit breaker over the child template-build
>   project's append-only `MAX(events.id)` signature, identity-based, never
>   elapsed-time-based. A flat signature across `NON_ADVANCE_PROBES_BEFORE_STALL`
>   consecutive probes halts LOUD as `ChildRunStalledError`, wrapped through
>   `TemplateBuildFailedError` and surfaced at the derive HTTP boundary as a
>   distinct 504 `template_build_stalled` naming the stalled child project id.
>   The doctrine stands; the synchronous-wait surface is no longer a disguised
>   survivor. The sister lane (task #21A — runner-INSERT idempotency in
>   `services/allocator/**`) ships separately.
> - **v51 — per-stage `task.failed` emit-on-throw across the subtask-loop stages
>   [RESOLVED].** v51 surfaced the FIFTH disguised survivor in this family (after
>   #638 ssh2 socket-idle, #640 lock-file mtime-probe, #21B initial dag-noise
>   signal, #21C single-neighbor watchdog floor): `runPlannerStage`
>   (`services/orchestrator/src/engine/workflow/subtaskStages.ts`) had NO
>   try/catch around `invokePlanner` and emitted NO per-task terminal event.
>   When `invokePlanner` threw (e.g. `CodexUsageLimitError` when the Codex
>   5-hour subscription window exhausted), the throw escaped to the workflow
>   catch in `plannerRun.ts:489`. Run / spec / runner events rode loud at the
>   RUN granularity (`dag.spec.redriven` / `dag.spec.needs_attention` /
>   `runner.released` / `release.finalized`), but the planner's `task` row
>   stayed `running` forever with no `task.failed` event — loud at one
>   granularity, silent at another (the same shape as #640). Apex v51 DB
>   evidence: 3 planner task rows stranded `running` with NULL `outcome` and
>   NULL `ended_at`. Fix follows the writer-stage pattern: wrap the
>   answerer/writer call in try/catch, classify the throwable via the new
>   `engine/workflow/stageFailureKind.ts` helper (`window_exhausted` /
>   `timeout` / `answerer_schema_invalid` / `crashed`), `markTaskFailed` +
>   `appendEvent('task.failed', {taskKind, failureKind, message}, taskId)`,
>   re-throw so the existing workflow disposition still runs. The same sweep
>   covers `runAuditorStage`, `runCheckerStage`, `runWriterStage`,
>   `runDemoRunStage`, `runTriageStage`, `runConvergenceStage` — every stage
>   in the subtask loop that owns a per-stage `task` row. The design-oracle
>   stage is INTENTIONALLY EXEMPT: its answerer fires BEFORE the task row
>   materializes (the `hasContract` gate), so there is nothing to strand. A
>   per-stage conformance test
>   (`services/orchestrator/tests/conformance/subtaskLoopStages.test.ts`)
>   pins the contract as a standing ratchet — a future PR adding a new stage
>   without the emit-on-throw pattern fails CI. The doctrine extends:
>   "every terminal exit emits a terminal event" — at the RIGHT granularity.
> - **Task #21C (apex v50) — the ActivityWatchdog `fixed_point` floor was too
>   tight for tool-invoking agent execs [RESOLVED].** v50 surfaced the THIRD
>   #640-class disguised survivor in the watchdog family: the
>   `assessStructuralProgress` immediate-neighbor identity branch fired on a
>   SINGLE byte-identical work-signature pair (one 15s probe of identical
>   output + workspace signature), killing legitimate writers running
>   `pnpm install`. Codex's stdout is silent while the bash subprocess runs
>   (its output captured BY codex, not streamed), and concurrently the
>   workspace `find … | awk` count+bytes probe can read identical signature
>   mid-IO-burst across a single 15s tick (filesystem batched flushes; an
>   install resolves before extracting). DB evidence: 8 zero-token writer
>   rows all `exitReason="timeout"` coexist with 1 successful 2.7M-token
>   writer that happened to advance stdout / workspace every tick. Fix:
>   thread `minNonAdvancingRepeats?: number` through `assessStructuralProgress`
>   (default 1 — the writer-spec rework-loop semantics, where a single
>   byte-identical observable-work repeat IS the fixed point); the watchdog's
>   call site `isWedgedNonAdvancing` passes 2 via the new
>   `MIN_NON_ADVANCING_NEIGHBOR_REPEATS` constant: the streak floor requires
>   TWO consecutive identical immediate-neighbor pairs (≈30s of signature
>   identity) before declaring a wedge. The doctrine stands — a STREAK
>   CEILING on signature identity, NOT elapsed time; a genuinely-advancing
>   process resets it forever no matter the length. The cycle-detection
>   branch (recurrence across an intervening attempt) is unaffected — it
>   still catches A→B→A→B oscillations and works at any streak floor. The
>   companion accounting lane (task #14 / v50-B1 — gate
>   `usage.token_accounting_failed` on writer `exitReason=completed` so the
>   now-rarer mid-call kills don't double-emit) ships separately.
> - **Task #24 (apex v52/v53) — cross-layer sign-of-life bridge between the SSH
>   ActivityWatchdog and the #21B child-run progress breaker [RESOLVED].** v52
>   surfaced the SIXTH disguised survivor in this family: the watchdog
>   correctly TOLERATES a single mid-IO-burst identical probe (the v50/#21C
>   `MIN_NON_ADVANCING_NEIGHBOR_REPEATS=2` floor), BUT the breaker's
>   worker-progress signature (`MAX(events.id)` over the worker-progress
>   allowlist) was DEAF to the watchdog's tolerance — a legitimately slow
>   writer turn (6.4 min in v52, the same shape in v53) emitted NO allowed
>   event between `writer.subtask.started` and `writer.subtask.completed`,
>   the breaker fired at the streak ceiling (5 min flat at the apex-v52
>   `NON_ADVANCE_PROBES_BEFORE_STALL=10` setting, ~15 min at the v52
>   bump-to-30). #663/B2 raised the floor; this fix solves the OTHER layer.
>   The two fixes compose — the watchdog's
>   `MIN_NON_ADVANCING_NEIGHBOR_REPEATS=2` protects against substrate-internal
>   false-fire on a single ambiguous probe, and this bridge protects against
>   breaker-side compound false-fire on a writer turn the watchdog correctly
>   tolerates. The doctrine extends: SIGN-OF-LIFE PRIMITIVES MUST FLOW
>   CROSS-LAYER — the activity watchdog (the sign-of-life primitive in the
>   substrate) emits an event on every probe tick its multi-signal
>   work-signature advances, and the upstream worker-progress breaker counts
>   it. Fix: a new optional `onProgress` callback on the `ActivityWatchdog`
>   contract (`services/orchestrator/src/engine/contracts/commandSubstrate.ts`)
>   invoked from `tickWatchdog` on every advancement; threaded through
>   `buildActivityWatchdog` and every writer adapter (`codex`, `claude`,
>   `opencode`, `aider`, `pi`, `reasonix`); bound in `writerStage` to an
>   `appendEvent('writer.subtask.progress', …)` closure; `writer.%` joins
>   `WORKER_PROGRESS_EVENT_PREFIXES` so the breaker's `MAX(events.id)` filter
>   counts the bridged emissions. The doctrine stands — signature IDENTITY,
>   never elapsed time; a genuinely-advancing process resets it forever no
>   matter the length, at BOTH layers.
> - **Task #31 (critic-arc R1 #2 / R2) — 5 cloud allocators with LHS-name deadline
>   bindings the lint scanned past [RESOLVED].** A critic-arc audit surfaced the
>   EIGHTH disguised survivor cluster: all 5 cloud allocators
>   (`digitalOceanAllocator.ts`, `awsEc2Allocator.ts`, `gcpAllocator.ts` ×2 sites,
>   `kubernetesAllocator.ts`, `hetznerAllocator.ts`) carried
>   `const deadline = Date.now() + readyTimeoutMs; ... if (Date.now() >= deadline) throw`
>   — a pure wall-clock kill on slow-but-genuinely-progressing cloud provisioning. A
>   droplet/instance/pod/server the cloud was actively bringing up
>   (`new` → `active`, `pending|no-ip` → `running|no-ip` → `running|ip`) past the
>   120s default was killed mid-flight, the orchestrator destroyed the resource,
>   and the upstream run failed even though the cloud was working. **Lint
>   blind-spot extension:** the original (c) `Date.now() + … (deadline|budget)`
>   heuristic only matched when the deadline word was on the SAME line as the
>   `Date.now()` RHS — the LHS-name form (keyword before `=`) and the bare
>   comparison line (`if (Date.now() >= deadline) throw`) both scanned past it
>   (same blind-spot class as #638 ssh2 `timeout:` and #32 multi-line setTimeout).
>   Fixed with two new patterns in `scripts/check-architecture-timeouts.mjs` —
>   `(c2)` deadline-shape ASSIGNMENT (`const/let/var <name> = (?:Date|performance).now() + …`)
>   matching any deadline-class LHS (deadline / budget / expir* / expiresAt /
>   deadlineMs), and `(c3)` wall-clock kill COMPARISON
>   (`(?:Date|performance).now() <=/>=/</> X`); both honor the per-line
>   `// arch-allow: timeout-class` annotation so KEEP-list shapes (token-TTL
>   refresh windows) bless themselves at the call site. Each allocator's
>   `waitFor*` body is replaced with a call to the new shared primitive
>   `engine/allocators/readinessConvergence.ts#pollUntilReady` (mirrors
>   `withAnswererRetry` + `withSshTransientRetry`): the loop runs UNBOUNDED while
>   the per-allocator STRUCTURAL signature (`${status}|${ip-presence}`, K8s also
>   folds sorted conditions + container states) keeps advancing, and surfaces
>   LOUD as `PersistentProvisioningOutageError` only on intelligent
>   non-convergence (an IDENTICAL signature past the saturation gate
>   `STABLE_CADENCE_FLOOR = 5`). The fail-closed `UnknownProvisioningStateError`
>   ratchet — a brand-new provider state the per-allocator allowlist
>   (`DO_PROVISIONING_STATUSES` / `AWS_EC2_PROVISIONING_STATES` /
>   `GCP_INSTANCE_PROVISIONING_STATUSES` / `K8S_PROVISIONING_PHASES` /
>   `HETZNER_PROVISIONING_STATUSES`) does NOT recognize MUST throw rather than
>   silently treat the unknown state as `advancing` forever (adding a new
>   provider value forces a code change). Existing per-allocator terminal arms
>   (AWS `terminated`/`shutting-down`/`stopping`/`stopped`, K8s
>   `Failed`/`Succeeded`/`Unknown`, GCP operation `error` + the documented
>   instance terminal statuses, Hetzner `off`/`deleting`/`stopping`/`unknown`,
>   DO `off`/`archive`) fire `ProvisioningTerminalStateError` IMMEDIATELY (never
>   via the fixed-point gate). A shared conformance harness
>   (`tests/conformance/readinessConvergenceConformance.ts`) pins the 4-scenario
>   contract (advancing-unbounded / stuck-fixed-point / unknown-state /
>   terminal-arms) so a future regression on any allocator's classifier,
>   signature, or terminal-arm wiring fails CI uniformly. The doctrine extends:
>   **the LHS-name deadline shape (`const deadline = Date.now() + X`) is now a
>   first-class lint pattern**, and **every per-allocator status allowlist is a
>   fail-closed ratchet** — a new provider value cannot silently loop forever.
> - **Task #32 (critic-arc R1 #3 / R2) — three production retry caps + a multi-line
>   `setTimeout` lint blind spot [RESOLVED].** A critic-arc audit surfaced the
>   SEVENTH disguised survivor cluster: three live retry-cap survivors the
>   eradication wave left in place, plus a lint blind-spot that explains why one
>   of them was not caught earlier. (a) `ssh/transientRetry.ts` —
>   `DEFAULT_SSH_TRANSIENT_ATTEMPTS = 4` was a bounded attempt budget on the
>   transient SSH-connect retry; rewritten convergence-based (mirrors
>   `templates/creation/answererRetry.ts`): unbounded while the signature CHANGES,
>   surfaces `PersistentSshOutageError` only at the saturated identical-signal
>   fixed point. (b) `integrations/slack/slackApiTransport.ts` —
>   `SLACK_MAX_RATE_LIMIT_RETRIES = 3` AND `SLACK_MAX_RETRY_AFTER_MS = 60_000`
>   were a bounded retry budget + a clamp on the server-supplied `Retry-After`;
>   rewritten convergence-based with the clamp DROPPED entirely — Slack's
>   Retry-After IS the authoritative external constraint, so clamping it just
>   generates more 429s, and a typed `SlackRateLimited` carries the verbatim
>   wait into a `withSlack429Retry` wrapper that surfaces
>   `PersistentSlackRateLimitError` on the saturated identical-signal fixed point.
>   (c) `allocators/staticRunnerAllocator.ts` — a MULTI-LINE outer `setTimeout`
>   wall-clock guard around the TOFU host-key discovery (the ssh2 `readyTimeout`
>   was already the legitimate connect-establishment bound; the outer guard was
>   redundant + a disguised wall-clock kill on a discrete handshake). DELETED;
>   the connection's `end` event grew a listener so the no-fingerprint path
>   settles loudly without the wall-clock guard. **Lint blind-spot extension:**
>   `scripts/check-architecture-timeouts.mjs`'s single-line `timerBodyKills`
>   scanner missed the multi-line `setTimeout(\n  () => reject(...),\n  ms,\n)`
>   shape (same blind-spot class as #638 — a legitimate-looking opener line on
>   its own, but the kill verb on a continuation line the scanner never read).
>   Fixed with a small fixed-size lookahead window (4 lines) over following
>   source lines after a `setTimeout(` opener whose same-line window has no kill
>   verb, with a paired multi-line fixture in the lint's test suite.
>
> The inventory below was produced by a 3-auditor sweep and **re-verified
> file:line against `origin/main` while writing** — drift corrections are flagged
> inline (the auditors' paths predated the `services/orchestrator/src/engine/`
> relocation, and #605 + the apex-v35 convergence cutover already removed several
> items the auditors saw). All live paths are under
> `services/orchestrator/src/engine/` unless noted.

---

## 1. The doctrine + the discriminator

**"Kill on evidence of death, never on the passage of time."**

A working AI-agent process must run **UNBOUNDED**. Ten minutes is nothing to an
agent — a legitimate root-cause subtask can run far longer, and a wall-clock budget
kills exactly that legitimate work. So the test for every value in the codebase is a
single discriminator:

> **Does crossing this value, by itself, terminate legitimate work?**
> **If yes → it is FORBIDDEN.** If no (it is a cadence, a lease, a TTL, a backoff
> spacing, or a structural bound that cannot truncate real progress) → it stays, but
> must be **justified as such**, not as a safety budget.

Note that even a "no-output-for-N-minutes" quiet-window watchdog is a **disguised
timeout** and is equally forbidden — a fixed quiet window still kills a process that
is alive but quiet (deep in a long tool call). Hang detection must key off the
**absence of ALL signs of life**, never off a clock.

### The tiering (do NOT put a convergence agent everywhere)

1. **Cheap sign-of-life probe — the default, almost everywhere.** For the vast
   majority of safety / hang checks, watch a cheap activity signal: output bytes,
   provider telemetry / tokens consumed, CPU advance, workspace mtime, new commits,
   process-alive / connection-alive. **Any** sign of life → it is working →
   continue unbounded. A "hang" is the genuine absence of all of them
   (dead / deadlocked / dead-connection / zombie process). A working process is
   **never** killed.
2. **Convergence-agent — rare, goal-progress judgment only.** Reserve the expensive
   convergence-assessor (`convergenceDetector`) for the few places that need a
   judgment about whether _goal_ progress is being made — the spec→impl rework loop.
   Not for plumbing ops.
3. **Keep — cadence / lease / TTL.** Poll intervals, backoff spacing, heartbeat
   cadence, debounce windows, lease windows, token-expiry safety windows, and a
   handful of structural / external-fact bounds. These do not kill legitimate work;
   each must be justified individually (see §2 KEEP).

---

## 2. The complete inventory

### FORBIDDEN — KILL-TIMEOUTS (wall-clock kills on legitimate work)

| Site (verified file:line)                                                                                                                                                                                                                                                                      | Constant / value                                             | What it kills                                                                                                   | Replace with                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `worker/runExecutor.ts:65` _(was `:59`)_                                                                                                                                                                                                                                                       | `DEFAULT_TIMEOUT_MS = 600_000`                               | **THE ROOT.** Threaded as `timeoutMs` through ~60 files into every agent exec + every SSH / git / jj / gate op. | substrate `ActivityWatchdog` on `ssh.run`                                                        |
| `ssh/ssh2Substrate.ts:98`                                                                                                                                                                                                                                                                      | `state.timer = setTimeout(… → destroy)`                      | the SSH-side terminus — destroys the channel at the cap.                                                        | watchdog reset-on-activity                                                                       |
| `providers/codex.ts:150` _(`return failedResult("timeout", …)`; was cited as `:228 throw`)_                                                                                                                                                                                                    | `opts.timeoutMs` → `codex.timedOut`                          | the codex writer exec terminus.                                                                                 | watchdog (the `Math.min(opts.timeoutMs, 30_000)` clamps at `:99/:138` are a separate sub-op cap) |
| `providers/claude.ts:113` _(`return failedResult("timeout", …)`; was cited as `:165`)_                                                                                                                                                                                                         | `opts.timeoutMs` → `claude.timedOut`                         | the claude writer exec terminus.                                                                                | watchdog                                                                                         |
| `merge/coordinatorBuild.ts:49` _(was `:48`)_                                                                                                                                                                                                                                                   | `DRIVE_RESOLVER_TIMEOUT_MS = 600_000`                        | the merge drive/resolver op.                                                                                    | watchdog                                                                                         |
| `merge/batchCoordinatorBuild.ts:31` _(was `:29`)_                                                                                                                                                                                                                                              | `BATCH_GATE_TIMEOUT_MS = 600_000`                            | the batch gate op.                                                                                              | watchdog                                                                                         |
| `dag/baseShiftLiveSeams.ts:54` _(was `:45`)_                                                                                                                                                                                                                                                   | `BASE_SHIFT_TIMEOUT_MS = 600_000`                            | the jj base-shift op.                                                                                           | watchdog                                                                                         |
| `providers/liveJjWorkspace.ts:56` _(was `:49`)_                                                                                                                                                                                                                                                | `DEFAULT_LIVE_JJ_TIMEOUT_MS = 600_000`                       | per-jj-command cap.                                                                                             | watchdog                                                                                         |
| `benchmark/liveAccept.ts:55`                                                                                                                                                                                                                                                                   | `DEFAULT_ACCEPT_TIMEOUT_MS = 600_000`                        | benchmark accept op.                                                                                            | watchdog                                                                                         |
| `benchmark/liveAwait.ts:36` + `benchmark/runner.ts:141`                                                                                                                                                                                                                                        | `DEFAULT_TRIAL_TIMEOUT_MS = 1_800_000`                       | a whole-trial 30-min deadline.                                                                                  | watchdog / convergence per-step                                                                  |
| `services/allocator/src/main.ts:28` + `sweeper.ts` + `runnerLifecycle.ts:371` (`sweepStuck(maxRunHours)`)                                                                                                                                                                                      | env `TANREN_MAX_RUN_HOURS` (default 6)                       | reaps / destroys a runner by **6h wall-clock AGE** regardless of progress.                                      | heartbeat-staleness (no lease renewal = dead)                                                    |
| 7× forge answerer wrappers — `forge/conversation/answerer.ts`, `forge/discovery/providerAnswerer.ts`, `forge/interview/providerAnswerer.ts`, `forge/inbox/providerAnswerer.ts`, `forge/specQuality/validator.ts`, `forge/audits/auditAnswerer.ts`, `forge/brownfield/providerReconAnswerer.ts` | `timeoutMs ?? 120_000 / 180_000`                             | each answerer LLM call.                                                                                         | watchdog                                                                                         |
| `deploy/buildDeployAdapter.ts:171–172` (`defaultVerifyPollPolicy`) consumed by `deploy/directApiDeployAdapter.ts:104`                                                                                                                                                                          | `maxPolls: 60 × intervalMs: 5000` (5-min)                    | the deploy never-ready guard.                                                                                   | sign-of-life on the deploy status stream + convergence on "is it progressing toward READY?"      |
| `templates/validationHarness.ts` (the gate timeout that yields `could_not_run`)                                                                                                                                                                                                                | the per-gate `timeoutMs` (input `:73`, threaded `:139/:157`) | a gate that times out.                                                                                          | **remove the gate timeout entirely** — let the watchdog govern the gate; see drift note below    |

> **DRIFT — `validationHarness.ts`.** The auditors flagged "a gate TIMEOUT counts
> as _proven_ (fabricates a passing template proof)". That specific bug is **already
> fixed** (#605): a gate timeout now maps to `could_not_run` → **`unproven`** (a
> loud INDETERMINATE), explicitly _"an infra timeout is NEVER a meaningful
> negative-control pass"_ (`:18`, `:197–205`). What **remains** for this program is
> only the underlying gate timeout itself — the kill-timeout must go (replaced by
> the watchdog), since `could_not_run` should mean "the gate genuinely could not
> run", not "we killed it on a clock".

### FORBIDDEN — RETRY / ATTEMPT CAPS (terminal give-ups)

| Site (verified)                                     | Cap                                                                             | Notes / drift                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `worker/runExecutor.ts:66`                          | `DEFAULT_MAX_CI_POLLS = 18`                                                     | CI poll give-up.                                                                                                     |
| `workflow/reviewMerge/reviewPolling.ts:191`         | `maxPolls ?? 12`                                                                | review poll give-up.                                                                                                 |
| `merge/batchCoordinator.ts:41`                      | `MAX_INFRA_RETRIES = 2`                                                         | batch infra retry cap (loop at `:317`).                                                                              |
| `postMerge/deployOnMerge.ts:60`                     | `DEFAULT_VERIFY_MAX_ATTEMPTS = 3`                                               | deploy-verify cap (`:343`).                                                                                          |
| `forge/specQuality/stage.ts:83`                     | `maxRevisions`                                                                  | bounded spec-revision loop.                                                                                          |
| `contracts/jobQueue.ts:29` + `db/src/schema.ts:258` | `DEFAULT_MAX_ATTEMPTS = 5` → `dead_letter`; `max_attempts integer … default(5)` | job-queue dead-letter cap.                                                                                           |
| `forge/conversation/engine.ts:68`                   | `DEFAULT_MAX_TOOL_ROUNDS = 3` (`maxToolRounds`)                                 | **BORDERLINE** — a misbehaving-answerer guard; reframe off the count onto tool-call progress.                        |
| github HTTP client retries (2 / 3)                  | transient-retry counts                                                          | **BORDERLINE** — these are transient-error backoff, not work-killers; reframe to retry-on-transient-until-converged. |

> **DRIFT — three caps the auditors listed are ALREADY GONE on `main`.** Do not
> re-introduce them as work items:
>
> - `config/shared.ts` — `maxWriterIterPerSubtask = 5` and
>   `maxRetriesPerTransientFailure = 3` (and `maxSpecDiscoveryRoundsWithForge`) are
>   **deleted** (apex; the old `EscapeHatches` block, `:60–69`). The writer inner
>   loop is now the convergence detector. `tanrenConfigGate.ts` no longer propagates
>   them.
> - `workflow/plannerRun.ts` — `maxReworks = 1` (and `maxReviewReworks` /
>   `maxMergeGateReworks`) **removed apex-v35** (`:247`, `:358`): _"never a
>   hardcoded rework count"_ — the loop now ends on merge / fixed-point halt /
>   non-pass re-drive, decided by the convergence model.
>
> So the spec→impl rework spine is **already** progress-based; this program does not
> need to touch it.

### JUDGE / REFRAME (keep the behaviour — already alert-and-keep-driving, NOT terminal — but reframe off the count)

These three `MAX_*_ATTEMPTS = 5` _infra-hold_ ceilings already do the right thing on
crossing (alert + keep driving / surface a recoverable hold, **not** discard work).
The fix is cosmetic-doctrinal: reframe the trigger off the count and onto
"is the infra recovering?" (the dead-connection / no-recovery sign-of-life signal),
so no count appears in the code or the docstring.

| Site (verified)                     | Constant                                     |
| ----------------------------------- | -------------------------------------------- |
| `merge/coordinator.ts:51`           | `MAX_INFRA_HOLD_ATTEMPTS = 5` (`:311`)       |
| `merge/recoverableDriveHold.ts:26`  | `MAX_RECOVERABLE_DRIVE_ATTEMPTS = 5` (`:41`) |
| `merge/batchInfraHoldCeiling.ts:23` | `MAX_BATCH_INFRA_HOLDS = 5` (`:146`)         |

### KEEP (the model + legitimate cadence / lease / TTL — each justified as non-budget)

| Site (verified)                                                                                                                 | What it is                          | Why it is NOT a budget                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflow/loopPolicy.ts` `applyConvergencePolicy`                                                                               | **THE MODEL** — progress-based halt | there is **no** `maxConsecutiveStalls` count (`:85`, `:127`); it halts on intelligent non-convergence, not a clock or a counter.                                                                                                                                                                                                                                         |
| `worker/runHeartbeat.ts`                                                                                                        | **THE SIGN-OF-LIFE mechanism**      | lease-renewal heartbeat; it _is_ the activity signal others should adopt.                                                                                                                                                                                                                                                                                                |
| poll intervals (`reviewPolling`, deploy `intervalMs: 5000`, etc.)                                                               | **how often** to check              | a cadence, not a deadline; remove the _bound_, keep the _interval_.                                                                                                                                                                                                                                                                                                      |
| backoff spacing (`merge/mergeSerializedRetry.ts`)                                                                               | between-retry spacing               | spacing, not a cap.                                                                                                                                                                                                                                                                                                                                                      |
| `worker/runExecutor.ts:74` `DEFAULT_LEASE_MS = 60_000`; `contracts/jobQueue.ts:27` same                                         | claim lease window                  | a lease (renewed by heartbeat); expiry = the holder is dead, not "out of time".                                                                                                                                                                                                                                                                                          |
| `merge/mergeClaimLease.ts:7` `MERGE_CLAIM_LEASE_MS`; `postMerge/issueClaimStore.ts:22` `POST_MERGE_CLAIM_LEASE_MS` (both 15min) | merge / issue claim leases          | same lease semantics.                                                                                                                                                                                                                                                                                                                                                    |
| `providers/githubAppTokenMinter.ts:22` `EXPIRY_SAFETY_WINDOW_MS = 60_000`; `:24` `APP_JWT_TTL_SECONDS = 540`                    | token TTL / safety window           | a real external constraint (the forge expires the token); refresh-before-expiry, not a work-killer. (The scoped-run-token TTL family in Vault is the same class.)                                                                                                                                                                                                        |
| debounce windows                                                                                                                | event debounce                      | a cadence.                                                                                                                                                                                                                                                                                                                                                               |
| `merge/batchCoordinator.ts:211` `maxIterations = eligibleCount + 1`                                                             | **structural** loop bound           | bounded by the batch SIZE, not a clock — it cannot truncate progress (one iteration per eligible member + 1).                                                                                                                                                                                                                                                            |
| `merge/mergeSerializedRetry.ts:4` `MAX_NODE_TIMER_DELAY_MS = 2_147_483_647`                                                     | **Node clamp**                      | the platform's max `setTimeout` delay; a correctness clamp, not a budget.                                                                                                                                                                                                                                                                                                |
| `ssh/keygen.ts:56` `KEYGEN_MAX_ATTEMPTS = 8`                                                                                    | pure-CPU keygen retry               | regenerates a malformed ed25519 key; pure-CPU, failure probability < 1e-21 — never gates real work.                                                                                                                                                                                                                                                                      |
| `db/src/client.ts`                                                                                                              | **NO statement / lock timeouts**    | must **STAY ABSENT** — adding a `statement_timeout` / `lock_timeout` here would be a disguised kill-timeout on legitimate long queries. Warn against ever adding one.                                                                                                                                                                                                    |
| `services/allocator/src/dockerEngine.ts:105` `stopContainer(timeoutSeconds = 5)`                                                | docker stop grace                   | a 5s SIGTERM→SIGKILL teardown grace on a container we are _already_ destroying — not a work budget.                                                                                                                                                                                                                                                                      |
| `engine/templates/creation/childRunProgressProbe.ts CHILD_PROGRESS_PROBE_CADENCE_MS`                                            | probe cadence                       | how often to read the child project's audit signature; trigger is signal IDENTITY across probes, never elapsed time.                                                                                                                                                                                                                                                     |
| `engine/templates/creation/childRunProgressProbe.ts NON_ADVANCE_PROBES_BEFORE_STALL`                                            | non-advance streak ceiling          | identity ceiling at 30 probes (~15 min at the 30s cadence) — bumped from 10 in apex v52 after evidence showed a single legitimate Codex writer turn can run 6-8 min with no allowlisted event between `writer.subtask.started` and `writer.subtask.completed`; a working child resets every probe — same class as `runHeartbeat.ts atRiskThreshold` non-advancing-beats. |

---

## 3. The two replacement primitives

Both are being built in parallel on `feat/liveness-watchdog-foundation`.

1. **`LivenessProbe` / `ActivityWatchdog` — replaces kill-timeouts.** Wraps
   `ssh.run` (and the agent execs that ride it). It is **multi-signal**: output
   bytes, provider telemetry / tokens, CPU advance, workspace mtime — **any** of
   these advancing resets the watchdog. It **never kills a working process**; it
   surfaces only a genuine, recoverable **stall** (all signals flat = dead /
   deadlocked / dead-connection). This replaces every `timeoutMs`-threaded
   kill-timeout in §2.
2. **`retryUntilConverged` — replaces attempt / poll caps.** Wraps the existing
   `convergenceDetector`: retry-on-transient + intelligent non-convergence detection
   (same failure, no progress → escalate), with **no count**. This replaces every
   `MAX_*` / `maxPolls` / `maxAttempts` give-up in §2 (FORBIDDEN — RETRY CAPS) and
   reframes the JUDGE ceilings.

Plus the **enforcement lint** — `scripts/check-architecture-timeouts.mjs` (joins the
existing `scripts/check-architecture-*.mjs` family). It flags literal kill-timeouts,
`MAX_*_ATTEMPTS` / `maxPolls` / `maxAttempts` caps, AND disguised fixed-quiet-window
watchdogs, with an allowlist for the justified KEEP set. Ships **report-mode** first,
flipped to **CI-gating** in the final wave so the class can never reintroduce.

---

## 4. The eradication waves (ordered, foundation-first)

Each wave is one or more CI-gated PRs.

- **Foundation.** Build `LivenessProbe` / `ActivityWatchdog` + `retryUntilConverged`;
  wire the watchdog into the SSH substrate (`ssh/ssh2Substrate.ts`); add
  `check-architecture-timeouts.mjs` in **report-mode**.
- **M1 — providers (the 6 CLIs).** Remove the provider-side kill-timeouts /
  `timeoutMs` termini (`providers/codex.ts`, `providers/claude.ts`, and the other CLI
  providers) onto the watchdog. (Keep the `Math.min(…, 30_000)` _sub-op_ clamps only
  if they govern a genuinely bounded probe, else fold them in too.)
- **M2 — workflow stages + `plannerRun` web.** The CI/review poll caps
  (`runExecutor.ts:66 DEFAULT_MAX_CI_POLLS`, `reviewPolling.ts:191`) onto
  `retryUntilConverged`. (The rework spine is already done — see §2 drift.)
- **M3 — merge + dag.** `coordinatorBuild.ts DRIVE_RESOLVER_TIMEOUT_MS`,
  `batchCoordinatorBuild.ts BATCH_GATE_TIMEOUT_MS`, `baseShiftLiveSeams.ts
BASE_SHIFT_TIMEOUT_MS`, `liveJjWorkspace.ts DEFAULT_LIVE_JJ_TIMEOUT_MS` onto the
  watchdog.
- **M4 — the count give-ups.** `batchCoordinator.ts MAX_INFRA_RETRIES`,
  `deployOnMerge.ts DEFAULT_VERIFY_MAX_ATTEMPTS`, `specQuality/stage.ts maxRevisions`,
  `jobQueue.ts DEFAULT_MAX_ATTEMPTS` + `db/src/schema.ts max_attempts` (dead-letter
  off convergence, not a count), and the borderline `conversation/engine.ts
maxToolRounds` + github HTTP retries — all onto `retryUntilConverged`.
- **M5 — the tail.** allocator `TANREN_MAX_RUN_HOURS` → heartbeat-staleness reaping
  (no lease renewal = dead); the 7 forge answerer `timeoutMs ?? 120/180k`; the
  benchmark trial deadline (`liveAwait.ts` / `runner.ts DEFAULT_TRIAL_TIMEOUT_MS`);
  deploy `buildDeployAdapter.ts maxPolls/intervalMs`; `validationHarness.ts` —
  **remove the gate timeout entirely**.
- **Reframe.** The three §2 JUDGE infra ceilings (`MAX_INFRA_HOLD_ATTEMPTS`,
  `MAX_RECOVERABLE_DRIVE_ATTEMPTS`, `MAX_BATCH_INFRA_HOLDS`) — keep the
  alert-and-keep-driving behaviour, reframe off the count.
- **Final PR.** Remove the `timeoutMs` path from `runExecutor.ts` and the ~60
  files it threads through; **flip `check-architecture-timeouts.mjs` to CI-gating**.

**Low-priority tail (note, not a blocker):** the test / smoke harness bounds under
`scripts/acceptance/**` and `scripts/smoke/**` carry their own wall-clock bounds.
These bound _Tanren's own CI_, not the delivery path it builds for, so they are the
lowest-priority sweep — addressed only after the live paths above are clean.

---

## 5. Cross-links (the existing models)

- **Doctrine of record:** memory `feedback_no_timeouts_progress_based` (plus the
  precursors `feedback_no_hardcoded_attempt_caps`, `feedback_no_whole_dag_deadline`).
- **The convergence model:** `services/orchestrator/src/engine/workflow/convergenceDetector.ts`
  and its policy `workflow/loopPolicy.ts` (`applyConvergencePolicy`) — the
  goal-progress judge that `retryUntilConverged` wraps.
- **The sign-of-life mechanism:** `services/orchestrator/src/engine/worker/runHeartbeat.ts`
  — the lease-renewal heartbeat, the template for the cheap activity signal.
