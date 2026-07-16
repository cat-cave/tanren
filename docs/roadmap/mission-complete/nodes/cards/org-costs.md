# org-costs — bounded, fail-closed organization cost read model

**Phase**: hardening / PR #943 repair\
**Authorship**: This card was authored during the PR #943 repair/redrive; the
implementation already existed in the PR #943 contribution/repair worktree. It
is retrospective ownership documentation — recording what was built and how it
is proven — not a previously declared scope contract.\
**State at admission**: Cameron DeMille contribution at `6ce3e834`; bounded
pagination, honest null totals, and fail-closed consumer semantics incomplete\
**Purpose**: replace dashboard project/run fan-out with one organization read
model while preserving tenant boundaries, cost provenance, unknown monetary
facts, and explicit product-visible failure states.

## Dependencies

- Merged eight-contract spine and the canonical cost ledger/store.
- Run-detail HTTP contract and org-scoped transaction boundary.
- Merged PR #937 run-location shared-path changes are preserved in this main
  reconciliation.
- Merged PR #875 pool/client safety: both stores receive the already checked-out
  scoped transaction client; no nested checkout or split transaction.
- Open bigint-cursor work must consume this decimal-string cursor authority,
  never reintroduce JavaScript number coercion.

## Exclusive ownership

- `services/orchestrator/src/routes/runs/orgCosts.ts`
- `services/orchestrator/src/routes/runs/orgCostsRoute.ts`
- `services/dashboard/src/api/orgCosts.ts`
- `services/dashboard/src/components/costs/coverage.ts`
- `services/orchestrator/tests/orgCosts.route.test.ts`
- `services/orchestrator/tests/helpers/runRoutesPoolOrgCosts.ts`
- `services/dashboard/tests/orgCosts.client.test.ts`
- `services/dashboard/tests/costs.failure.render.test.ts`
- `docs/roadmap/mission-complete/nodes/cards/org-costs.md`

## Shared-resource leases

Serialize edits to:

- `services/orchestrator/src/routes/runs/{contract,index,list}.ts`
- `services/orchestrator/src/engine/repositories/{costs,runs,events}.ts`
- `services/orchestrator/tests/helpers/runRoutesPool.ts`
- `services/dashboard/src/api/{orchestrator,types,http.gen}.ts`
- `services/dashboard/src/routes/costs/index.tsx`
- `services/dashboard/src/components/{costs,project}/**`
- `contracts/json/http/**` and `docs/contracts/run-detail-api.md`

No migration, nav, `screens.ts`, or `main.ts` changes. Generated JSON and
dashboard types are regenerated from the Zod catalog, never hand-maintained.

## Produces

- `GET /orgs/:orgId/costs?pageSize=&cursor=` with an org-bound `OrgCosts` page,
  at most `pageSize + 1` rows per store query, and one opaque dual keyset cursor.
- Cost reads only through `CostStore`; run projections only through `RunStore`.
- `RunListItem.costTotalUsd`: `"0"` for no rows, decimal for fully priced rows,
  and `null` when any real-dollar fact is unknown.
- Dashboard `GetOrgCostsResult`: `ok`, `auth`, or typed `unavailable`; partial
  pages are discarded and never masquerade as an empty ledger.
- Product UI states for valid empty, unavailable, known zero, unknown, and
  partial coverage. CSV failures are non-attachment, non-200 responses.

## Negative controls

- Missing actor → 401; foreign org → 403 before any scoped/store read.
- Wrong-org response echo, extra/malformed fields, invalid tokens/decimals,
  duplicate identities, broken cost→run/project binding, non-progressing cursor
  page, repeated cursor, network failure, and upstream non-200 → never `ok` or
  empty.
- Broken run/spec binding: a realistic constrained LEFT JOIN miss (same spec id
  but wrong project binding, yielding null `spec_title`) fails closed at
  decode, returns HTTP 500 / non-OrgCosts with no fabricated row or title, and
  executes the exact single-client sequence `BEGIN`;
  `SET LOCAL app.current_org_id = 'org_acme'`; repeatable-read read-only
  snapshot; one bounded CostStore read; one bounded RunStore read; `ROLLBACK`,
  with one connect/release and no `COMMIT` or alternate authority.
- `cost_basis=unknown|unattributed` with non-null `costUsd` is invalid.
- Bigserial cursor ids above `Number.MAX_SAFE_INTEGER` round-trip exactly.
- `cost_source_raw` never crosses HTTP or CSV.
- Stacked-bar and pricing-model shares render only when the selected real or
  notional axis is fully known with a positive denominator; partial, unknown,
  zero-denominator, and denominators containing a priced `unattributed` record
  never emit a fabricated `100%` or `0%` split. The anomaly remains an explicit
  provider source, and the source count is the collision-free provider-row
  count rather than only the three modeled card buckets.
- Provider grouping uses a collision-free five-field tuple encoding, so literal
  delimiter characters in cli/model/provider identities cannot merge distinct
  HTML or CSV rows.
- Proven CSV controls: all-unknown dollar cells stay blank on both axes; a
  mixed priced/unpriced provider row stays `partial` and emits its known
  subtotal even when that subtotal is exactly `0.000000`; partial coverage and
  a fully-known zero denominator (`summary.totalUsd === 0`) both leave the share
  field blank; the tested unavailable CSV responses — 403 auth and upstream 500
  — are non-attachment JSON, never a false successful or empty CSV.
- Completed-stream control: once either cursor stream is done, a later page
  issues zero reads against that store and opens no separate authority/client
  for it.

## Validation

