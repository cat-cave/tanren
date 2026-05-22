# Phase 2 Readiness Audit

This audit captures read-only codebase review after Phase 1 was live-proven. It is not a complete security review, but it records the issues that should shape Phase 2 specs before more workflow surface area is built.

## Priority Findings

### Critical

- The orchestrator and dashboard control plane are unauthenticated while published from compose. Phase 2 needs operator auth, project authorization, dashboard session/CSRF policy, and localhost-only dev bindings before the app becomes an operator surface.
- Dev Vault and Postgres use static credentials and published ports. Split local-dev and production profiles, remove static secret defaults from non-dev paths, and define Vault initialization/token policy.
- The v0 acceptance gate is not executable yet. Add a release-gated acceptance command for the easy, medium, and hard fixture repos that proves PR creation, CI, review/merge policy, and final merge.

### High

- The orchestrator has Docker socket access. Replace or isolate this with a narrow allocator sidecar/proxy before expanding allocator behavior.
- Runner isolation is broad: SSH is host-published, the runner has elevated capabilities, and local Codex sandboxing currently drives that shape. Phase 2 should move toward per-run ephemeral runners, internal-only SSH, rootless profiles where possible, and explicit sandbox requirements.
- Per-run workspaces and Codex auth materialization are not wiped as a first-class finalizer. Add cleanup for success/failure, abandoned-run TTLs, and tests proving no credential/workspace reuse.
- Redaction is not centralized. Add one redaction layer for provider errors, SSH stderr/stdout, URLs, credential refs, auth JSON, and high-entropy strings before exposing logs/events in the dashboard.
- Durable workflow state remains stringly typed. Add shared unions or enums, DB checks, and typed state transition helpers for run/spec/task/job/actor state.
- Project config is an unversioned `Record<string, unknown>`. Define a versioned config schema for provider routes, credential refs, allocator settings, review/merge policy, and notification settings.
- Answerer schemas are duplicated as Zod and JSON Schema. Choose one source of truth and generate the other with golden contract tests.
- Phase 1 live proof skips real planning and feedback loops. Add Planner execution, persisted subtasks, checker rejection loops, auditor rejection loops, and multi-subtask integration tests.
- Review, ready-for-review, and merge events exist but are not implemented. Add GitHub contract/live tests for ready, review polling, changes-requested handling, and merge.
- Real Codex usage is parsed but not persisted as cost records. Make cost resolution mandatory for real planner/write/check/audit calls and fail or escalate when usage cannot be attributed to an allowed cost source.

### Medium

- Event names are declared but payloads are `unknown`. Add an event map with typed payload schemas and generic append helpers.
- Provider role boundaries are physically blurred in shared Codex modules. Split role-specific adapters from shared auth/telemetry helpers as provider count grows.
- Answerers can receive workspace paths. Decide whether this is allowed as explicit read-only context or remove workspace access from the Answerer contract.
- Raw SQL row casts are spread through workflow code despite schema definitions. Introduce store/repository modules with typed row decoders or Drizzle-backed queries.
- Cost recording lacks a central typed write path. Add a `CostRecordStore` with discriminated cost-source raw variants.
- GitHub credentials are not scoped to repos by contract. Prefer GitHub App installation tokens, bind credential refs to allowed owner/repo, and verify access on import.
- CI polling lacks required-check awareness, pagination, rate-limit handling, and webhook support. Add deterministic timeout/escalation behavior.
- Durable queue claims have no lease recovery. Add heartbeat/visibility timeouts, retry budgets, and dead-letter events.
- Observability lacks latency and rate-limit signals. Record queue wait, provider latency, SSH latency, GitHub latency, stage durations, 429s, and retry-after values.
- Performance and concurrency are unmeasured. Add load smoke for multiple queued runs, allocator contention tests, and queue-claim latency checks.
- The dashboard is below the operator visibility promised by the brief. Add task timeline, costs by model/source, runner provenance, PR/CI/review state, and failure diagnostics.
- Regression corpus and coverage gates are not wired. Add regression tests for audit findings and coverage thresholds for workflow-critical modules.

## Phase 2 Planning Implication

The first Phase 2 specs should not be only UI polish. Before the dashboard becomes the main operator surface, Phase 2 needs security hardening, typed workflow contracts, cleanup/redaction, and executable acceptance scaffolding. Dashboard work should proceed in parallel only after the API contracts and design inventory are explicit.
