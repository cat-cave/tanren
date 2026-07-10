# Documentation and Code-Comment Drift Audit — R2

Audit target: `main` at `cf3845b4`. This round found **5 confirmed findings**: **1 P0**, **1 P1**, and **3 P2** (no P3 findings). The prior audit's resolved event, schema, flag, and VCS-seam findings are excluded.

## P0

### 1. Deployment guides say Vault is an implicit default, but startup now requires an explicit backend

- **Severity:** P0
- **Location:** `docs/operator-guide/deploy.md:161-164`; `docs/operator-guide/credentials.md:19`; `services/orchestrator/src/main.ts:77-79`
- **Claim:** The operator guide says, “Vault is the default secret store,” the credentials guide calls it “Vault (default),” and the boot comment says “(default `vault`, so existing deployments are unchanged).”
- **Reality:** `services/orchestrator/src/engine/contracts/secretStoreFactory.ts:9-11` says, “There is NO default — `TANREN_SECRET_STORE` must name one explicitly,” and `services/orchestrator/src/engine/contracts/secretStoreFactory.ts:107-116` says an unset or blank value throws before switching on the configured backend. `compose.dev.yml:57-60` explicitly sets `TANREN_SECRET_STORE: vault`; it is not a runtime fallback.
- **Fix:** In both guides, replace the default wording with: “A secret-store backend must be selected explicitly with `TANREN_SECRET_STORE`; the shipped Compose profiles set it to `vault`. Supported backends are `vault`, `gcp_sm`, `aws_sm`, `onepassword`, and `memory` (tests).” Replace the `main.ts` comment with: “The secret-store backend is selected explicitly by required `TANREN_SECRET_STORE`; Compose sets `vault`. See `engine/contracts/secretStoreFactory.ts`.”

## P1

### 2. Scale architecture presents the already-split worker topology as a future in-process design

- **Severity:** P1
- **Location:** `docs/architecture/future-refactor-and-scale.md:35-41,218-237,262-274,493-495`
- **Claim:** The document calls its description “the real current architecture,” then says “One process, one pool,” “The worker is in-process,” “No separate worker fleet,” and that the worker split is a future change from a “monolith-with-flagged-worker.”
- **Reality:** `services/orchestrator/src/worker-main.ts:1-7` says the standalone worker “boots ONLY the worker loop in its own process” and that the control-plane API “no longer runs the worker in-process by default.” `compose.dev.yml:150-163` defines a separate `worker` service that starts `worker-main.ts`; `services/orchestrator/src/main.ts:304-310` limits the in-process worker to the `TANREN_RUN_WORKER=1` single-process development convenience.
- **Fix:** Replace the current-topology bullet with: “**Control/data-plane split.** The HTTP control plane (`main.ts`) and standalone run-executor data plane (`worker-main.ts`) are separate processes/services. The API starts an in-process worker only for the `TANREN_RUN_WORKER=1` single-process development convenience; each process constructs its own database pool.” Replace the later “future split”/“single in-process worker” references with the current baseline: “Scale the existing standalone worker data plane horizontally; the Postgres `FOR UPDATE SKIP LOCKED` queue is the coordination seam.”

## P2

### 3. Timeout-eradication roadmap still inventories a deleted allocator wall-clock reaper

- **Severity:** P2
- **Location:** `docs/roadmap/timeout-eradication.md:383,508-509`
- **Claim:** The inventory lists `TANREN_MAX_RUN_HOURS` as an allocator setting that “reaps / destroys a runner by **6h wall-clock AGE**,” and M5 says to replace that setting with heartbeat-staleness reaping.
- **Reality:** `services/allocator/src/envSchema.ts:16-21` says the allocator has “NO WALL-CLOCK REAP KNOB,” has no `TANREN_MAX_RUN_HOURS`, and only the orchestrator uses that variable for scoped-credential token TTL. `services/allocator/src/runnerLifecycle.ts:111-115` says a healthy in-flight runner is never returned for reclamation regardless of age; only the terminal-run, lease-lapsed, and unclaimed-grace states are reclaimable.
- **Fix:** Replace the table row with: “Allocator sweeper — no wall-clock age setting; reclaims only terminal-run, lease-lapsed, or unclaimed-grace runners.” Replace M5 with: “M5 — allocator age-based reaping is already removed; retain sign-of-life reclamation.”

### 4. CI analytics schema comment names deleted `ci.*` lifecycle events

- **Severity:** P2
- **Location:** `services/orchestrator/src/engine/insights/ci/types.ts:22-29`
- **Claim:** `CiTimingStat` is documented as “A timed CI run (a `ci.started` → terminal pair)” and its fields are described as timing `ci.started` to a terminal `ci.*` event.
- **Reality:** `services/orchestrator/src/engine/insights/ci/compute.ts:2-10` says forge-CI observations (`ci.started`/`ci.passed`/`ci.failed`) were replaced by native `gate.verdict` events, whose payload contains `durationMs`. `services/orchestrator/src/engine/insights/ci/compute.ts:65-72` computes timing directly from each verdict's `durationMs`, with “no two-event pairing.”
- **Fix:** Replace the block comment with: “A timed native gate verdict and its duration.” Replace the median field comment with: “Median wall-clock seconds from each `gate.verdict` payload's `durationMs`.” Replace the sample field comment with: “How many gate verdicts contributed to the timing.”

### 5. Quality-gate documentation still calls the now-16-step fast check a 15-step gate

- **Severity:** P2
- **Location:** `README.md:182,344`; `ROADMAP.md:354-356`
- **Claim:** README calls `just fast-check` a “15-step” gate, and ROADMAP calls it “a 15-step `just fast-check`.”
- **Reality:** `justfile:91` defines `fast-check` with 16 prerequisites: `format-check`, `lint`, `types-lint`, `architecture`, `no-pg-as-date`, six schema/state/event/answerer/contract/dashboard drift checks, `knip`, `spelling`, `typecheck`, `test`, and `compose-config`. The added `no-pg-as-date` check makes the stated count incorrect.
- **Fix:** Replace “15-step” with “16-step” at all three locations; in ROADMAP, add `no-pg-as-date` after `architecture` in the parenthesized recipe list.
