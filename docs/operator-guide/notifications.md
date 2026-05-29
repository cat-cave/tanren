# Notifications

Tanren delivers run, CI, and cost events to operator channels (ntfy in v0;
slack, github_checks, teams, discord, email, twilio, pagerduty, webhook
in later phases). The notification surface is the **per-event × per-channel
× severity matrix** described in the hi-fi onboarding flow. P2A-0017 ships
the full schema and dispatcher; only the ntfy channel performs real
delivery in Phase 2.

## Mental model

Three persistent shapes:

- `notification_targets` — one row per configured destination. Each row
  carries `channelKind` (`ntfy`, `slack`, ...), a `destination` string
  (ntfy topic URL or bare topic; slack channel id; webhook URL; etc.), a
  human `label`, an `enabled` flag, and a `weekendMute` flag. The
  `scope` column is either `org` (an org-wide default target) or `user`
  (a personal override target for one operator inside that org).
- `notification_routes` — one row per `(target × eventName)` opt-in. The
  row carries an `enabled` flag and a `minSeverity` floor. The floor
  filters out events whose mapped severity sits below the floor — useful
  for "I only want failures on this pager" rows.
- `notifications` — the dispatch ledger. The legacy Phase 1 table is now
  scoped as an append-only log of every publish attempt: `sent`,
  `failed`, `stubbed`, or `skipped` (with the reason). UI surfaces read
  it for the "last delivery" badge; operators read it for forensics.

The matrix is `notification_targets × notification_routes`. A `scope = user`
target row overrides a `scope = org` target row for the same
`(orgId, channelKind)` pair when the dispatcher fires an event the user
has a route for. The override is per-channel: a user can opt out of a
slack route while leaving the org's ntfy route active.

## Severity

Every event in the P2A-0007 registry has a default severity in
`services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts`:

| Severity | When                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| `ok`     | Happy-path completions: `run.completed`, `ci.passed`, `github.pr.merged`.                   |
| `info`   | Normal-flight progress: `*.started`, `*.queued`, `writer.subtask.completed`, audit reads.   |
| `warn`   | Recoverable degradation: `ci.failed`, `*.failed`, checker/auditor rejection verdicts.       |
| `fail`   | Run-halting / unattributable: `run.failed`, `cost.unattributable`, `phase1.fixture.failed`. |

A few payload shapes promote at fire time:

- `checker.verdict` / `auditor.verdict` with `passed=false` promote one
  tier (e.g. base `info` → `warn`).
- `run.completed` with an outcome containing `fail` promotes one tier.

The dispatcher computes the **effective severity** and compares it to
each matching route's `minSeverity` floor. If the floor exceeds the
effective severity, the route is skipped (no dispatch, no log row).

## Channels in v0

- **ntfy**: real delivery. POSTs the JSON body to the topic URL with
  `Title`, `Priority`, `Tags` headers ntfy understands. The base URL is
  `TANREN_NTFY_BASE_URL` (defaults to `http://ntfy:80` for the compose
  dev profile). The target's `destination` is either a bare topic name
  or a fully-qualified URL.
- **slack / github_checks / teams / discord / email / twilio /
  pagerduty / webhook**: registered as `StubChannel` adapters. The
  dispatcher invokes their `publish()` exactly like a real channel; the
  call is a no-op and the dispatch ledger records `status='stubbed'`.
  The matrix UI in P2B-0002 renders the row as "configured but not yet
  wired" so operators see what they have set up without seeing a silent
  failure.

This separation lets matrix configuration evolve in parallel with
channel adapters. Adding slack in Phase 3 is a pure additive change:
swap `StubChannel("slack")` for `SlackChannel(...)` in the
`buildChannelRegistry` call.

## Weekend mute

Each target row carries `weekendMute`. When set, the dispatcher skips
delivery if the current time is Saturday or Sunday in **UTC**. The
dispatch ledger records the skip with `status='skipped'` and
`reason='weekend_mute'` for audit.

v0 uses UTC by design — per-org timezones add UI surface area and a
timezone-store column that depends on the operator settings flow
(P2B-0002). Phase 3 will accept an org timezone; the matrix schema does
not change.

## Fire-and-forget

Notifications never block workflow progress. Every publish is
fire-and-forget:

- A wired channel that throws is caught, logged as
  `status='failed'` in the dispatch ledger, and the workflow continues.
- A stubbed channel that throws is caught, logged at warn level, and
  recorded as `status='stubbed'`. Stubs should not throw, but the
  dispatcher hardens against drift.
- A dispatch ledger write that throws is caught and logged. The
  invariant is that the run loop is never blocked by the notification
  surface; the cost of a dropped log row is acceptable.

## Payloads and redaction

Payloads pass through the P2A-0009 redaction serializer **before** the
channel sees them. The system actor used for redaction holds only
`project:member` scope, so even `redacted`-tagged fields render as the
public marker. Channels (especially future slack / webhook / email
adapters) cannot leak raw payload bytes.

The serialized body the channel receives includes:

- `title`: `[SEVERITY] eventName`.
- `body`: an info block (`project`, `run`, `spec`, `event`) followed by
  the redacted JSON payload, truncated to 4096 bytes.
- `severity`: the effective severity computed above.
- `eventName`: the registered event name.
- `url`: optional deep link supplied by the orchestrator's `urlFor`
  hook (defaults to absent in v0).
- `tags`: includes `tanren` and `severity:<level>` for routing.

## Future channels

Other channels mentioned in the hi-fi (slack, github_checks, teams,
discord, email, twilio, pagerduty, webhook) live as schema rows and
stub adapters today. They do not deliver. Operators can configure them
in the matrix UI (P2B-0002); the dashboard renders their rows as
"configured but not yet wired" so the expectation is honest.

The full set of channel kinds is enumerated in
`services/orchestrator/src/engine/notifications/schemas.ts` (`ChannelKind`).
Adding a kind is two changes: extend the Zod enum and the SQL CHECK; the
matrix data shape itself is uniform.
