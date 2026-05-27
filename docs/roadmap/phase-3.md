# Phase 3: v0 Completion

Detail entries for Phase 3 scope buckets. Phase 3 closes the v0 workflow above the Phase 2 operator-control baseline.

Status: scoped, not started.

Phase 3 closes the v0 workflow above the Phase 2 operator-control baseline, adds the remaining providers, brings the hi-fi's deferred surfaces online, hardens deployment, and clears the audit's remaining medium-priority items.

### Phase 3 Scope Buckets

- **Workflow completion**: real review polling (ready-for-review marking, changes-requested handling), real merge contract with per-repo configurable integrations (Mergify queue · direct GitHub merge · external-reviewer handoff), conflict resolver scaffolding, optional Mergify merge-queue integration.
- **Thick Forge**: LLM-backed Forge conversation backend reading `forge_turns` from P2A-0019 and invoking the tool surface; replaces the templated v0 narration generator with an actual LLM author. No schema change — pure swap.
- **Spec DAG canvas + DAG-primary project view**: full SVG canvas with milestones, behaviors, attention-numbered badges, click-routing for live/done/review/blocked nodes; legend overlay; pulsing animations for live/review/blocked. Reads P2A-0018 entities and edges.
- **Spec Discovery flow** (hi-fi 02): Forge classifies an insight (sales call note, GitHub issue, exec memo), proposes specs with DAG-placement options, persists provenance. Three variants (feature / bug / strategic). Depends on thick Forge + DAG canvas.
- **Greenfield onboarding · full track** (hi-fi 01b): multi-round Forge vision interview, derived 71-spec DAG from interview answers, sources / scheduled-audits / arrival surfaces.
- **Brownfield onboarding · full track** (hi-fi 01c remaining steps): read-only answerer recon agent that indexes the target repo and pre-fills personas / behaviors / architecture / risks; config-injection PR that opens a PR to the target repo adding `.github/workflows/tanren-ci.yml`, `.mergify.yml`, `CODEOWNERS`, and a one-time `.tanren/PROJECT.md` snapshot; DAG step turning agent gaps + GitHub issues into seed specs; governance-posture picker (strict / open / audit-only).
- **`tanren-config` audit-gate repo pattern**: optional org-level toggle that routes Bucket-B config writes through a PR in a separate `tanren-config` repo before applying to the DB. DB remains source of truth; the PR is a write gate.
- **Subscription-window utilization heatmap**: 30-day × 5-window heatmap on the costs page with avg-fill column and "scheduled overnight audits" Forge prompt.
- **DORA-like metrics panel**: lead time, deploy frequency, change failure rate, MTTR — reported, not targeted.
- **Live preview deploys in Review**: device-tab iframe pointed at a per-PR preview URL.
- **"demo" role LLM wiring**: replace templated demo narration with a real Claude (or Codex) Answerer call. Uses the schema P2A-0008 already ships.
- **Additional workflow insights**: `stuck` (depends on spec-dependency-chain analysis from P2A-0018) and `review_stall` (depends on review polling).
- **Scheduled audits library** (hi-fi 01b step 3 right panel): cron-driven background scans (security, mutation tests, perf, dependency updates, type coverage, a11y, license audit, stale specs) producing auto-generated specs.
- **Issue source ingestion**: GitHub Issues → candidate specs via label-driven classification. Linear / Jira / custom webhooks defer further.
- **External-push governance posture**: strict / open / audit-only modes governing how Tanren coexists with non-Tanren contributors.
- **Provider expansion**: Claude Writer, Claude Answerer, opencode Writer (Zai GLM 5.1 only — Wafer pass-through was discontinued on 2026-05-27 and is not re-introduced). Slots into P2A-0006's existing fallback-chain schema with no migration.
- **Notification channels**: Slack, GitHub Checks (the two slated for next priority after ntfy), then teams/discord/email/twilio/pagerduty/webhook as the matrix already accommodates.
- **Acceptance hard tier**: fixture-hard requiring planner re-plans, auditor rejection loops, conflict-resolution path; final v0 acceptance gate.
- **Allocator expansion**: remote allocators (manual-SSH, Hetzner, DigitalOcean, AWS EC2, Kubernetes pool), runner pool policies, label→allocator routing.
- **CI and queue hardening**: required-check awareness, webhook-driven CI, rate-limit handling, queue lease recovery (heartbeats, retry budgets, dead-letter events).
- **Observability**: latency, rate-limit, queue-wait, provider/SSH/GitHub timings; coverage thresholds for workflow-critical modules; regression corpus seeded from Phase 2 audit findings.
- **Deployment hardening**: cloudflared exposure profile, TLS termination, Vault enterprise rotation policy, **Authentik OIDC** as a second identity provider on top of P2A-0003.

PROJECT_BRIEF §3.1 (opencode provider list) is amended at Phase 3 entry to remove the Wafer reference. PROJECT_BRIEF was otherwise treated as fixed during Phase 2 planning.
