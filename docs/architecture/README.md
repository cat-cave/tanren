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
