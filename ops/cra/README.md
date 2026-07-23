# Central Review Authority local service

<!-- cspell:ignore journalctl -->

The CRA is transitional workstation operations tooling for `cat-cave/tanren`.
It is outside the Tanren engine and imports no engine code. One bounded poll
discovers open PRs, audits selected heads serially in verified throwaway
worktrees, triages findings, performs only the writes allowed by the configured
rollout mode, supervises abandonment, cleans up, and exits. The long-running
service repeats that bounded operation every 60 seconds plus configured jitter.

## Rollout modes

`mode` is required operational policy and has exactly three values:

- `shadow`: reads GitHub and runs the isolated audit, but the review dependency is
  a local draft writer with no token or GitHub gateway. Drafts land under
  `${XDG_STATE_HOME:-$HOME/.local/state}/tanren-cra/cat-cave-tanren/drafts/`.
  There are no GitHub writes, including reviews, comments, issues, abandonment,
  or merge.
- `review`: posts one marker-deduplicated official review, routes deduplicated
  P2/P3 issues, and runs reminder/abandonment writes. Its staged dependency type
  has no merge callback, so the merge path is unreachable.
- `merge`: uses the same official review path and may call the merge authority.
  That authority performs three fresh stable authorization reads, denies every
  false/missing/unknown prerequisite, and uses the audited-head SHA as GitHub's
  compare-and-swap merge argument. P2/P3 routing happens only after a verified
  merge.

Promotion is deliberate: edit `mode` from `shadow` to `review`, observe it, then
to `merge`. The last completed mode is stored per PR, so promotion invalidates a
lower-stage completion even when the head and rubric did not change. There is no
permissive or bypass mode. A missing identity, permission, required check,
ruleset, audit artifact, sandbox, issue link, current base, or read-after-write
confirmation causes delay or failure; it never weakens a guard.

## Install

Prerequisites are Node/pnpm, `gh`, Git, `flock`, a local OCI runtime and the
configured audit-worker CLI. Build from the trusted CRA branch, then install a
local symlink:

```sh
corepack pnpm --filter @tanren/cra build
install -d -m 0700 "$HOME/.local/bin" "$HOME/.config/tanren-cra/credentials" \
  "$HOME/.local/state/tanren-cra"
ln -sfn "$PWD/ops/cra/dist/main.js" "$HOME/.local/bin/tanren-cra"
install -m 0600 ops/cra/config.example.json "$HOME/.config/tanren-cra/config.json"
```

Replace every operator-specific value in the config. Repository, key, worktree,
and config paths must be absolute after resolution. CRA rejects its mutable
state, private key, or throwaway worktrees if they are inside the repository.

Install the primary user service:

```sh
install -D -m 0644 ops/cra/systemd/tanren-cra.service \
  "$HOME/.config/systemd/user/tanren-cra.service"
systemctl --user daemon-reload
systemctl --user enable --now tanren-cra.service
loginctl enable-linger "$USER"
systemctl --user status tanren-cra.service
journalctl --user -u tanren-cra.service -f
```

On a machine without user systemd, edit the absolute paths in
`cron/tanren-cra.crontab` and install it with `crontab`. Do not enable cron while
the user service is enabled. Both entry points use the same non-blocking
`supervisor.lock`, so accidental overlap cannot double-review or double-merge.

For a manual bounded verification:

```sh
tanren-cra poll-once "$HOME/.config/tanren-cra/config.json"
```

Success emits one JSON `DAILY_STATUS` record containing mode, open/oldest PRs,
heads awaiting audit, blocked and abandonment counts, merges, P0-P3 counts, and
follow-up issue IDs. Every poll and decision also goes to durable JSONL events.
Failures write an `error` event where state is available, print to stderr, invoke
the configured loud local notifier (the default is `logger` to journald/syslog),
and exit nonzero so systemd restarts and records the failure. Notification
failure is itself printed and remains a nonzero service failure.

## GitHub App credentials and identity

Create or install the workstation GitHub App as the sole normal review/merge
identity. The expected actor is `trevor-workstation[bot]`. Grant only:

- repository metadata: read;
- checks/statuses: read;
- pull requests: read/write;
- issues: read/write;
- contents: read/write for squash merge.

Put the App private key at the configured `github.privateKeyPath`, outside the
repository, owned by the CRA user, mode `0600`, and never in an environment
variable. Configure the numeric App and installation IDs. Model credentials stay
in the workstation credential store used by the audit CLI; CRA strips `GH_TOKEN`
and `GITHUB_TOKEN` from the audit worker. Each poll mints a short-lived
installation token and verifies the viewer login before any write-capable object
is constructed.

## Branch protection and rulesets

Protect `main` with all repository-required check contexts and require the branch
to be current and conflict-free. Grant normal merge capability only to the
installed CRA App; contributors and their tokens must not self-merge. Do not add
an alternate automation bypass actor. If both legacy branch protection and
rulesets declare checks, CRA unions them and requires every context to be present,
completed, and successful. Confirm the setup in `shadow`, then `review`, before
selecting `merge`.

The merge authority additionally verifies the exact source issue and closed
dependencies, current CRA marker/review/rubric/artifact, stable PR body/history
and ruleset versions, app identity and permissions, held singleton, durable state,
and read-after-write health. `BEHIND`, `UNKNOWN`, skipped/neutral/missing checks,
pagination, rate-limit uncertainty, or any API/schema error denies merge.

## Recovery and exactly-once behavior

State records and drafts use synchronized atomic replacement; audit reports are
immutable per PR/head/rubric. At poll start CRA removes interrupted temporary
state siblings, repairs only a torn final JSONL record, and reclaims only its
validated `pr-<number>-<sha12>` worktrees and `refs/cra/*` refs while holding the
singleton lease. An `in_progress` or failed audit is selected again.

Local state is not the sole idempotency key. Reviews carry the stable
`tanren-cra:v1` marker and follow-up issues carry `CRA-Finding`; restart reconciles
an accepted remote review instead of posting it again. A verified merge is persisted
before issue routing. If the process then crashes, the next poll enters
post-merge routing recovery and never calls the merge path; issue markers and
dependency read-before-write prevent duplicates.

## Disable and break glass

Normal disable:

```sh
systemctl --user disable --now tanren-cra.service
crontab -l  # remove the CRA fallback line if it was installed
```

Verify no process holds the repository's
`${XDG_STATE_HOME:-$HOME/.local/state}/tanren-cra/cat-cave-tanren/supervisor.lock`
before incident work. Preserve state and audit logs.

Break glass is incident response, never a second merge lane:

1. Disable both service and cron and record the incident/reason on the PR.
2. Run the same trusted audit and every required gate manually against the exact
   head, confirming the source issue/dependencies and current base.
3. Use the maintainer's documented ruleset emergency authority, squash with an
   explicit head-SHA check, record the resulting commit, and reconcile issue
   closure.
4. Record why CRA could not perform the action, repair that failure, return first
   to `shadow`, and re-promote through `review` before restoring `merge`.

Never change mode or a ruleset to a weaker guard as a break-glass shortcut.

## Retirement toward Tanren-in-Tanren

This package is removed surface-by-surface once Tanren's corresponding native
capability is beta-stable and apex fixtures prove it: issue intake replaces the
GitHub roster, the autonomy engine replaces contributor worktrees,
`MergeAuthority` plus behavior verification replaces audit/triage, the native
intelligent merge queue replaces the external squash authority, and
`DeployAdapter` plus self-update replaces manual release. During cutover, disable
CRA first and prove the native owner is the sole authority before deleting local
state, App permissions, service/cron assets, and finally `ops/cra/`.
