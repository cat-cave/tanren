# ROADMAP.md

## Current Milestone: Hello-World Connectivity

The first milestone proves that every major technology boundary in `PROJECT_BRIEF.md` exists and is wired:

- Docker Compose starts Postgres, Vault, orchestrator, dashboard, ntfy, and a runner container.
- The orchestrator can migrate Postgres, check Vault, run fake Writer/Answerer adapters, and persist a completed run.
- The dashboard can read run/event/cost state from Postgres.
- The thin CLI can call the orchestrator.
- CI builds, checks, tests, and smoke-tests the stack.

Real LLM CLIs, real credentials, and real PR automation are intentionally deferred until this baseline is green.
