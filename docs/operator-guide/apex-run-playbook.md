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
> `/scratch/worktrees/tanren/v<N>`. Successive apex trials — v37–v46 ran on the
> previous WSL host through 2026-06-19; v47–v49 ran on the new NixOS host in
> 2026-06-23 — see `apex.md` for the honest proof state; the full autonomy loop
> has not yet closed end-to-end. Runs are **disposable** — `main` only moves
> forward; you never patch a run or its generated repo (see `apex.md`).
>
> **Picking `<N>`:** look at `ls /scratch/worktrees/tanren/` and pick the next integer after the highest existing trial. The compose project name follows the worktree directory name automatically (e.g. `v47`), so no `-p` override is needed.

---

## 1. Rebuild the stack from a fresh `origin/main` checkout

Operate from a fresh detached worktree at `/scratch/worktrees/tanren/v<N>` — the
standing scratch-NVMe mount (8TB RAID0, faster than the boot drive). Do NOT use
`/tmp` — slower, and `/tmp` typically lives on the boot drive. Always build from a
fresh detached checkout of `origin/main`, never reuse a prior worktree.

**One-time secrets setup.** Apex needs three files in the worktree at boot:
`.env`, `.env.validation.local`, `connections.manifest.local.yaml`. They live
canonically in `${TANREN_SECRETS_DIR:-~/.config/tanren/secrets}/` (gitignored,
0700 dir, 0600 files); each worktree symlinks them in via `just secrets-link`
(auto-called by `just up-dev`). If your secrets currently live inline in your
main checkout, run `just secrets-migrate` once from that checkout — it moves the
three files to the canonical location and symlinks them back, so the main
checkout keeps working and every fresh worktree sees the same set. See
`validation-credentials.md` § "Canonical secrets layout".

**Apex must run in the default `canonical` secrets mode** — never set
`TANREN_SECRETS_MODE=dev-defaults`. That mode links `.env -> .env.example`
(compose-friendly defaults, no real Hetzner/Slack/GitHub-App credentials) and
exists only for CI / smoke runs where the canonical secrets dir is absent. If
you set it for apex, the run will boot but cred resolution will fail loud the
moment it needs a real GitHub App or Vercel token. The default is correct;
leave it unset.

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

**What's normal on a fresh `up-dev`.** This box's podman GCs daily; if your last
run was >24 h ago, expect `up-dev` to re-pull base images and re-build the
orchestrator+worker images. A re-pull/re-build there is **not** a finding; it's
the GC contract.

`just up-dev` (recipe `runner-key gen-mtls-certs` → `up-dev`) generates
`/tmp/tanren_runner_key` and mounts it as the `tanren_runner_identity_key` compose
secret — the runner identity key is a **mounted secret file**
(`/run/secrets/tanren_runner_identity_key`), never a plaintext env value; only the
PUBLIC `TANREN_RUNNER_AUTHORIZED_KEY` line is passed via env.

