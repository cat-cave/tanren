# Notifications matrix UI

> **Currency note.** This is the Phase-2 build checklist for P2B-0002. Since then,
> Phase 3 (P3-0024) wired **all nine channels** as real adapters — the "only ntfy
> delivers in Phase 2" / "no dispatch wiring" lines below are historical. See
> [`../../operator-guide/notifications.md`](../../operator-guide/notifications.md)
> for current behavior.

**Surface**: the per-event × per-channel × severity matrix operators configure during org setup and edit from settings.

**Owning spec**: P2B-0002 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-onboard-org.jsx` step 3 (notifications). Low-fi import at `docs/design/operator-flows/notifications-matrix.svg`.

## In scope for Phase 2

- [ ] **Channels column**: each channel (slack, github-checks, ntfy, teams, discord, email, twilio, pagerduty, webhook) renders a row with its glyph, name, configured destination value, an on/off toggle, and a phase badge (`v0`, `p3`, `p4`). Channel rows for unwired channels render a "configured but not yet wired" hint that does not block toggling them on.
- [ ] **Matrix**: events from the P2A-0007 registry render as rows; columns are the enabled channels; cells are per-event × per-channel opt-ins. Severity rendered as a per-row badge (`ok`, `info`, `warn`, `fail`).
- [ ] **Org defaults**: editing the matrix at org scope sets `notification_routes` rows in P2A-0017 with `scope = org`.
- [ ] **Dev overrides**: each operator can override their personal layer on top of the org defaults (e.g. opt out of `auditor.verdict · pass` in slack for themselves). Dev overrides render visually distinct from org defaults.
- [ ] **Weekend auto-mute**: per-target toggle that disables dispatches on Saturday and Sunday in the operator's timezone.
- [ ] **Add-channel button**: opens a per-channel-kind config form. For ntfy in v0, the form asks for the ntfy URL or topic; submit writes a `notification_targets` row.
- [ ] **Live channel only**: only ntfy actually delivers in Phase 2; other rows have working schemas and matrix opt-ins but no dispatch wiring. The UI makes this distinction visible.

## Reductions from the hi-fi

- **Slack and GitHub Checks delivery**: Phase 3 (priority after ntfy). Matrix opt-ins for these channels are persisted but don't fire.
- **Teams, Discord, email, Twilio, PagerDuty, webhook**: deferred to Phase 3+ per hi-fi phase tags.
- **Per-event custom routing rules** beyond the event × channel matrix: deferred to Phase 3.

## Done when

An operator can configure org-default notification rows for ntfy, layer a dev override, save the configuration, force a Phase 1 fixture run to halt, and receive an ntfy notification through the configured target. Other channels render as configurable but explicitly unwired.
