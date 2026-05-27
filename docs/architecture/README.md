# Architecture Notes

Phase 0 is the Tanren kernel. It keeps behavior synthetic where agents are concerned, but the infrastructure boundaries are real:

- Postgres schema is defined in `db/src/schema.ts`; committed Drizzle migrations are drift-checked.
- The orchestrator reaches runner workloads through `SshSubstrate`.
- The local Docker allocator records and releases runner allocations; workload commands still run over SSH.
- The hello workflow prepares a git workspace inside the runner and the fake Writer mutates that workspace.
- Writer output is captured from git state: diff bytes and commit metadata, not self-reported completion text.
- Planner, Writer, Checker, and Auditor tasks are queued, claimed, completed, or failed through durable run/task/job state.
- Events are appended only through `services/orchestrator/src/engine/eventStore.ts`.

The active workflow dispatcher lives under `services/orchestrator/src/engine/workflow/**`. Files in that directory may coordinate Writer and Answerer roles; role-specific provider code should stay separated elsewhere.

Phase 1 should build on these contracts instead of replacing them. Real CLIs, GitHub PR creation, CI polling, and Answerer schemas should plug into the durable task loop and runner workspace model already present.

## Phase 1 boundary (post-completion)

Phase 1 closed in May 2026 with all seven specs (P1-0001 through P1-0007) merged on `main` and the end-to-end live proof committed in `ROADMAP.md`. The boundary Phase 2 inherits:

- The Phase 1 runner workspace model and SSH execution boundary are unchanged. Phase 2A's allocator-isolation spec (P2A-0010) narrows the Docker socket exposure with a sidecar and adds workspace cleanup, but the SSH substrate and runner image contracts remain stable.
- Codex is the only working CLI for both Writer and Answerer roles; Phase 2 extends routing to a 6-role fallback chain shape (P2A-0006) but keeps Codex as the only resolved provider until Phase 3.
- The fake-provider and Phase 0 hello surfaces are preserved as smoke fixtures. Phase 2 does not remove them.
- Schema migrations in Phase 2A are destructive against local dev data; the live `run_a347d451…` proof is preserved in ROADMAP as a record, not as a migrated DB row.

Phase 2A specs that touch the schema (`P2A-0003` auth/orgs, `P2A-0005` typed state, `P2A-0006` versioned config, `P2A-0007` events, `P2A-0011` costs, `P2A-0017` notifications, `P2A-0018` product entities, `P2A-0019` Forge turns, `P2A-0020` workflow insights) coordinate their migrations through the foundation P2A-0001 / P2A-0002 work. Each spec's migration is additive to the Phase 1 baseline; the order is dictated by the Phase 2A parallelization plan in `ROADMAP.md`.
