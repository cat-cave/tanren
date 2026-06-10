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

> **Run naming.** Each trial is `vN` (v32 was the most recent — it reached the
> scaffold-bootstrap step, flushed three real bugs, and halted before any merge).
> The next trial is `v33`. Runs are **disposable** — `main` only moves forward; you
> never patch a run or its generated repo (see `apex.md`).

---

## 1. Rebuild the stack from a fresh `origin/main` checkout

The repository at `/home/trevor/github/tanren-2` is a **bare** git repo and its
`[main]` worktree **drifts stale**. Always build from a fresh detached checkout of
`origin/main`, never from the existing `[main]` worktree.

```sh
# A worktree session leaks GIT_DIR/GIT_WORK_TREE into git commands run elsewhere —
# unset them or every git call below silently targets the wrong repo.
unset GIT_DIR GIT_WORK_TREE

# Fresh detached checkout of origin/main (NOT the stale [main] worktree).
git -C /home/trevor/github/tanren-2 worktree add --detach /tmp/tanren-vNN origin/main
cd /tmp/tanren-vNN

# Tear down any prior stack + its volumes (a stale DB volume will not run).
docker compose -p tanren-2 -f compose.dev.yml down -v

corepack enable && corepack pnpm install
```

Bring the stack up with the apex host env vars exported:

```sh
export TANREN_APEX_MODE=1      # self-configures the autonomous audit-posture + flaky
                               # threshold; REQUIRED or the audit-posture preflight
                               # fails the run.
export TANREN_DEV_LOGIN=1      # enables the headless local_dev login (step 2).
export TANREN_REQUIRE_AUTH=1   # auth is enforced (apex drives the real auth surface).
just up-dev
```

`just up-dev` (recipe `runner-key gen-mtls-certs` → `up-dev`) generates
`/tmp/tanren_runner_key` and mounts it as the `tanren_runner_identity_key` compose
secret — the runner identity key is a **mounted secret file**
(`/run/secrets/tanren_runner_identity_key`), never a plaintext env value; only the
PUBLIC `TANREN_RUNNER_AUTHORIZED_KEY` line is passed via env.

> **KNOWN GAP — thread `TANREN_APEX_MODE` to the orchestrator.** Today the compose
> file wires `TANREN_APEX_MODE` only onto the **`worker`** service, but
> `engine/config/apexMode.ts` reads `process.env` in the **orchestrator** too
> (audit-posture/self-config). Until this is threaded onto the `orchestrator`
> compose service, export `TANREN_APEX_MODE=1` on the host so both pick it up — and
> consider this a one-line compose fix to land (it is a tracked v33-prep item in
> `ROADMAP.md` §4).

Verify health before driving anything:

```sh
curl -s localhost:3100/healthz   # expect database+vault ok
```

(The orchestrator API is on `:3100`; the dashboard, if you want it, is on `:3000`.)

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
**worker and orchestrator docker logs** (`docker compose -p tanren-2 -f
compose.dev.yml logs worker orchestrator`) for the root cause. Then follow the
**rhythm in `apex.md`**: fix the root cause cleanly on `main` (zero compat
residue), drain the backlog of deferrals/side-quests via parallel agent waves to
lift the platform a quality tier, then rebuild from fresh `origin/main` and start
`v(N+1)`.

---

## What v32 proved + flushed (the most recent trial)

v32 was driven over this exact playbook (BYOK Codex, $0). It **proved live**:
DAG-build from a real Forge interview (rough notes → a 15-spec DAG), walker
auto-execution, the writer authoring a scaffold, cost-discipline (loud NULL costs),
and `needs_attention` escalation + a clean runner release. It **halted at
scaffold-bootstrap** and flushed three bugs — all now FIXED on `main`:

1. **bootstrap frozen-lockfile** (#496) — a from-scratch scaffold cannot
   `pnpm install --frozen-lockfile` with no lockfile; greenfield bootstrap is now
   non-frozen and commits the lockfile.
2. **runner-sweeper** (#497) — a periodic sweeper reclaims STUCK/LEAKED runners.
3. **templating never exercised + the from-scratch path was wrong** (#498) —
   re-architected to the doctrine in step 5b (every project DAG seeds from a
   validated template; no from-scratch-into-a-project bypass).

v33 = drive the refined platform; **expect the next halt past scaffold** (the
loops past scaffold — CI-green PRs → deploy → issue-loop → audits → CI-intelligence
→ notifications — remain to demonstrate live).

## Where this fits

- The role + what's under test (read first): [apex.md](./apex.md)
- The general operator flow + dashboard path: [operator-driven-run.md](./operator-driven-run.md)
- Credential inventory + where they live: [validation-credentials.md](./validation-credentials.md)
- The templating doctrine: [../roadmap/templating-system.md](../roadmap/templating-system.md)
- Halt → recover actions: [failure-recovery.md](./failure-recovery.md)
