# Product Entities (P2A-0018)

Tanren's product information model is the persistent shape behind the hi-fi
vision. Even though Phase 2 does not ship the DAG canvas or the Forge
interview, every Phase 2 spec persists data through this model so the
Phase 2B and Phase 3 surfaces are additive — they read these tables, they
do not migrate them.

Owner spec: `P2A-0018` in `docs/roadmap/phase-2a-specs.md`.

## Vocabulary

The hierarchy is **Persona → Behavior → Spec**, with Specs grouped by
**Milestone** and connected by directed **Spec Dependency** edges.

- **Persona** — a role on a project (or shared across projects in an org).
  Examples: "Sales Manager", "Line Worker". Authoring lives in Phase 2B
  spec-creation forms and Phase 3 Forge interview.
- **Behavior** — owned by a persona. A BDD `Given / When / Then` scenario
  plus a free-form description. The unit of verification: Check and Audit
  Answerers reference behavior ids when reporting a verdict.
- **Milestone** — project-scoped, ordered, with optional ETA. The hi-fi's
  velocity card cites ETA against milestones.
- **Spec ↔ Behavior** — many-to-many. A spec demonstrates one or more
  behaviors.
- **Spec ↔ Milestone** — many-to-one. A spec belongs to a single
  milestone. The schema stores the link as a join table to keep the door
  open for future many-to-many evolution, but a unique index on `spec_id`
  enforces the current product rule.
- **Spec Dependency** — directed edge `from -> to`. `from` depends on
  `to`; `to` must complete first. Edges form a DAG; cycles are rejected
  at insert time.

## Tables

All ids are `text` for parity with the existing `projects` and `specs`
schema. New ids minted by the stores are prefixed (`persona_<uuid>`,
`behavior_<uuid>`, `milestone_<uuid>`), but inbound ids only need to be
stable opaque strings.

| Table | Purpose | Key constraints |
|---|---|---|
| `personas` | org- or project-scoped role | `personas_scope_check`, `personas_scope_project_check` (scope=`org` → `project_id IS NULL`; scope=`project` → not null) |
| `behaviors` | BDD scenario owned by persona | FK to `personas`; indexed on `persona_id` |
| `milestones` | project-scoped, ordered, optional ETA, status enum | `UNIQUE (project_id, label)`, `UNIQUE (project_id, order_index)`, status `planned|in_flight|done|abandoned` |
| `spec_behaviors` | spec ↔ behavior join | composite PK; indexed on `behavior_id` |
| `spec_milestones` | spec → milestone join | composite PK plus `UNIQUE (spec_id)` enforcing one-milestone-per-spec |
| `spec_dependencies` | directed edges with no self-loop | composite PK, `from <> to` CHECK; cycle detection in application code |

## Visibility rules

- **Persona reads.** Org-scoped personas are visible to any actor with
  `org:member` or `org:admin` for that org, and to any project actor in
  any of the org's projects. Project-scoped personas are visible to org
  members and to actors of the owning project.
- **Behavior reads** authorize via the parent persona.
- **Milestone reads** require either org membership or project membership
  on the owning project.
- `platform:admin` bypasses these checks.

The `PersonaStore`, `BehaviorStore`, `MilestoneStore`, and
`SpecDependencyStore` accept an `ActorContext` from
`services/orchestrator/src/auth/schemas.ts` (P2A-0003) and enforce the
rules above on every read and write.

## Cycle detection

`assertNoCycle(client, fromSpecId, toSpecId)` runs before every
`SpecDependencyStore.insert`. The algorithm is a forward DFS from
`toSpecId` along existing `from -> to` edges. If the DFS reaches
`fromSpecId`, the new edge `fromSpecId -> toSpecId` would close a cycle;
the store throws `CyclicSpecDependencyError` with the full path so the
operator can see which existing edges to remove. Self-loops throw
`SelfSpecDependencyError`. SQL also enforces the no-self-loop CHECK as a
backstop.

## Default seed

The 0004 migration includes a `DO $$ ... $$` block that walks every spec
row missing a `spec_milestones` or `spec_behaviors` link and attaches a
per-project default:

- Milestone: `label = "M1"`, `name = "Hello"`, `order_index = 0`, status
  `planned`.
- Persona: project-scoped, `name = "Developer · fixture operator"`.
- Behavior: title `"runs the fixture"`, Given `"operator on a fresh
  stack"`, When `"they invoke the fixture flow"`, Then `"the run
  completes end-to-end"`.

A project whose `org_id` is still null inherits the sentinel
organization `org_default_p2a_0018`. The block ends with a guard that
fails the migration if any spec still lacks a milestone or behavior
link, so the post-condition is enforced rather than assumed.

## Phase plan

- Phase 2A (this spec): tables, Zod schemas, repositories, cycle
  detection, default seed.
- P2A-0013: HTTP routes and CLI commands for persona / behavior /
  milestone / dependency CRUD will consume these stores. No routes
  ship in this spec.
- Phase 2B: spec-creation form selects a milestone and tags one or more
  behaviors.
- Phase 3: DAG canvas authoring and Forge interview populate these
  tables interactively. No further migration is needed.
