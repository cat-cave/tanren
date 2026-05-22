# Audit Corpus

Prior audit findings should be lifted here as regression tests as Phase 1 introduces real agent, credential, GitHub, CI, review, and merge behavior.

Phase 0 already converted several prior-risk categories into mechanical checks:

- schema drift is checked through Drizzle generation
- event writes are restricted to `eventStore.ts`
- accepted cost sources are enforced
- host process and Docker workload execution are guarded
- source/config/docs line limits are checked
- Writer and Answerer role mixing is constrained outside workflow dispatchers

For Phase 1, add audit-derived tests when a spec introduces the relevant surface. Do not add broad audit fixtures that are disconnected from executable behavior.
