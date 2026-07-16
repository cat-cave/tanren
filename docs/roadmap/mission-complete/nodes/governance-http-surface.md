# (5) HTTP SURFACE (endpoints)

> Reference endpoint surface for the governance control plane. Split from
> [governance.md](./governance.md) section (5) to keep that file under the
> 500-line architecture cap; content and heading meaning are preserved verbatim.

All writes require `Idempotency-Key`; revision mutations require `If-Match`; responses return `ETag`, actor, revision, and policy hash. Governance mutations require `org_admin` or delegated `governance_admin`, budget writes require `finance_admin`, notification writes require `notification_admin`, and production approvals require the bound environment principal.

### Policies and tiers

- `GET /v1/orgs/:orgId/governance/tiers`
- `POST /v1/orgs/:orgId/governance/tiers`
- `GET /v1/orgs/:orgId/governance/policies`
- `POST /v1/orgs/:orgId/governance/policies`
- `GET /v1/orgs/:orgId/governance/policies/:policyId/revisions/:revision`
- `POST .../revisions` — create immutable draft
- `POST .../validate`
- `POST .../simulate` — historical or supplied change fixture
- `POST .../activate`
- `POST .../retire`
- `POST .../rollback` — activates a new revision pointing at prior content
- `GET .../diff?from=&to=`
- `GET .../export?format=json|yaml`
- `POST /v1/orgs/:orgId/governance/imports:validate`
- `GET /v1/orgs/:orgId/projects/:projectId/governance/effective`
- `GET /v1/orgs/:orgId/projects/:projectId/governance/explain?headSha=`
- `PUT /v1/orgs/:orgId/projects/:projectId/governance/binding`

### Coverage and decisions

- `GET /v1/orgs/:orgId/projects/:projectId/governance/coverage`
- `PUT .../coverage-requirements`
- `POST .../coverage/apex-runs`
- `GET .../coverage/apex-runs/:runId`
- `GET /v1/orgs/:orgId/governance/decisions`
- `GET /v1/orgs/:orgId/governance/decisions/:decisionId`
- `GET .../:decisionId/receipt`
- `POST /v1/orgs/:orgId/governance/bypass-requests`
- `POST .../:id/approve`
- `POST .../:id/deny`
- `POST .../:id/revoke`

### Reviews

- `GET /v1/orgs/:orgId/projects/:projectId/review-sessions`
- `GET .../review-sessions/:id`
- `POST .../:id/reassign`
- `POST .../:id/rerun-agent-review`
- `POST .../:id/verdicts`
- `POST .../:id/publications:reconcile`
- `GET .../:id/threads`
- `POST .../threads/:threadId/resolve`

### Audit lineage and remediation

- `GET /v1/orgs/:orgId/audit-runs`
- `POST /v1/orgs/:orgId/audit-jobs/:jobId/run`
- `GET /v1/orgs/:orgId/audit-findings`
- `GET .../audit-findings/:findingId`
- `POST .../:findingId/dispositions`
- `POST .../:findingId/route-to-spec`
- `POST .../finding-clusters/:clusterId/route-to-spec`
- `GET .../:findingId/lineage`
- `POST .../:findingId/retry-materialization`

### Integration and queue control

- `GET /v1/orgs/:orgId/projects/:projectId/integration-nodes`
- `GET .../integration-nodes/:nodeId`
- `GET .../stacks/:specId`
- `POST .../stacks/:specId/exercise` — privileged apex/conformance run
- `GET .../base-shifts`
- `POST .../merge-queue/pause`
- `POST .../merge-queue/resume`
- `POST .../landing-freezes`
- `PATCH .../landing-freezes/:id`
- `DELETE .../landing-freezes/:id`

None of these endpoints merges. Landing remains an internal MergeAuthority operation.

### Budgets

- `GET /v1/orgs/:orgId/projects/:projectId/budget`
- `POST .../budget/revisions`
- `POST .../budget/simulate`
- `GET .../budget/reservations`
- `GET .../budget/pause-episodes`
- `POST .../budget/pause-episodes/:id/resume`
- `POST .../budget/overrides`
- `DELETE .../budget/overrides/:id`
- `GET .../budget/forecast`

### Notifications

- `GET /v1/orgs/:orgId/notifications/capabilities`
- `POST .../targets:validate`
- `POST .../targets:probe`
- `POST .../targets`
- `PATCH .../targets/:id`
- `DELETE .../targets/:id`
- `PUT .../routes/:id` — real upsert/toggle
- `DELETE .../routes/:id`
- `POST .../policies`
- `POST .../test-deliveries`
- `GET .../intents`
- `GET .../attempts`
- `GET .../receipts`
- `POST .../receipts/:id/acknowledge`
- `POST .../dead-letters/:id/retry`

### Environments and promotions

- `GET/POST /v1/orgs/:orgId/projects/:projectId/deployment-environments`
- `GET/PATCH .../deployment-environments/:environment`
- `POST .../:environment/protection-rules`
- `POST .../:environment/freezes`
- `GET .../promotions`
- `POST .../promotions/:id/approve`
- `POST .../promotions/:id/reject`
- `POST .../promotions/:id/retry`
- `POST .../promotions/:id/rollback`
- `GET .../promotions/:id/attestation`
