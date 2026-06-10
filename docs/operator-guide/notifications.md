# Notifications

Tanren delivers run, CI, and cost events to operator channels. **All nine
channels are now real adapters** — ntfy, slack, github_checks, teams, discord,
email, twilio, pagerduty, webhook (P3-0024 completed the rollout). The
notification surface is the **per-event × per-channel × severity matrix**
described in the hi-fi onboarding flow. P2A-0017 shipped the full schema and
dispatcher; each channel performs real delivery **when its deps/credentials are
supplied** in the registry, and falls back to a no-op `StubChannel` only when
left unconfigured.

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
- `notifications` — the dispatch ledger: an append-only log of every
  publish attempt, scoped to `sent`, `failed`, `stubbed`, or `skipped`
  (with the reason). UI surfaces read it for the "last delivery" badge;
  operators read it for forensics.

The matrix is `notification_targets × notification_routes`. A `scope = user`
target row overrides a `scope = org` target row for the same
`(orgId, channelKind)` pair when the dispatcher fires an event the user
has a route for. The override is per-channel: a user can opt out of a
slack route while leaving the org's ntfy route active.

## Severity

Every event in the P2A-0007 registry has a default severity in
`services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts`:

| Severity | When                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------- |
| `ok`     | Happy-path completions: `run.completed`, `ci.passed`, `github.pr.merged`.                             |
| `info`   | Normal-flight progress: `*.started`, `*.queued`, `writer.subtask.completed`, audit reads.             |
| `warn`   | Recoverable degradation: `ci.failed`, `*.failed`, an answerer verdict that found work to do.          |
| `fail`   | Run-halting / budget-defeating misconfig: `run.failed`, `cost.unattributed`, `phase1.fixture.failed`. |

A few payload shapes promote at fire time:

- **Answerer verdicts are a findings model, not a pass/fail flag.** The auditor is
  **findings-only**: its `auditor.verdict` payload carries an explicit **P0–P3
  `findings` list** (no `passed` field) — the findings list _is_ the verdict, and
  the loop's triage + the project posture decide what each severity means for the
  merge. The checker emits a completeness `findings` list (treated as P0) and may
  carry an optional `passed` enrichment. A verdict that surfaces findings (work
  remaining) promotes one tier (e.g. base `info` → `warn`); a clean verdict stays
  at `ok`.
- `run.completed` with an outcome containing `fail` promotes one tier.

The dispatcher computes the **effective severity** and compares it to
each matching route's `minSeverity` floor. If the floor exceeds the
effective severity, the route is skipped (no dispatch, no log row).

## Channels

- **ntfy**: POSTs the JSON body to the topic URL with `Title`, `Priority`,
  `Tags` headers ntfy understands. The base URL is `TANREN_NTFY_BASE_URL`
  (defaults to `http://ntfy:80` for the compose dev profile). The target's
  `destination` is either a bare topic name or a fully-qualified URL.
- **slack / github_checks / teams / discord / email / twilio / pagerduty /
  webhook**: real adapters (`engine/notifications/channels/*.ts`). Each delivers
  via its provider's API/webhook (e.g. Slack incoming-webhook JSON, a webhook
  POST, an email send) and surfaces failures as a thrown error the dispatcher
  records as `status='failed'`. Secret material (webhook URLs, tokens) is stored
  as a write-only **credential ref** on the target row and resolved through the
  secret store at send time, not stored in the clear.

A channel is wired when its deps are supplied to `buildChannelRegistry`; a kind
with no deps falls back to a no-op `StubChannel` (dispatch ledger records
`status='stubbed'`) so the matrix can still be configured ahead of supplying
credentials. The matrix UI surfaces the per-channel "last delivery" status so an
unconfigured channel reads as stubbed rather than failing silently.

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

## Adding more channels

All nine hi-fi channels now have real adapters. The full set of channel kinds is
enumerated in `services/orchestrator/src/engine/notifications/schemas.ts`
(`ChannelKind`); the registry wiring lives in `engine/notifications/registry.ts`. Adding a
new kind is: extend the Zod enum + the SQL CHECK, add an adapter under
`channels/`, and register it in `buildChannelRegistry`. The matrix data shape
itself is uniform, so configuration evolves independently of the adapter set.
