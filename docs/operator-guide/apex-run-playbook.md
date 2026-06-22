# apex run playbook — pilot a live apex run from a fresh checkout

This is the **concrete drive-from-zero runbook** for an apex trial: rebuild the
stack from fresh `origin/main`, authenticate as a non-technical operator over the
API, wire credentials, kick off the run from rough notes, and monitor for the next
halt. It is the operational companion to `apex.md` (the role/contract — read that
FIRST, it tells you _what is under test_ and the non-negotiable "never hand-fix the
generated repo" rule) and `operator-driven-run.md` (the general operator flow).

A fresh agent with no memory should be able to pilot an apex run from this file
alone. The run **rhythm** (drive → halt → fix-on-`main` → drain the backlog →
rebuild → fresh `v(N+1)`) and **what each run proves** live in `apex.md`; this doc
is the mechanical "how to drive a single run" half.

> **Run naming.** Each trial is `vN`, with its worktree at
> `/scratch/worktrees/tanren/v<N>` (the trials have run through **v46** as of
> 2026-06-19 — see `apex.md` for the honest proof state; the full autonomy loop
> has not yet closed end-to-end). Runs are **disposable** — `main` only moves
> forward; you never patch a run or its generated repo (see `apex.md`).

---

## 1. Rebuild the stack from a fresh `origin/main` checkout

Operate from a fresh detached worktree at `/scratch/worktrees/tanren/v<N>` — the
standing scratch-NVMe mount (8TB RAID0, faster than the boot drive). Do NOT use
`/tmp` — slower, and `/tmp` typically lives on the boot drive. Always build from a
fresh detached checkout of `origin/main`, never reuse a prior worktree.

```sh
# A worktree session leaks GIT_DIR/GIT_WORK_TREE into git commands run elsewhere —
# unset them or every git call below silently targets the wrong repo.
unset GIT_DIR GIT_WORK_TREE

# Fresh detached checkout of origin/main. The `git worktree add` invocation works
# from any clone of the repo (no hardcoded source path).
git worktree add --detach /scratch/worktrees/tanren/v<N> origin/main
cd /scratch/worktrees/tanren/v<N>

# Tear down any prior stack + its volumes (a stale DB volume will not run).
# compose's project name follows the worktree directory (`v<N>`) by default, so
# each trial is naturally isolated — no `-p` override needed.
just stack-reset

corepack enable && corepack pnpm install
```

Bring the stack up with the dev host env vars exported:

```sh
export TANREN_DEV_LOGIN=1      # enables the headless local_dev login (step 2).
export TANREN_REQUIRE_AUTH=1   # auth is enforced (apex drives the real auth surface).
just up-dev
```

`just up-dev` (recipe `runner-key gen-mtls-certs` → `up-dev`) generates
`/tmp/tanren_runner_key` and mounts it as the `tanren_runner_identity_key` compose
secret — the runner identity key is a **mounted secret file**
(`/run/secrets/tanren_runner_identity_key`), never a plaintext env value; only the
PUBLIC `TANREN_RUNNER_AUTHORIZED_KEY` line is passed via env.

The autonomy posture (autonomous audit posture + lowered CI-intelligence flaky bar)
is a per-project governed setting, configured via the same governance API any
operator would use (see **§2.5** below, after derive). Apex tests Tanren the
product, not an apex-flavored variant. (historical: previously `TANREN_APEX_MODE`
— eradicated in #646.)

Verify health before driving anything:

```sh
curl -s localhost:3100/healthz   # expect database+vault ok
```

(The orchestrator API is on `:3100`; the dashboard, if you want it, is on `:3000`.)

**Port collisions / multi-trial coexistence.** Each of the seven host-published
ports — orchestrator `3100`, postgres `5432`, runner-ssh `2222`, vault `18200`,
dashboard `3000`, ntfy `18080`, registry `5000` — has a per-port env override
(`TANREN_<X>_HOST_PORT`, e.g. `TANREN_ORCHESTRATOR_HOST_PORT=4100`), AND a
bulk-shift `TANREN_PORT_OFFSET=<N>` that adds N to every default at once. Export
`TANREN_PORT_OFFSET=100` before `just up-dev` to shift the whole stack onto
`:3200`/`:5532`/`:2322`/`:18300`/`:3100`/`:18180`/`:5100` (so a second apex trial
can coexist with the first, or to dodge an existing process on a default port).
Per-port overrides win over the offset. `just up-dev` echoes the effective set
on bring-up; `just ports` prints the same set without bringing the stack up.
**`TANREN_PUBLIC_BASE_URL` auto-tracks** the resolved orchestrator host port
(unless you export your own — operator wins), so OAuth callback URLs and the
webhook callback base are correct even when ports shift. The curl examples
below assume the defaults — substitute your chosen port if you shifted them.

---

## 2. Operator auth — headless dev-login

apex drives the **real** auth surface (no internal seams). With
`TANREN_DEV_LOGIN=1` + `TANREN_REQUIRE_AUTH=1`, mint a session from the command line (no browser) by
following the login→callback redirect:

```sh
# FOLLOW the redirect (-L): /auth/login 302s to /auth/callback, which mints the
# tanren_session cookie AND creates the `tanren-dev` org on first login.
curl -s -L -c jar -b jar "http://localhost:3100/auth/login?provider=local_dev"

# GET /auth/me returns your identity + the csrfToken. Capture the csrfToken —
# send it as `X-CSRF-Token` on EVERY mutating request (POST/PUT/PATCH/DELETE).
curl -s -b jar "http://localhost:3100/auth/me"
```

From here, resolve your `orgId` from `/auth/me` and use `-b jar` (the session
cookie) + `-H "X-CSRF-Token: <token>"` on every write below.

---

## 2.5. Flip the project into the autonomous posture (post-derive)

Apex is a project configured with the **autonomous posture** via the same
governance API any customer-shaped operator would use. The two knobs:

- `auditPosture: AUTONOMOUS_AUDIT_POSTURE` — residual P2/P3 findings route into
  the DAG and a blocking finding becomes a remediation spec, so the
  audit→finding→fix→merge loop closes with no operator. The audit-posture
  preflight FAILS LOUD on an autonomous run that did not configure this — that
  fail-closed bar is the design.
- `insightThresholds.ciInsightFlakyMinShas: 1` — a single-run flake is
  spec-eligible (the autonomous-run pattern: no operator to notice a quarantine
  awaiting a second-SHA recurrence that may never come within the run).

Both flip in ONE PUT (read-modify-write — omitted keys are untouched):

```sh
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X PUT "http://localhost:3100/orgs/$ORG/projects/$PROJ/governance" \
  -d '{
        "governancePosture": "lenient",
        "auditPosture": {
          "blockReviewAt": "P1",
          "p2p3Handling": "route-to-dag",
          "autonomousRemediation": true
        },
        "insightThresholds": { "ciInsightFlakyMinShas": 1 }
      }'
```

`$PROJ` materializes during derive (step 5), so run this PUT **AFTER step 5**.
Without it the audit-posture preflight blocks the run loudly — that is intended
and proves the bar is real.

---

## 3. BYOK Codex ($0)

apex runs at $0 by bringing your own Codex auth (BYOK replaces the managed router):

```sh
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/ai-provider" \
  -d "$(jq -n --arg a "$(cat ~/.codex/auth.json)" \
        '{provider:"codex", authJson:$a, makeDefault:true}')"
# expect providerMode: "byok"
```

---

## 4. Import org Tier-1 credentials

The provisioned credentials live in `connections.manifest.local.yaml` + the
secrets in `.env.validation.local` (inventory:
`docs/operator-guide/validation-credentials.md`). Import the three apex needs over
the org-scoped surface:

- **GitHub App** — `POST /orgs/:orgId/credentials?kind=github_app` (store the
  credential ref) then `POST /orgs/:orgId/github` (bind it as the org's GitHub
  connection).
- **Vercel deploy** — `POST /orgs/:orgId/integrations/deploy.vercel` (apex's deploy
  target — deploy is a creation dependency, see `apex.md`).
- **Slack** — `POST /orgs/:orgId/integrations/slack` (the apex domain posts to
  Slack on the 100-click threshold).

**Skip** the managed-router (BYOK replaces it) and Hetzner (the dev stack uses the
local sidecar runner). Credentials are stored by reference; their values never
appear in responses or event payloads.

---

## 5. Kick off — rough notes → spec DAG

Drive the Forge interview as a **non-technical end user** (do NOT write specs or
give technical answers — see the role rules in `apex.md`):

```sh
# Iterate interview rounds with rough, non-technical notes — the apex domain is a
# link shortener: shorten a URL + track clicks + post to Slack when a link passes
# 100 clicks + a live deployed URL.
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/onboarding/interview/round" \
  -d '{"message":"i want a link shortener that ..."}'
# ...iterate rounds as a non-technical user...

# Derive the spec DAG (this ALSO creates the greenfield repo + triggers template
# selection/creation — see step 5b).
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/onboarding/interview/derive" \
  -d '{...}'
```

### 5b. The template gate fires here — DO NOT pre-create a template

Project derivation runs the **template gate** (the templating doctrine —
`docs/roadmap/templating-system.md`): the architecture step queries the registry
for a validated template matching the captured capabilities, and on a **no-match**
it triggers **just-in-time template creation** (research → author-from-scratch →
build → validate-with-negative-controls → publish), then the scaffold **seeds
from** the created template. There is **no from-scratch-into-a-project path**: a
no-match either creates a validated template or **halts loud**
(`TemplateRequiredError` → HTTP `409`).

**Do NOT pre-create or pre-seed a template before an apex run.** apex MUST exercise
template-creation-from-scratch; if that path breaks, that is exactly the bug apex
exists to flush. Watch for the durable events `template.selection.no_match` and
`template.creation.{started,published,failed}` in the run event stream.

### 5b-postlude. Now run §2.5 to flip the project into autonomous posture

Once derive succeeds you have `$PROJ`. **Go back to §2.5** and PUT
`auditPosture: AUTONOMOUS_AUDIT_POSTURE` + `insightThresholds.ciInsightFlakyMinShas: 1`
on this project. Without it the audit-posture preflight will block the first
autonomous run with `audit.posture_strands_findings` — that fail-closed bar is
the design.

### 5c. Derive also captures a design contract

Greenfield derive runs the **design phase**: it elaborates the captured
design-intent into a versioned `DesignContract` (personas, behaviors with
acceptance criteria, persona-scoped dimensions) that the writer reads and the
design oracle later verifies the built product against. A greenfield derive with an
absent contract fails loud (`MissingDesignContractError`), so the interview must
capture a real persona/behavior set up front — a thin capture means most design
surfaces start as gaps (surfaced as P2 re-elaboration findings). The v37 design bar
is contract-coverage + static-readability (rendered-pixel fidelity is scoped out);
see `docs/roadmap/native-design-subsystem.md`.

---

## 6. Monitor over the API + recognize a halt

Drive the DagWalker to auto-execute and poll for status. All paths are org+project
scoped:

```sh
# Spec status counts (watch specs flow open → ... → merged, or park needs_attention).
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/specs"

# Runs + a single run's event stream + recovery context + DORA.
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/runs"
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/runs/$RUN/events"
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/runs/$RUN/recovery"
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/dora"
```

**Halt signals** (any of these = a finding to root-cause, NOT to patch around):

- a spec transitions to `needs_attention`,
- a run reaches `halted` (or `escape_hatch_hit` / `retry_budget_exhausted` /
  `window_exhausted`),
- the run is budget-paused (`dag.budget.paused`),
- no forward progress for a sustained window (a stall).

On a halt, read **`/runs/:runId/events`** + **`/runs/:runId/recovery`** + the
**worker and orchestrator docker logs** (`docker compose -f compose.dev.yml logs
worker orchestrator` — compose's project name defaults to the worktree directory,
e.g. `v<N>`, so no `-p` override needed when running from inside the worktree) for
the root cause. Then follow the **rhythm in `apex.md`**: fix the root cause cleanly
on `main` (zero compat residue), drain the backlog of deferrals/side-quests via
parallel agent waves to lift the platform a quality tier, then rebuild from fresh
`origin/main` and start `v(N+1)`.

---

## What the trials have proven so far (through v46)

The trials (driven over this exact playbook, BYOK Codex, $0) have proven **live**:
DAG-build from a real Forge interview (rough notes → a multi-spec DAG), walker
auto-execution, the writer authoring a scaffold, just-in-time template creation,
cost-discipline (loud NULL costs), `needs_attention` escalation + clean runner
release, and the never-discard re-drive + recovery paths. Each halt root-caused a
real bug fixed on `main` — early ones (bootstrap frozen-lockfile #496,
runner-sweeper #497, templating re-architecture #498), the non-convergence /
merge-re-gate / timeout-eradication chain (#585–#609), and the v37–v46 cluster:
runner-release org-scope leak (#636), writer must regenerate+commit derived
companions before the frozen gate (#637), ssh2 socket idle-timeout killing long
codex runs (#638), descendant `ancestor_not_ready` hot-loop (#639), and the
job-stall watchdog gap where a lock-heartbeat fooled a mtime-only liveness probe
(#640). v46 was the healthiest and furthest run — gates passing, scaffold flowing
writer→gate→checker, 0 leaks — interrupted by a planned reboot before a merge.

**What is NOT yet proven:** the full autonomy loop **with a live deploy**. No run
has yet produced a merged spec, a product build, an issue→triage→fix cycle, or a
deploy. The loops past a CI-green merged PR — deploy → issue-loop → audits →
CI-intelligence → notifications — **remain to demonstrate live**. The native
**design subsystem** is wired into derive (a `DesignContract` is captured and
verified against the build); see `apex.md` for the full honest proof state.

## Where this fits

- The role + what's under test (read first): [apex.md](./apex.md)
- The general operator flow + dashboard path: [operator-driven-run.md](./operator-driven-run.md)
- Credential inventory + where they live: [validation-credentials.md](./validation-credentials.md)
- The templating doctrine: [../roadmap/templating-system.md](../roadmap/templating-system.md)
- Halt → recover actions: [failure-recovery.md](./failure-recovery.md)
