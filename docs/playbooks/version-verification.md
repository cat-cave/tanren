# Version Verification Playbook

Tanren pins versions only after checking an official upstream source. Do this before changing any pin for GitHub Actions, Docker images, Node, pnpm, Postgres, Vault, oxlint, TypeScript, package dependencies, or runtime tools.

## Procedure

1. Identify the exact pin and why it is changing.
2. Check the official upstream source, such as project release notes, package registry owned by the project, official docs, or the official repository.
3. Confirm compatibility with `PROJECT_BRIEF.md`, especially Node 24, Postgres 18, and Docker Engine 29.x expectations.
4. Update the pin and any related lockfile or docs.
5. Include the upstream source and verification date in the PR summary or roadmap spec.

## GitHub Actions

Keep `actions/checkout@v6` and `actions/setup-node@v6` unless a newer verified major is intentionally adopted. Keep `package-manager-cache: false` so Corepack owns pnpm setup. Keep workflow permissions at `contents: read` unless a spec explicitly requires more.

## Docker Images

Prefer immutable or major-version pins for core infrastructure. Floating tags such as `latest` need a documented reason and must not affect reproducibility of agent workloads.
