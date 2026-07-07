# Tanren direction — pointer page

The `tanren-direction.md` doc was a rolling design north-star during the
no-Actions delivery / native-deploy / security-baseline / audit-baseline
groundwork PRs (#323 DeployAdapter seam, #324 VcsProvider publishCheck/Status,
#331 event-store audit baseline). Its content has since been **folded into the
durable docs + the code itself**, so this page is a **pointer** rather than a
source-of-truth. Comments across the engine still cite `tanren-direction.md
§ "X"` for historical continuity; this page tells a fresh reader where the
current canonical text lives.

## Where each cited section lives now

### `§ "Native Deployment And Demos"`

Cited by `services/orchestrator/src/engine/contracts/deployAdapter.ts`.

- **`PROJECT_BRIEF.md` §12 "Deploy + demo"** is the durable statement:
  "On merge, the `DeployAdapter` deploys the change and `verify` polls the
  target to READY + smoke-checks it; the demo engine then exercises the spec's
  declared behaviors against the live surface and records per-behavior
  evidence." Deployment is any controlled movement of a built artifact into an
  environment / channel / registry / store track / preview URL / download; the
  adapter decides the surface, the demo asks whether the behavior is correct.
- **`ROADMAP.md` §"v21 native delivery"** frames the Action-less delivery
  posture the DeployAdapter fits into.
- **The DeployAdapter contract itself** (`deployAdapter.ts`) carries the class
  set — `direct_api` (Vercel/Fly), `pulumi`, `package_release`,
  `mobile_release`, `manual_external` — plus the verified `provision → deploy →
verify (poll-to-ready + smoke) → demoSurface` lifecycle. The
  `DemoSurface` resolution ties demo evidence to the spec's **behaviors** (not
  the provider); see `engine/contracts/demoSurface.ts` + the demo engine.

### `§ "Security Baseline"`

Cited by `engine/security/egressPolicy.ts`, `engine/events/schemas/infra.ts`
(release-event cleanup proof), `engine/workflow/plannerRunFinalize.ts`,
`engine/events/sensitivityRules.audit.ts`,
`tests/plannerRunTail.test.ts`.

Two sub-clauses actually get cited:

- **"Runner egress policy, deployment-target allowlists, metadata-service
  blocking, and preview URL access control."** — the seam is
  `engine/security/egressPolicy.ts` (a slottable contract + a
  default-permissive impl; managed hosting slots a real restrictive policy
  without touching call sites). `ROADMAP.md` §"v21 native delivery" +
  §"Working rules" are the durable framing for the security-doctrine
  posture; **`PROJECT_BRIEF.md` §9 "Native, Action-less delivery"** is the
  origin of the "runner is an untrusted-code execution surface" framing.
- **"Release events prove cleanup and list residual resources, if any."** — the
  event shape lives in `engine/events/schemas/infra.ts` (`release.finalized`
  with `cleanedUp` + `residualResources`), the emit site is
  `engine/workflow/plannerRunFinalize.ts`, the coverage pin is
  `tests/plannerRunTail.test.ts`. The Vault per-run scoped-credentials work
  cited in `ROADMAP.md` §"v21 native delivery" is the sibling doctrine.

### `§ "Audit And Compliance Baseline"`

Cited by `engine/events/schemas/audit.ts`,
`engine/events/sensitivityRules.audit.ts`, `tests/auditBaseline.test.ts`.

- **The doctrine** — every GOVERNING delivery decision (gate verdict, deploy,
  merge) carries enough evidence for an enterprise audit WITHOUT an external
  workflow engine: who initiated it, who (if anyone) approved it, and under
  WHICH versioned governance policy. **`docs/architecture/autonomy-engine.md`**
  §1 (the DAG walker + `MergeAuthority`) + §2 (native merge coordination) is
  the durable design rationale; **`ROADMAP.md` §"v21 native delivery"** carries
  the shipped-state framing.
- **The event-payload model** — `AuditActor` + `AuditPolicy` +
  `AuditEvidence` in `engine/events/schemas/audit.ts` is the single shared
  audit envelope every governing event teaches. Sensitivity rules in
  `engine/events/sensitivityRules.audit.ts`. Coverage pin
  independent of any one emit site: `tests/auditBaseline.test.ts`.
- **The audit-as-finding posture** — the auditor emits P0–P3 findings gated by
  the `auditPosture` DORA knob (see `autonomy-engine.md` §1 + `ROADMAP.md`
  §"tanren-owns-the-engine cutover"). This is the doctrine that replaced the
  pre-cutover scattered gate/governance/review/mergeability checks.

## History

- **PR #323** — `feat(deploy): DeployAdapter seam + verify/status` — landed the
  DeployAdapter port cited by `deployAdapter.ts`.
- **PR #324** — `feat(vcs): VcsProvider publishCheck/publishStatus seam
(no-Actions groundwork)` — the sibling forge-status seam.
- **PR #331** — `feat(audit): embody the audit-evidence + security baseline in
the event store` — landed the audit + security envelope + sensitivity
  rules + the `release.finalized` cleanup-proof event.
- **PR #541** — the eighth PR of the `VcsProvider → CodeHost` decomposition
  series (`refactor(contracts): drop dead VcsProvider methods`) — folded the
  direction's forge posture into a durable architecture doc
  (`docs/architecture/vcsprovider-codehost-decomposition.md`).

If a citation reads `tanren-direction.md § "Security Baseline"`, read
`PROJECT_BRIEF.md` §9 + `ROADMAP.md` §"v21 native delivery" alongside
`engine/security/egressPolicy.ts` + `engine/events/schemas/infra.ts`. If it
reads `§ "Audit And Compliance Baseline"`, read `docs/architecture/autonomy-
engine.md` §§1–2 + `ROADMAP.md` §"tanren-owns-the-engine cutover" alongside
`engine/events/schemas/audit.ts`. If it reads `§ "Native Deployment And
Demos"`, read `PROJECT_BRIEF.md` §12 alongside `engine/contracts/deployAdapter.ts`.
