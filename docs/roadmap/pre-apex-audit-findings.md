# Pre-apex audit sweep findings (2026-06-08)

4 parallel Codex audits before the apex run. Full detail: /tmp/sweep\_{A,B,C,D}.md.

## CRITICAL / HIGH — system-vs-userland credential split (the SSH-token-as-env violation)

- **CRITICAL** `identitySecretRef` flows into runner materialization: sidecarHttpAllocator.ts:49 → runnerLifecycle.ts:147 (`TANREN_CODEX_HOME_BUNDLE`) → entrypoint.sh:40 — orchestrator SSH private key + model/user creds land in runner Docker env. FIX: never include identitySecretRef in runner materialization; deliver scoped run creds via the SSH/file substrate or a scoped token/ref, never Docker env.
- **HIGH** runner SSH private/public key as env: compose.prod.yml:103/191/248 + main.ts:260 + worker/boot.ts:191 seed keys from env. FIX: platform secret bootstrap or per-allocation generation; compose carries refs/config, not key values.
- **HIGH** cloud allocator tokens/SSH assumptions from env: buildAllocator.ts:71/90/113/146/186. FIX: org_integrations/secret refs + per-run SSH artifacts.
- **HIGH (broken)** kubernetesAllocator.ts:343 injects `TANREN_SSH_AUTHORIZED_KEY` but entrypoint.sh:46 reads `TANREN_RUNNER_AUTHORIZED_KEY` → k8s runners get no authorized_keys. FIX: align the key or mount a secret file.
- **HIGH (fail-closed)** hetznerAllocator.ts:261 swallows failure deleting the stored per-run SSH private key. FIX: internal secret-store cleanup failure throws or marks the credential leaked + blocks release.
- **MED** managedProvider.ts:36/41 hardcodes the managed OpenRouter cred ref/endpoint (resolveCredentials.ts:147). FIX: tenant providerMode stays org/project config; platform cred ref/endpoint from deploy/platform config.
- **MED** projectSpec allocator knob (projectSpec.ts:31/130) persisted but not wired into routing (plannerRun.ts:281 / allocatorRouter.ts:43). FIX: wire it or remove the knob.
- **LOW/MED** TANREN_RUNNER_IMAGE (compose.prod.yml:247) unused (allocator takes from /allocate). FIX: remove or make an explicit system default.

## P0 / P1 — silent fallbacks (no-silent-fallbacks doctrine)

- **P0** runExecutor.ts:314 + :431 — `jobOrgId === null` runs under runWithSystemScope BYPASSRLS for "legacy/unscoped" runs → tenant ops via BYPASSRLS. ASSESS: is any null-org run a legitimate platform path? If not, fail-closed (a tenant run must carry org scope).
- **P1** intake connectors return [] on auth/HTTP failure (denied/failed looks like "no issues"): githubConnector.ts:105, linearConnector.ts:204, jiraConnector.ts:203, sentryConnector.ts:175. FIX: a credential/auth/HTTP failure is a LOUD throw (distinguish from a genuine empty list).
- **P1** percolationPg.ts:448 — malformed org config swallowed → disables GitHub App auth (returns undefined). FIX: loud.
- **P1** runs/index.ts:142 — missing/RLS-empty spec read → fallbackSpec (masks a required relation failure). :408 — Forge thread errors swallowed to null. FIX: loud / surfaced.
- **P1** main.ts:247 — missing MIGRATION_DATABASE_URL falls back to the runtime pool. FIX: require it (loud).
- **P1** auth.ts:152 — missing request org silently falls back to the user's sole org. FIX: require explicit org.

## Forward-look — unexercised loops (gaps before apex wastes a push)

- **DEPLOY** silently no-ops if project config lacks deployProvider/deployAppId: deployOnMerge.ts:139 + :387. FIX: deploy must fire or LOUDLY fail/needs_attention (apex's deploy→live-URL proof needs this).
- **INTAKE webhook** path has a live-run dead-end (poller path wired; webhook dead-ends in the inbox awaiting a click). FIX: webhook path must route like the poller.
- GOOD (no fix): the walker HOLDS on the integration-stack cap (loud, no silent truncation); notifications emit loud logs.

## LEGITIMATE (not violations — flag-off kill-switches / annotated transitions)

- audit.ts:77 legacy fields = non-gating narration while findings is required (S3a transition).
- The Wave-3 cutover flags (conflictResolverJjLive/baseShiftLive/integrationNodesDrive) + their flag-off legacy paths = intended kill-switches until apex validates.
