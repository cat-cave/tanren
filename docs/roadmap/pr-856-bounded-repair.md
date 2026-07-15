# PR #856 — loud dashboard failures and cursor-bound terminal drain

**Phase**: bounded contributor repair. Preserve Cameron DeMille's four commits;
refresh the complete stack onto current `main`, re-run every gate, and merge only
the refreshed result.

## Owned paths

- `services/dashboard/src/api/{auditsClient,budgetClient,discoveryClient,existingBrownfieldClient,forgeConversationClient,httpClient,inboxClient,integrationsClient,onboardingNewClient,orchestrator,orgConfigClient,projectDag,readResponseSchemas,recoveryClient,runDetailClient,writeResponseSchemas}.ts`
- `services/dashboard/src/client/{palette,paletteChat,runStream,runStreamProtocol}.ts`
- `services/dashboard/src/components/onboarding/existing/{ExistingFullBody,SeedDagStep}.tsx`
- `services/dashboard/src/components/onboarding/new/{ArrivalStep,DerivedDagStep,GreenfieldBody,greenfieldStyles}.tsx`
- `services/dashboard/src/components/project/{ProjectDagBody,ProjectViewBody}.tsx`
- `services/dashboard/src/components/project/{projectViewData,SpecCreateBody}.ts(x)`
- `services/dashboard/src/components/{recovery/HaltedRunBody,costs/{HistoryBody,CostsBody},audits/AuditsBody}.tsx`
- `services/dashboard/src/components/runDetail/RunDetailBody.tsx`
- `services/dashboard/src/routes/onboarding/{existing,new}/index.tsx` + `routes/onboarding/actions.ts`
- `services/dashboard/src/routes/projects/{index,specRoutes}.tsx`
- `services/dashboard/src/routes/runs/{halted,index}.tsx` + `routes/runs/trigger/index.tsx`
- `services/dashboard/src/routes/{costs,audits,overview}/index.tsx`
- `services/dashboard/src/{app/shell.tsx,app/mountShell.tsx,design/palette-state.css,design/shell.css}`;
  `shell.css` is restored to the base version and the new state rule lives in
  the bounded stylesheet.
- `services/dashboard/scripts/build-client.mjs`
- `services/dashboard/tests/{existingOnboarding.render,forgeProposalClient,greenfieldOnboarding.render,history-and-costs.render,httpClient.csrf,onboarding.render,paletteChat,projectDag.render,projects.render,projects.render.fixtures,readResponseSchemas,recovery.render,recovery.render.fixtures,runDetail.render,runDetailClient,runStream.client,runStream.init,runStreamProtocol}.test.ts`
- `services/orchestrator/src/engine/forge/tools/authz.ts`
- `services/orchestrator/src/engine/repositories/{costs,events}.ts`
- `services/orchestrator/src/engine/schemaExport/catalog.ts`
- `services/orchestrator/src/routes/runs/{contract,index,sse}.ts`
- `services/orchestrator/tests/helpers/runRoutesPool.ts`
- `services/orchestrator/tests/{forgeToolsAuthz,runRoutes.sse,runRoutes.sseOrdering,runRoutes.streamAuth}.test.ts`
- `services/orchestrator/tests/conformance/conformanceRunSql.ts`
- `contracts/json/http/Sse{Costs,Drained,Events,Heartbeat,Snapshot,Status,Task}Frame.json`
- `services/dashboard/src/api/http.gen.ts`, `scripts/gen-dashboard-types.mjs`
- `docs/contracts/run-detail-api.md` and this card

## Contract

The repair consumes the canonical run/event/cost stores and generated HTTP
types. It produces one failure-aware dashboard path and one identity-bound SSE
authority. It does not retain a legacy cast/fallback path. All changed 2xx/409
write bodies, run/spec/milestone/insight/feed reads, run detail, and every SSE
frame are runtime-decoded before use.

The silent-empty list wrappers (`listRuns`/`listSpecs`/`listMilestones`/
`listInsights`/`listFeed`/`listOrgs`/`listProjects`) are deleted; the sole API
is the typed `*Maybe` read that returns `undefined` on transport/HTTP/decode
failure. `listRunCosts` reports `{ records, complete }` so a partial walk is
never laundered into a total. No aliases or facades remain: every caller
distinguishes legitimate empty from unavailable and renders an actionable
banner rather than `[]`, zero KPIs, "healthy," or "no data."

The stream route binds persisted run organization + project to the URL before
opening. Event/cost deltas are `id ASC`, capped at 200, and carry the exact page
tail as their decimal-string cursor. Task frames replace the full projection;
their watermark covers every rendered task field, including creation/removal.
A terminal run remains terminal through immediate errors and reconnects, and
the browser closes exactly once only for a receipt matching the accepted
terminal tuple, event cursor, cost cursor, and task watermark.

## Acceptance

- Greenfield derive sends the authenticated org login as owner and never
  invents a repository URL.
- Onboarding/DAG/run reads distinguish unavailable, not-found, and genuine
  empty results; operator input survives retry; project KPIs never turn a failed
  run read into idle, zero spend, or zero attention.
- Malformed/empty success and documented conflict bodies fail closed. Raw
  upstream error payloads are not rendered.
- Snapshot/reconnect/task frames visibly replace the complete task projection,
  including newly created and removed rows.
- Unauthenticated, cross-org, cross-project, and inconsistent run/project-org
  stream paths fail before streaming, including for platform admins.
- Generated schemas/types are drift-clean and every changed source/config/doc
  file respects the architecture line cap.

## Gate proof

Focused proof includes strict read/write boundary tests, onboarding and project
render negatives, SSR terminal-state proof, fake-EventSource reconnect/drain
proof, adversarial cursor/projection reducer tests, HTTP stream auth/path tests,
and server 200-row ordering/task-fingerprint tests. Then run affected tests and
typechecks, schema/type drift, format/lint/architecture checks, followed on the
refreshed stack by canonical `just fast-check`, `just ci`, and `just smoke`.
