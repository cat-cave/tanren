# Credentials management

**Surface**: the credentials screen accessible during onboarding and from settings, for managing org-shared API keys and dev-personal bundles.

**Owning spec**: P2B-0002 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-onboard-org.jsx` step 2 (credentials) and the equivalent screen reachable from settings. Low-fi import at `docs/design/operator-flows/credentials.svg`.

## In scope for Phase 2

- [ ] **Two-column layout**: `org · shared` (billed-to-org) and `dev · {user}` (billed-to-dev), each with sections for API keys and agent bundles.
- [ ] **API key entry**: label, base URL (auto-filled from schema), API schema dropdown (anthropic v1 messages, openai v1 responses, openai v1 chat completions, openai-compatible, custom), API key value (write-only input; never re-shown). Submit writes a credential reference via P2A-0013 and stores the value in Vault per P2A-0004 prod profile policy.
- [ ] **Bundle entry**: bundle kind selector (codex chatgpt subscription, opencode subscription, claude bundle login, custom JSON file drop). Each kind imports a different artifact (e.g. `auth.json` for Codex chatgpt) into a Vault path that the runner allocator materializes per-run.
- [ ] **List rendering**: each existing credential renders label, vault path, last-imported timestamp, refresh policy, "used N runs today" usage hint, and re-import / view-raw-metadata actions. Credential values are **never** rendered after entry — `view auth.json` shows only the file's metadata (path, size, mtime), not its contents.
- [ ] **Personal vs org**: org keys are billed to and managed by the org; dev keys are billed to and managed by the individual operator. Switching tabs is a no-op for credentials the operator does not have access to.

## Reductions from the hi-fi

- **Custom JSON file drop**: ships in Phase 3 once the generic JSON-bundle credential schema is generalized.
- **Per-credential rotation prompts and "X days remaining" calculations**: shipped against P2A-0006 versioned-project-config rotation metadata, but full rotation UI ships in Phase 3.

## Done when

An operator can create, list, re-import, and remove credentials at both the org and dev scope through the dashboard. No credential value ever renders after entry. Vault paths are reachable from runs via the allocator path established by P2A-0010.