- Orchestrator route tests prove an exact-bigint dual cursor with a cost ID
  above `Number.MAX_SAFE_INTEGER` preserved as decimal text in the response
  and cursor, then bound through `$3::bigint` on page two. While both streams
  are active, each page issues the exact sequence of six statements in order:
  `BEGIN`; `SET LOCAL app.current_org_id = 'org_acme'`;
  `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`; an ordered
  bounded CostStore read; an ordered bounded RunStore read; `COMMIT`. That is
  six statements with one connect and one release. Both store reads share the
  single scoped `PoolClient`; `Promise.all` starts them together but the
  same-client node-postgres query queue serializes CostStore then RunStore —
  no DB-parallel claim is made. After the cost stream completes first the
  subsequent page is run-only, the five-statement shape `BEGIN`, `SET LOCAL`,
  the repeatable-read snapshot, the RunStore read, then `COMMIT`; after the
  run stream completes first the subsequent page is cost-only, the same
  five-statement shape with the CostStore read instead. The query manifest excludes duplicate, fan-out, or
  alternate-authority reads; foreign-org requests and requests without an actor issue zero
  reads. Null-vs-zero totals use `COUNT(cr.cost_usd) = COUNT(cr.id)`, never
  `COALESCE`. A mismatched run/spec binding (same spec id, wrong project, null
  `spec_title` from the constrained LEFT JOIN) fails closed at decode as HTTP
  500 / non-OrgCosts (no fabricated row or title) and issues the exact
  six-statement single-client sequence `BEGIN`;
  `SET LOCAL app.current_org_id = 'org_acme'`; repeatable-read read-only
  snapshot; one bounded CostStore read; one bounded RunStore read; `ROLLBACK`
  — one connect/release, no `COMMIT`, no alternate authority.
- Dashboard client matrix covers only its own fail-closed behavior: HTTP and
  network failures (network throw, auth 401/403, any status other than exact
  200 (including 201/204 and 5xx), invalid JSON), malformed/extra/wrong-domain/
  duplicate/broken-binding pages, a non-progressing empty page (a cursor page
  with no rows), a repeated non-null cursor across two otherwise-valid nonempty
  pages, and a bounded walk that reaches exhaustion.
- Product render/CSV tests bind each visible state. Render: a valid empty
  ledger vs an unavailable read, all-unknown (`total-amount` = `unknown`) vs
  fully known zero (`total-amount` = `$0.00`, no `partial` qualifier) vs
  partial coverage (one priced + one unpriced renders `$0.04 known` with
  `partial known subtotal`, never all-unknown or a bare fully-known total).
  Visible provider-table partial coverage: the same co-keyed mixed provider
  row renders `$0.04 known · partial` and partial-known-zero renders
  `$0.00 known · partial`; both use a dash share and never `no $ basis` or a
  fabricated percentage. Amount and share derive from explicit row/global
  `realCoverage`; share requires both known plus a positive denominator. The
  page-level stacked bar and pricing-model cards apply the same selected-axis
  gate: both partial fixtures have no segment/model percentage, while a fully
  known positive real axis renders its exact `100%` segment and model share.
  Exact positive real and notional fixtures each split the global denominator
  50/50 between a modeled record and a contract-valid priced `unattributed`
  record: both retain the exact `$2.00` headline and two visible, explicitly
  labeled provider sources, while the bar is empty and the modeled card share
  is a dash (never a visually normalized full-width `50%` segment).
  Two provider tuples that collide under naive `|` joining remain two exact
  provider rows in both rendered HTML and CSV.
  CSV successful attachments are enumerated exactly: a valid empty ledger
  emits the header only; an all-unknown row blanks both axes (never a
  fabricated `0.000000`); a partial nonzero row emits the known subtotal with
  no share; a partial known-zero stays `partial` with `0.000000` (never
  downgraded to `unknown`); a fully known zero emits `known` with `0.000000`
  and a blank share. The leading `=` in a cli is neutralized so a spreadsheet
  cannot evaluate it as a formula. A partial row or a zero-denominator total
  (`summary.totalUsd === 0`) blanks the share field. Unavailable CSV responses
  are proven only for the tested 403 auth and upstream-500 cases, both returning
  non-attachment JSON (never a false successful or empty CSV). Notional render
  coverage includes a fully-known positive equivalent total with a priced
  unattributed contributor; no notional partial CSV case is claimed.
- Regenerate contract JSON/dashboard types; run affected tests/typechecks,
  format, lint, architecture, schema drift, then full gates after main refresh.

## P1 redrive (post-audit, seven-item convergence)

Independent audits returned NO-GO on seven live-path gaps. Closed as one
fail-loud authority (no compatibility fallbacks):

1. Run-detail spec header/behavior/milestone constrained by exact
   `(orgId, projectId, specId)`; same-org cross-project fails non-200 with no
   foreign metadata leak; DB/schema failure no longer launders to `[]`/`null`.
2. Dashboard run-list and run-detail require exact HTTP 200 + strict Zod decode
   (`api/runReads.ts`); non-200/malformed/binding mismatch → unavailable.
3. Every `listRunsMaybe` consumer propagates availability (project view, spec
   list/detail, halted aggregate, DAG, trigger re-render).
4. Audits keeps independent `snapshotAvailable` vs `heatmapUnavailable` planes.
5. Per-source cost coverage uses priced-record counts (SSR + browser stream),
   never `knownUsd > 0`.
6. SSE same-id cost fingerprint reconciliation; truth frames before terminal
   status; client upserts by bigint-decimal id (no double-count).
7. Behavior/milestone reads fail loud on relation failure.

Live PostgreSQL/HTTP/UI/smoke proof remains required before merge.
