# Org setup onboarding

**Surface**: the 4-step onboarding wizard a fresh operator runs after first GitHub sign-in.

**Owning spec**: P2B-0002 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-onboard-org.jsx`; low-fi import will land at `docs/design/operator-flows/onboarding-org-setup.svg`.

## In scope for Phase 2

- [ ] **Step 1 — link GitHub org**: surfaces a CTA to install the Tanren GitHub App on the operator's GitHub org. Includes a "what Tanren will ask for" panel listing the scope (read contents/metadata/issues/PRs/checks, write branches/PRs/comments/issues, read org members for review routing) and the never-asks list (no main-branch push, no admin/billing/secrets). Stack-health card shows live `/doctor` output (P2A-0013) for Postgres, Vault, runner SSH reachability, runner image presence, GitHub reachability.
- [ ] **Step 2 — credentials**: two columns — `org · shared` (anthropic-prod and openai-org-fallback API keys form, billed-to-org) and `dev · {user}` (codex chatgpt bundle import, billed-to-dev). Each credential entry creates a Vault path via P2A-0013 credential routes; the form is write-only (no value shown after save). Future-bundle picker shows Codex/opencode/Claude bundle types as add buttons.
- [ ] **Step 3 — notifications**: rendered via the notifications matrix surface (`notifications-matrix.md`).
- [ ] **Step 4 — infrastructure**: shows local-docker as the active v0 allocator with concurrency, memory/CPU, and runner image fields editable. Cloud allocators (Hetzner, DigitalOcean, AWS, Kubernetes) render as phase-badged stubs with a brief description and pricing hint. Budgets reminder card surfaces monthly cap + infra portion. Final step closes onto "connect a repo" → the existing-project minimal track.
- [ ] **Persistence**: each step autosaves on completion; partial progress is resumable via a deep link.
- [ ] **Exit-anywhere**: the topbar carries a "↩ dashboard" button that routes back to the project view.

## Reductions from the hi-fi

- Cloud allocator rows are non-functional stubs (Phase 4+).
- "Label → allocator routing" panel is a phase-badged stub (Phase 3+).
- Custom bundle drop (`drop a json file`) ships in Phase 3 once the generic JSON-bundle credential schema is generalized.

## Done when

A fresh operator with no Tanren data can complete all four steps using GitHub OAuth alone, end at a working project view with the org row, default allocator configuration, ntfy notification target, and at least the Codex bundle credential stored — all without CLI.
