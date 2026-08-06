# External onboarding — stand up Tanren and drive a hard fixture

This is a from-zero guide for an **external operator** — someone who has never seen
Tanren, working on **their own machine** — to bring up a Tanren instance and drive
an **apex-difficulty fixture** from rough product notes through to a deployed
product, entirely over Tanren's normal API. It distills the deeper runbooks; follow
it top to bottom, then reach for the linked docs when you need depth.

## What Tanren is

Tanren turns rough product notes into merged, deployed software **autonomously**: it
interviews you like a product owner, derives a spec DAG, and drives a
`design → implement → native-gate → review → merge → deploy → observe → triage →
repair` loop with real coding agents and real CI, with **no human in the inner
loop**. You interact only as the end user — you never hand-edit the code it writes.

### What "running an apex-difficulty fixture" means

**apex is not a mode, a harness, or a special workflow — it is a _class of test
fixtures_.** An "apex fixture" is just **rough operator notes for a hard-to-build
product** (for example: a link shortener that posts to Slack when a link gets
popular, deployed live on the internet) that you run through Tanren's **normal,
general operator flow**. Nothing about the flow below is apex-specific: it is the
same path any operator uses for any project. Running an apex fixture simply exercises
that general pipeline against a deliberately max-difficulty product to flush engine
bugs. There is no apex button; if Tanren needed apex-shaped scaffolding to succeed,
the result would be void. The role and doctrine are in
[`apex.md`](./apex.md) (read it before you drive — the "never hand-fix the generated
repo" rule is non-negotiable).

## 1. Prerequisites

### Host tooling

The stack runs as local containers; you drive it over HTTP. You need on your machine:

- **Docker (or Podman) with Compose** — runs the Postgres / Vault / orchestrator /
  worker / runner / dashboard stack (`compose.dev.yml`).
- **Node via Corepack** — `corepack enable`, then `pnpm` is provisioned for you.
- **`just`** — the task runner every command below uses (`just up-dev`, etc.).
- **`git`**, **`jq`**, **`curl`**, **`ssh-keygen`** — checkout, JSON handling, the
  API calls, and the runner identity key.

> Tanren developers enter a Nix devshell (`direnv allow`, pinned via `flake.nix`)
> that provides the full build toolchain. As an operator you do **not** need the Nix
> toolchain to _drive_ a run — you only need the runtime tools above to bring the
> stack up and call the API. Install `just`, `jq`, and Docker/Podman through your
> own package manager if you are not using the devshell.

### Credentials you must provision

Driving a real, deploying product needs real third-party credentials. The full
inventory, priorities, and cost ceiling (everything fits under **$50**, mostly on a
coding-agent subscription) live in
[`validation-credentials.md`](./validation-credentials.md). The minimum set to drive
a hard fixture end-to-end:

- **A coding-agent auth (BYOK)** — bring your own Codex (or other supported) auth so
  the run costs ~$0. You import this per-org over the API (§4).
- **A GitHub App** on a throwaway org/repo — App id + installation id + private-key
  PEM. Tanren creates the greenfield repo and opens PRs through it.
- **A deploy provider grant** — a Vercel team token or a Fly.io org token, so Tanren
  can deploy the product to a live URL. Deploy is a **creation dependency**: a
  greenfield project must name a linked provider or creation fails loudly.
- **A Slack bot token** (optional, fixture-dependent) — only if your fixture's notes
  ask for Slack notifications.

Secrets never appear in requests, responses, event payloads, or logs — Tanren stores
them by reference and returns only a derived `credentialRef`.

## 2. Bring up the stack from a fresh checkout

Work from a **fresh checkout of `origin/main`** (Tanren has no legacy-data
compatibility surface; always start clean).

```sh
git clone <your-tanren-remote> tanren   # or: git worktree add --detach <dir> origin/main
cd tanren
```

**One-time secrets layout.** Tanren expects three operator-local files —
`.env`, `.env.validation.local`, and `connections.manifest.local.yaml` — in the
canonical secrets dir `${TANREN_SECRETS_DIR:-~/.config/tanren/secrets}` (gitignored,
0700 dir / 0600 files). If your secrets currently sit inline in a checkout, run
`just secrets-migrate` once to move them to the canonical location and symlink them
back. `just up-dev` links them into each checkout automatically via `just
secrets-link`. Leave `TANREN_SECRETS_MODE` **unset** — the default (`canonical`)
requires real secrets and fails closed; the `dev-defaults` mode links compose
placeholders and must never be used for a real run. Details:
[`validation-credentials.md` § Canonical secrets layout](./validation-credentials.md).

Then bring the stack up with auth enforced:

```sh
just stack-reset               # tear down any prior stack + its volumes (a stale DB volume won't run)
corepack enable && corepack pnpm install

export TANREN_DEV_LOGIN=1      # enables the headless local_dev login used in §3
export TANREN_REQUIRE_AUTH=1   # auth is enforced — you drive the real auth surface
just up-dev                    # Postgres, Vault, orchestrator, worker, allocator, runner, dashboard, ntfy
```

`just up-dev` generates the runner identity key, mounts it as a compose secret, and
echoes the effective host ports.

Vault stores its data on the `vaultdata` named volume, so credentials survive a
container restart, a Docker VM reboot and a re-`up-dev`. The one command that
destroys them is `just down-dev` / `just stack-reset` (both `down -v`, both
unconditional) — after either, re-seed with `just seed-platform-creds`.

Because those credentials now persist behind a fixed root token, the Vault host
port is published on **loopback only** (`127.0.0.1:18200`), unlike the rest of the
stack. Containers are unaffected — they reach it as `vault:8200` — and so is the
host-side seeder. If you run the dev stack on a remote box and need to reach Vault
across the network, widen it deliberately with `TANREN_VAULT_BIND_ADDR=0.0.0.0`,
and understand that this exposes every stored credential to anything that can
reach the port. Confirm health before driving anything:

```sh
curl -s localhost:3100/healthz | jq .
# expect: { "service":"orchestrator", "ok":true, "database":"ok", "vault":{ "ok":true, ... } }
```

The orchestrator API is on `:3100`; the dashboard (optional) is on `:3000`. To run a
second instance on the same machine, shift every port at once with
`export TANREN_PORT_OFFSET=100` before `just up-dev` (or `just ports` to print the
set without bringing the stack up). `just doctor` verifies the secrets layout is
intact if bring-up fails.

## 3. Authenticate as an operator (headless)

With `TANREN_DEV_LOGIN=1` + `TANREN_REQUIRE_AUTH=1`, mint a session from the command
line by following the login → callback redirect:

```sh
LOGIN_BODY=$(curl -s -L -c jar -b jar "http://localhost:3100/auth/login?provider=local_dev")
ORG=$(jq -r '.primaryOrgId' <<<"$LOGIN_BODY")
CSRF=$(jq -r '.csrfToken'   <<<"$LOGIN_BODY")
echo "ORG=$ORG"; echo "CSRF=$CSRF"
```

Every mutating call below uses `-b jar` (the session cookie) and
`-H "X-CSRF-Token: $CSRF"`, and interpolates `$ORG`. (For a real deployment you would
sign in with GitHub OAuth instead — see [`auth.md`](./auth.md).)

## 4. Wire credentials over the API

All imports go through the org-scoped credential/integration surface — the same path
a real operator uses. Set the `$VAR` placeholders from your own secret source; real
values never appear in this doc or in any response.

**Bring-your-own coding agent (so the run is ~$0):**

```sh
curl -s -b jar -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -X POST "http://localhost:3100/orgs/$ORG/ai-provider" \
  -d "$(jq -n --arg a "$(cat ~/.codex/auth.json)" '{provider:"codex", authJson:$a, makeDefault:true}')" | jq .
```

**GitHub App, deploy provider, and Slack** each have a store/bind call with the exact
body shape the API validates. Rather than duplicate them here, follow
[`apex-run-playbook.md` §4](./apex-run-playbook.md) — it gives the three curls
(GitHub App store + bind, `deploy.vercel` / `deploy.flyio` link with the required
`teamId` / `orgSlug` metadata, and Slack). There is no bulk `import-manifest` recipe
yet — run the three calls by hand.

## 5. Drive a run from rough notes

You are a **non-technical product owner**, not an engineer. Do not write specs, name
frameworks, or give technical answers — describe what you want, like a customer would.
Run the Forge interview in rounds, then derive the project:

- **Interview:** POST to `/orgs/$ORG/onboarding/interview/round` with a plain-language
  `answer` and the carried-forward `capture`, iterating until the response returns
  `complete: true`.
- **Derive:** POST the final capture to `/orgs/$ORG/onboarding/interview/derive` with
  the GitHub `owner` for the new repo, `autonomy: "auto"`, and the `deploy` provider
  you linked. `autonomy: "auto"` atomically configures the project for fully
  autonomous operation — no follow-up governance call is needed.

The exact round/derive request bodies and response fields are in
[`apex-run-playbook.md` §5](./apex-run-playbook.md). Capture the returned
`projectId` as `$PROJ` for monitoring.

> **Do not pre-seed anything.** Project derivation runs the fragment composer and, for
> any missing template fragment, the per-fragment authoring loop (F2). Let it run —
> exercising that path end-to-end is part of what a hard fixture proves. Watch
> `fragment.authoring.{started,succeeded,failed}` in the event stream. Doctrine:
> [`../roadmap/templating-system.md`](../roadmap/templating-system.md).

## 6. Monitor, and recognize a halt

The DagWalker auto-executes; you poll status over the API (all paths org+project
scoped):

```sh
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/specs"      # specs flow open → ... → merged
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/runs"       # runs; pick a $RUN id
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/runs/$RUN/events"
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/runs/$RUN/recovery"
curl -s -b jar "http://localhost:3100/orgs/$ORG/projects/$PROJ/dora"
```

**A halt is a finding about Tanren — never something to patch around.** Halt signals:
a spec parks at `needs_attention`; a run reaches `halted` (or `escape_hatch_hit` /
`retry_budget_exhausted` / `window_exhausted`); a budget pause (`dag.budget.paused`);
or no forward progress for a sustained window (a stall). On a halt, read the run's
`/events` and `/recovery` plus the container logs
(`docker compose -f compose.dev.yml logs worker orchestrator`) for the root cause.
Recovery actions are in [`failure-recovery.md`](./failure-recovery.md).

When the product itself is broken, **report the symptom the way a user would** —
through Tanren's issue-ingestion, not by editing the repo — and watch whether Tanren
auto-triages it into a fix. That loop firing is a core thing a hard fixture proves.

## 7. Where a found engine bug goes

When a halt turns out to be a **Tanren engine bug** (not a product-code problem),
file it as a **GitHub issue typed `bug`** on the shared Tanren tracker — there is
a bug issue template under `.github/ISSUE_TEMPLATE/bug.yml`. Then it is claimed,
fixed via a PR (one unit of work per isolated worktree), centrally audited, and
merged before it lands on `main`. This is how multiple operators on multiple machines,
each driving their own fixture with their own credentials, feed one shared issue
tracker. Do **not** fix the generated product repo — fix the root cause in Tanren, on
`main`, cleanly.

## Deeper docs (don't duplicate — follow these)

- [`apex.md`](./apex.md) — the operator role, the run rhythm, and what a hard fixture
  is actually testing. **Read before driving.**
- [`apex-run-playbook.md`](./apex-run-playbook.md) — the full drive-from-zero curls
  (auth, the three credential imports, interview/derive bodies, monitoring).
- [`validation-credentials.md`](./validation-credentials.md) — the credential
  inventory, secrets layout, and cost ceiling.
- [`operator-driven-run.md`](./operator-driven-run.md) — the general operator flow via
  the dashboard, and the CLI-equivalent path.
- [`auth.md`](./auth.md) · [`credentials.md`](./credentials.md) — sign-in flows and
  credential import in depth.
- [`failure-recovery.md`](./failure-recovery.md) — halt → recover actions.
- [`README.md`](./README.md) — the operator-guide index and the native-delivery model.