The autonomy posture (autonomous audit posture + lowered CI-intelligence flaky bar)
is a per-project governed setting. Under `autonomy: "auto"` (apex's derive call)
it is **applied atomically with project creation** (task #79) — derive lands the
review/merge axes, `AUTONOMOUS_AUDIT_POSTURE`, and
`insightThresholds.ciInsightFlakyMinShas: 1` in the same project insert, so the
DagWalker (which auto-claims within seconds) cannot observe a partially-configured
project. The §2.5 governance PUT remains the operator surface for **non-auto**
projects or for **adjusting posture later**; apex no longer needs to run it. Apex
tests Tanren the product, not an apex-flavored variant. (historical: previously
`TANREN_APEX_MODE` — eradicated in #646.)

Verify health before driving anything:

```sh
curl -s localhost:3100/healthz | jq .
# expected:
# {
#   "service": "orchestrator",
#   "ok": true,
#   "database": "ok",
#   "vault": { "ok": true, "status": 200 }
# }
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
# FOLLOW the redirect (-L): /auth/login 302s to /auth/callback. The callback
# MINTS the tanren_session cookie (captured into the jar by -c) AND returns the
# identity JSON we need — capture both the cookie AND the body in one shot.
LOGIN_BODY=$(curl -s -L -c jar -b jar "http://localhost:3100/auth/login?provider=local_dev")

# /auth/callback returns: { ok, user, orgs:[{id,login,displayName}], primaryOrgId, csrfToken }.
# Bind ORG + CSRF as shell vars — every §3+ snippet uses them as-is.
ORG=$(jq -r '.primaryOrgId' <<<"$LOGIN_BODY")
CSRF=$(jq -r '.csrfToken'   <<<"$LOGIN_BODY")
echo "ORG=$ORG"
echo "CSRF=$CSRF"   # send as X-CSRF-Token on EVERY mutating request (POST/PUT/PATCH/DELETE).

# Optional session-liveness probe. /auth/me returns ONLY { userId, csrfToken, expiresAt }
# — it does NOT carry orgId (that came from /auth/callback above). Useful to confirm
# the cookie still authenticates; not a source of $ORG.
curl -s -b jar "http://localhost:3100/auth/me" | jq .
```

From here every write below uses `-b jar` (the session cookie) + `-H "X-CSRF-Token: $CSRF"`, and every org-scoped path interpolates `$ORG`.

---

## 2.5. Project governance posture — operator surface (apex skips this)

Apex's derive (`autonomy: "auto"`, §5) atomically pre-applies the autonomous
posture at project insert — review/merge axes, `AUTONOMOUS_AUDIT_POSTURE`,
and `insightThresholds.ciInsightFlakyMinShas: 1` — so the DagWalker (which
auto-claims within seconds) never sees a partially-configured project (task
#79). **Apex skips this section.** The two knobs the autonomous posture sets:

- `auditPosture: AUTONOMOUS_AUDIT_POSTURE` — P2/P3 findings route into the
  DAG, blocking findings become remediation specs, so audit→fix→merge closes
  with no operator. The audit-posture preflight FAILS LOUD when an autonomous
  run lacks this — fail-closed by design.
- `insightThresholds.ciInsightFlakyMinShas: 1` — a single-run flake is
  spec-eligible (no operator to notice a quarantine awaiting recurrence).

For non-auto projects (`human`/`simulated`) or to flip an existing project,
PUT (read-modify-write — omitted keys untouched):

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

---

## 3. BYOK Codex ($0)

apex runs at $0 by bringing your own Codex auth (BYOK replaces the managed router):

Using `$ORG` and `$CSRF` as bound in §2:

```sh
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/ai-provider" \
  -d "$(jq -n --arg a "$(cat ~/.codex/auth.json)" \
        '{provider:"codex", authJson:$a, makeDefault:true}')" | jq .
# expect: { provider:"codex", ref:"credential/codex/org/<orgId>/default",
#           classifiedAs:"subscription/openai", isDefault:true }
```

---

## 4. Import org Tier-1 credentials

The three Tier-1 imports apex needs over the org-scoped surface — GitHub App,
Vercel deploy, Slack. Each shows the body shape the API actually validates; the
operator sets the `$VAR` placeholders from whatever local secret source they keep
(e.g. their `connections.manifest.local.yaml` + `.env.validation.local`). Real
secret values NEVER appear in this doc, in the request URL, or in any response or
event payload — only refs.

**Skip** the managed-router (BYOK in §3 replaces it) and Hetzner (the dev stack
uses the local sidecar runner).

### 4.a. GitHub App (store + bind)

```sh
# 4.a-i — Store the github_app credential (appId + private-key PEM).
#   $GH_APP_ID         the App ID (an integer string, e.g. "12345").
#   $GH_APP_PEM        the App private key PEM contents (multi-line).
GH_REF=$(curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/credentials?kind=github_app" \
  -d "$(jq -n --arg id "$GH_APP_ID" --arg pem "$GH_APP_PEM" \
        '{ref:"default", appId:$id, privateKeyPem:$pem}')" \
  | jq -r '.ref')
echo "GH_REF=$GH_REF"   # the server-derived credential ref — no PEM ever returns.

# 4.a-ii — Bind it as the org's GitHub connection.
#   $GH_INSTALLATION_ID  the App installation id on the GitHub side (numeric string).
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/github" \
  -d "$(jq -n --arg iid "$GH_INSTALLATION_ID" --arg id "$GH_APP_ID" --arg ref "$GH_REF" \
        '{installationId:$iid, appId:$id, credentialRef:$ref}')" | jq .
# expect: { ok:true, mode:"app", installation:{installationId, appId, installedAt} }
```

### 4.b. Deploy provider (Vercel or Fly)

The link route accepts `{token, metadata}` per provider; the provisioner reads
provider-specific keys out of `metadata` at provision time, so **the link
succeeds without them but the deploy phase will fail-loud later**. Pick your
provider's row:

| Provider | URL path                      | Required metadata keys | Provisioner source                               |
| -------- | ----------------------------- | ---------------------- | ------------------------------------------------ |
| Vercel   | `/integrations/deploy.vercel` | `teamId`               | (vercel provisioner)                             |
| Fly      | `/integrations/deploy.flyio`  | `orgSlug`              | `engine/provisioners/flyDeployProvisioner.ts:62` |

**Vercel:**

```sh
#   $VERCEL_TOKEN    a Vercel access token.
#   $VERCEL_TEAM_ID  the Vercel team id the project deploys under.
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/integrations/deploy.vercel" \
  -d "$(jq -n --arg t "$VERCEL_TOKEN" --arg team "$VERCEL_TEAM_ID" \
        '{token:$t, metadata:{teamId:$team}}')" | jq .
# expect: { status:"linked", providerKind:"deploy.vercel", credentialRef, capabilities:["deploy"], metadataKeys:["teamId"] }
```

**Fly:**

```sh
#   $FLY_TOKEN      a Fly API token (a Fly macaroon bundle).
#   $FLY_ORG_SLUG   the Fly org slug the app deploys under (REQUIRED — the
#                   flyDeployProvisioner reads metadata.orgSlug at provision
#                   time). Find it via `fly orgs list` or the Fly dashboard.
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/integrations/deploy.flyio" \
  -d "$(jq -n --arg t "$FLY_TOKEN" --arg slug "$FLY_ORG_SLUG" \
        '{token:$t, metadata:{orgSlug:$slug}}')" | jq .
# expect: { status:"linked", providerKind:"deploy.flyio", credentialRef, capabilities:["deploy"], metadataKeys:["orgSlug"] }
```

### 4.c. Slack

```sh
#   $SLACK_BOT_TOKEN  a Slack bot token (xoxb-…); used by the notify provisioner.
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/integrations/slack" \
  -d "$(jq -n --arg t "$SLACK_BOT_TOKEN" '{token:$t, metadata:{}}')" | jq .
# expect: { status:"linked", providerKind:"slack", credentialRef, capabilities:["notify"], metadataKeys }
```

Credentials are stored by REFERENCE — values never appear in responses, event
payloads, or logs (only the derived `credentialRef` does). **A `just
import-manifest` recipe is a planned follow-up automation lane** that reads
`connections.manifest.local.yaml` and drives this same three-call loop without
hand-curls; until it lands, run the three curls above.

---

## 5. Kick off — rough notes → spec DAG

Drive the Forge interview as a **non-technical end user** (do NOT write specs or
give technical answers — see the role rules in `apex.md`):

```sh
# Round 1 — rough first description. Start with an EMPTY capture; the server
# defaults the missing keys. The response carries `say` (next question),
# `suggestions` (operator-facing prompts), `capture` (the merged-so-far state to
# carry into the next round), and `complete` (false until the answerer says
# the interview is done).
R1=$(curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/onboarding/interview/round" \
  -d '{
        "round": 1,
        "answer": "i want a link shortener. people paste a long URL, get a short one back, and i can see how many times each short link was clicked.",
        "capture": {}
      }')
echo "$R1" | jq '{say, complete}'
CAP=$(jq '.capture' <<<"$R1")   # carry the merged capture into the next round.

# Round 2 — adds the Slack notification + the deploy ask. Note: still talking like
# a product owner, not an engineer; do NOT name frameworks/databases/CI tools.
R2=$(curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/onboarding/interview/round" \
  -d "$(jq -n --argjson cap "$CAP" '{
        round: 2,
        answer: "when any short link crosses 100 clicks, post a celebratory message to our slack channel. and the whole thing should be live at a real URL — somewhere on the internet, not just on my laptop.",
        capture: $cap
      }')")
echo "$R2" | jq '{say, complete}'
CAP=$(jq '.capture' <<<"$R2")

# Round 3 — fills in personas / who-uses-it / what good looks like. Iterate
# more rounds the same way until `.complete == true`.
R3=$(curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/onboarding/interview/round" \
  -d "$(jq -n --argjson cap "$CAP" '{
        round: 3,
        answer: "two kinds of users: a regular person who just wants a short link, and me/marketing who wants to see which links are popular. success is: shortening takes one click, the click counts update within a minute or two, and the slack ping is reliable enough that we trust it.",
        capture: $cap
      }')")
echo "$R3" | jq '{say, complete}'
CAP=$(jq '.capture' <<<"$R3")

# ...keep iterating rounds (each one re-submits $CAP) until the answerer returns
# complete=true. The final $CAP is the input to derive.
```

```sh
# Derive: the final $CAP from the rounds above + the GitHub owner the new
# greenfield repo lands under + the deploy provider you linked in §4.b. The
# autonomy knob (`"auto"`) atomically configures the project for fully autonomous
# operation: reviewPolicy + mergeIntegration + governancePosture + auditPosture
# (AUTONOMOUS_AUDIT_POSTURE) + insightThresholds.ciInsightFlakyMinShas:1 all
# land in the same project insert (task #79). No follow-up §2.5 governance PUT
# is needed for an autonomy:"auto" derive.
#   $GH_OWNER         the GitHub org/user login the App is installed on (the
#                     owner of the new greenfield repo).
DERIVE=$(curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/onboarding/interview/derive" \
  -d "$(jq -n --argjson cap "$CAP" --arg owner "$GH_OWNER" '{
        capture: $cap,
        owner: $owner,
        private: true,
        description: "apex trial: link shortener with click counts + Slack-on-100 + live deploy",
        autonomy: "auto",
        deploy: { providerKind: "deploy.vercel", mode: "greenfield" }
      }')")
echo "$DERIVE" | jq '{projectId, projectName, repository, bootstrap, inboxSource}'

# Capture $PROJ for §6 (monitor). For apex (autonomy:"auto") no §2.5 PUT is
# needed — derive already applied the autonomous posture atomically.
PROJ=$(jq -r '.projectId' <<<"$DERIVE")
echo "PROJ=$PROJ"
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

### 5b-postlude. The autonomous posture is already on the project (no §2.5 PUT needed)

Once derive succeeds you have `$PROJ`. Because `autonomy: "auto"` derive lands
`auditPosture: AUTONOMOUS_AUDIT_POSTURE` + `insightThresholds.ciInsightFlakyMinShas: 1`
atomically with project creation (task #79), the audit-posture preflight passes
on the very first scaffold run with no operator intervention. **Skip §2.5 for an
apex run** — it remains the operator surface for non-auto projects or for
adjusting posture later. If you ever drive derive with a non-auto autonomy and
later want to flip it, that is when §2.5 is the right tool.

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

# Runs + a single run's event stream + recovery context + DORA. Pick a $RUN id
# from the /runs list response (e.g. the latest active one):
#   RUN=$(curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/runs" | jq -r '.runs[0].id')
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

## What the trials have proven so far (through v49)

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
(#640).

The v47–v49 cluster (2026-06-23, on the new NixOS host) extended the run rhythm
across an env migration: **v47** (dry run) drove §1-§4 cleanly on the new env and
surfaced #656 (`.env.validation.local` bash-source breaking on unquoted commas).
**v48** (real run) drove §1-§5, surfaced #658 (Fly `orgSlug`) plus operator-side
Fly billing + GitHub repo-conflicts pruning, and halted on the audit-posture
preflight on the template-build child project (→ Lane T1, #659 — the synthetic
child is now born with `auditPosture: AUTONOMOUS_AUDIT_POSTURE` +
`insightThresholds.ciInsightFlakyMinShas: 1`). **v49** drove past those cleanups
into the live writer-checker-auditor LLM loop running real scaffold work and
halted on a **legitimate pre-session tanren-code finding**: a runner-INSERT retry
loop (`duplicate key value violates unique constraint "runners_pkey"`) between
the run-executor and the job-reaper, compounded by derive's synchronous wait
having no inner-failure circuit breaker (8-hour curl hang). Task #21 tracks both
fixes — runner-INSERT idempotency + a progress/sign-of-life-based circuit breaker
for derive's synchronous wait.

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
