# Project and Organization Config

Tanren carries a typed, versioned config substrate for both organizations and
projects. The schemas live next to the orchestrator engine
at `services/orchestrator/src/engine/config/` and are the single source of
truth — JSON Schema is a generated documentation artifact, not an
independently maintained file.

## Where config lives

Typed config is stored in the database only:

- `organizations.config` (jsonb) carries `OrgConfigV1`.
- `projects.config` (jsonb) carries `ProjectConfigV1`.

Other operator surfaces that _look_ like config are intentionally kept out
of the DB:

- `.tanren/ci.yml` (a `CiConfigV1`, **not** a GitHub Actions workflow) and
  `CODEOWNERS` live in the target repository. `.tanren/ci.yml` is the native
  shell-tier gate definition Tanren runs over SSH — the sole merge authority.
  Tanren reads it from the workspace (`engine/workflow/gate/resolveGateConfig.ts`)
  and, for a brownfield link, can propose it as an injected file
  (`forge/brownfield/configInjection.ts`); it is not an environment-coupled
  Actions artifact. (Merge ordering is Tanren's own native merge queue — there
  is no external merge-queue config in the repo.)
- The optional `tanren-config` audit-gate write path that promotes reviewed
  config changes through a PR review is not yet built.
  `OrgConfigV1.auditGateEnabled` exposes the on/off bit so the operator UI can
  render the toggle, but the write path is inert.

## Versioning

Both schemas are wrapped in a `z.discriminatedUnion("version", [V1])` so a
future `V2` is an additive branch rather than a re-encoding of every row.

- Additive fields: bump nothing. Append the field with a default in V1.
- Breaking changes: introduce `V2`, write a `migrateOrgConfig` /
  `migrateProjectConfig` arm that produces a V2 from a V1, and continue to
  accept V1 reads until the migration backfill is complete.

When the migration helper observes a `version` it does not know how to
read, it throws a typed `UnknownConfigVersionError` and the caller decides
between refusing to start, falling back to defaults with a warning, or
delegating to an out-of-process migrator.

A row with no `version` field is treated as a Phase 1 legacy row and
normalized to V1 defaults; any ad-hoc free-form keys on a Phase 1 row are
dropped.

## The 6-role routing table

Tanren's writer/Answerer roles are `plan`, `write`, `check`, `audit`,
`demo`, and `forge`. The routing table maps each role to a **fallback
chain** of `{ cli, model, authRef, healthHint? }` entries. Every role's chain
is always an array, so the schema shape does not change as Codex, Claude,
opencode, or other providers are mixed into a chain.

Example with a single Codex entry for the writer:

```json
{
  "version": 1,
  "routing": {
    "write": {
      "chain": [{ "cli": "codex", "model": "gpt-5", "authRef": "vault://codex/prod" }]
    }
  }
}
```

Roles omitted from the request body default to `{ chain: [] }`; the
operator UI renders every role's column even when v0 has nothing to put in
it.

## Project vs. org layer

Org config carries fully-defaulted values for every field. Project config
treats most fields as **partial overrides** on top of the org defaults
(`escapeHatches`, `allocator`, `forgePersona`), so a project only needs to
declare the deltas it cares about. The exception is `routing`, which is a
full table at the project layer because the operator UI surfaces the
merged view per role.

The merge logic lives in the engine loaders that read both layers; the
schemas themselves are intentionally stateless.

## Migration helpers

```ts
import { migrateOrgConfig, migrateProjectConfig, UnknownConfigVersionError } from "@tanren/orchestrator/engine/config";

const cfg = migrateProjectConfig(row.config);
// cfg.version === 1, every field defaulted.
```

`migrateOrgConfig` and `migrateProjectConfig` accept `unknown`, normalize
legacy versionless rows into V1 defaults, parse V1 inputs strictly
(unknown keys are rejected), and throw `UnknownConfigVersionError` on
future versions.

## JSON Schema export

`orgConfigJsonSchema()` and `projectConfigJsonSchema()` produce JSON
Schema documents derived from the Zod definitions via `z.toJSONSchema`.
The output is documentation-only; runtime validation always uses the Zod
parser.
