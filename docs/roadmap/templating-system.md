# Templating system — one fragment-only scaffold path, missing fragments AUTHORED

This is the doctrine-of-record for Tanren's project templating, and it is
**load-bearing**: the orchestrator code cites this file by section
(§1 = the one rule, §2 = the per-fragment authoring DAG, §3 = the unified
library). The doctrine is **owner-stated and enforced in code** — it is not
aspirational.

> **Status (PR-G — task #77, LANDED).** PR-F's fragment-only scaffold path
> shipped, and PR-G collapsed the remaining intermediate: the per-stack
> `tanren-tmpl-<slug>` template seed repo is GONE. The composed VFS now lands
> **directly in the project repo** as its initial content; the run path no
> longer clones a separate seed repo at workspace-prep. The materializer is a
> single step (compose → push every composed file to the project repo's
> default branch via the GitHub contents API), the per-stack template-repo
> creation is gone, and the `templateRef` persisted on `projects.config` is
> now a bare opaque identifier (`tanren://composed/<slug>@<contentHash>`) —
> no GitHub repo exists at this ref.
>
> **Status (PR-F, LANDED — preserved here for context).** The doctrine collapse
> to a single fragment-only scaffold path is built: the dual `scaffoldOrigin`
> (project / template_build) is gone, the agent-driven template-build DAG is
> gone, the `templates` registry table is gone, the template-creation meta-flow
> is gone, the template-maintenance scheduler is gone, the `template.*` event
> vocabulary is gone, and the `templateBuild` config marker is gone.
> Replacing them: the fragment composer is the SOLE materialization path; a
> missing fragment triggers the **per-fragment authoring DAG (F2)** that
> AUTHORS the fragment via a real LLM and persists it into the org's
> `fragments` table. The next `selectFragmentConfig` call then resolves
> `ready` against the augmented library and the project derive proceeds.

---

## The one rule (the user's directive)

> _"Let's make there be only exactly one way, the right way, for tanren to
> get repos scaffolded. Since fragments are the way we're going, this should
> be the way to act. If someone is using tanren to translate russian
> fanfiction, then they need to make a lot of custom fragments, but maybe
> they share some spellchecking linter fragments with someone using tanren to
> craft their D&D campaign lore book. Similarly, someone wanting to take
> their existing app and simply switch from gcp to AWS may want to reuse
> nearly all fragments, subbing out only one or needing to create a new one,
> etc. We should NEVER have fallback paths or legacy workarounds. Everything
> in tanren should feel like the single intended way to do things."_

There is exactly ONE path from a captured lifecycle to a seeded project repo:

```
capture
   → assert lifecycle + design contract present (else MissingLifecycleError /
     MissingDesignContractError)
   → preflight deploy
   → selectFragmentConfig(lifecycle, library):
       - try curated lookup; on miss, synthesize from lifecycle tokens
       - walk every fragment id the config references against the library
       - return { kind: "ready", config } OR { kind: "missing-fragments", missing }
   → if missing-fragments:
       - runFragmentAuthoring(missing) — F2; see §2
       - if any authoring fails (fixed point), throw FragmentAuthoringFailedError
         → 409 fragment_authoring_failed (loud halt; no silent skip)
       - else retry selectFragmentConfig against the augmented library
   → createRepository (CodeHost.createRepo) — create the PROJECT repo, auto-init
   → composeTemplate(config, library) + materializeTemplate
       - assembles the VFS, then pushes EVERY composed file directly to the
         just-created PROJECT repo's default branch (PR-G — no intermediate
         tanren-tmpl-<slug> seed repo is created)
       - returns SeededTemplate { templateRef, validatedAt } — opaque
         identifier; no GitHub repo exists at this ref
   → prepareDeploy + createProject + scaffold/build/deploy specs
     (the writer specializes the seed already committed in the project repo)
```

There is **no fallback path**: no `scaffoldOrigin: "template_build"` mode, no
agent-template-build DAG, no `templates` registry, no template-maintenance
scheduler, no "skip selection" wiring, **no intermediate per-stack template
seed repo (PR-G — task #77)**. Every project derive runs the same code; an
unrecognized stack triggers authoring, never silent degradation.

---

## §1 — fragments are the primitive

The bundled core library (`services/orchestrator/src/engine/templates/fragments/library/`)
ships the canonical fragments: `base`, `runtime-node-pnpm`,
`runtime-ruby-bundler`, `frontend-react-router`, `frontend-remix`,
`db-postgres-prisma`, `deploy-fly`, `deploy-none`, `addon-biome`, `addon-docker`.
Each declares an `id`, `kind` (one of the 9 compose phases:
`base|runtime|frontend|backend|db|auth|addon|example|deploy`), a `contract`
(testRunner / reportPath / dbMigrationsDir / ciTier2 — what downstream
post-processors read), optional `dependsOn`, and an `apply(vfs, config)`
function that mutates a `VirtualFileSystem` via the typed surface
(`vfs.write`, `vfs.addPackageJsonDep`, `vfs.appendToJustfileTarget`, etc).

The composer (`engine/templates/fragments/compose.ts`) walks the 9 phases in
order, applies each fragment, then runs the post-processors:
`processDeps`/`processEnvVars`/`processJustfile`/`processCiYml`/`processReadme`/
`assertBaseInvariantsHeld`/`assertRuntimeAddedFunctionalTest`. The output is
a `VirtualFileSystem` — composed deterministically, validated by construction.

**Every composed scaffold bootstraps from a FRESH checkout** (task #84 — apex
v63 ERR_PNPM_NO_LOCKFILE halt class). The per-iteration `tanren-bootstrap`
gate runs `just bootstrap` against a freshly-pushed scaffold that ships a
`package.json` / `Gemfile` / `Cargo.toml` but NO committed lockfile yet — the
first bootstrap MUST GENERATE the lockfile. A runtime fragment whose
`bootstrap` recipe uses a frozen/locked install (`pnpm install
--frozen-lockfile`, `npm ci`, `yarn install --immutable`, `cargo build
--locked`, `bundle install --frozen`, `uv sync --frozen`) without a matching
committed lockfile fails the cold gate before the writer can do anything; the
doctrine-compliant primitive is the lockfile-GENERATING install (`pnpm
install --no-frozen-lockfile`, plain `bundle install`, `cargo fetch`). This
is mechanically enforced by `tests/helpers/templateFreshBootstrapCheck.ts`,
wired into both the per-fragment isolation harness and the matrix-coverage
harness — a fragment that violates the rule is rejected at the test gate
named per-fragment + per-combo. The same doctrine governs the interview-prompt
guidance in `forge/interview/prompt.ts`: an LLM-captured lifecycle must steer
the operator to a fresh-repo-safe bootstrap, never a frozen/locked install.

**Selection** (`engine/templates/fragments/selectFragmentConfig.ts`):

- a curated stack label (`registry/curated.ts` — e.g. _"ts/pnpm + Remix +
  Prisma + PostgreSQL on Fly.io"_) short-circuits to a known `TemplateConfig`.
- a no-match synthesizes a config from the captured lifecycle's stack +
  deploy tokens (open-world: any token maps to a fragment label, no closed
  enum gates it).
- the returned `TemplateConfig` is walked: every referenced fragment id is
  either present in the library (→ `ready`) or absent (→ `missing-fragments`
  with `FragmentSpec[]`).

**Materialization** (`engine/templates/fragments/materialize.ts` — PR-G — task #77):

- `buildMaterializeTemplate({ pushFile })` returns the seam `derive.ts` calls.
  It composes the chosen config, then pushes every composed file DIRECTLY to
  the JUST-CREATED project repo's default branch via the GitHub contents API,
  and returns a `SeededTemplate { templateRef, validatedAt }` where
  `templateRef` is an opaque identifier of the form
  `tanren://composed/<slug>@<sha256-prefix-over-composed-vfs>`.
- There is **no intermediate `tanren-tmpl-<slug>` seed repo**. The composed
  VFS IS the project repo's initial content; the run path no longer clones a
  separate seed at workspace-prep. The persisted `projects.config.templateRef`
  is a bare opaque string for observability — no GitHub repo exists at the ref.

---

## §2 — the per-fragment authoring DAG (F2)

When `selectFragmentConfig` returns `missing-fragments`, the derive calls
`runFragmentAuthoring(missing)` — the F2 seam wired by
`buildLiveRunFragmentAuthoring` (`routes/onboarding/fragmentAuthoring.ts`).
Each missing FragmentSpec drives one authoring run with three logical stages:

1. **Plan** — the FragmentSpec IS the plan (kind + label + required
   contract). The lifecycle requires this specific slot to be filled.
2. **Write** — the `FragmentAuthorer` seam produces a TypeScript body for the
   spec. Production wires `wrapProviderFragmentAuthorer` over the allocating
   Forge answerer adapter (`fragmentAuthorerFactory.ts`) — the SAME structured-
   output infra the planner/checker/auditor use: real LLM call, real cost
   record, real per-run scoped credentials. The writer-rework loop iterates
   the body — each rejection from VALIDATE feeds back as `previousAttempt`
   carrying the failing body + the rejection reason. UNBOUNDED while making
   PROGRESS (the body or the rejection keeps changing); stops at a FIXED
   POINT (identical body + identical rejection — per the timeout-eradication
   doctrine, no flat iteration cap).
3. **Validate** — `interpretOrgFragment` parses the body against the
   constrained-subset BNF (`vfs.write/overwrite/addPackageJsonDep/
addPackageJsonDevDep/addEnvVar/appendToJustfileTarget`); then a SMOKE
   COMPOSITION runs the production composer with the candidate fragment
   slotted in (PR-D's isolation harness pattern, inlined). A pass proves the
   body's structure + that the Fragment composes cleanly. Failure carries
   the rejection text back to the writer.

**On success**: insert into `fragments` (`status='draft'`), flip to
`status='validated'`, emit `fragment.authoring.succeeded`. The derive's
retry sees the fragment in the unified library and `selectFragmentConfig`
returns `ready`.

**On fixed-point failure**: emit `fragment.authoring.failed` with the latest
rejection text + attempt count. `failedIds` is non-empty → derive throws
`FragmentAuthoringFailedError` → route returns 409 `fragment_authoring_failed`.
The derive halts loud; an operator inspects the events, fixes the writer /
validator gate, and retries. **Never a silent skip.**

**Why the answerer (not the writer) seam.** A fragment body is a constrained-
subset DECLARATIVE artifact, interpreted by `interpretOrgFragment` — never
executed as raw TS in a workspace. The answerer pattern (single-call,
structured-output, in-process, uniform cost+usage path) is the right fit; the
writer pattern (workspace + diff capture + runner allocation) is overkill for
the "produce one structured artifact" shape. The fragment-authoring run STILL
emits durable `fragment.authoring.{started,succeeded,failed}` events through
the standard event store, so the run is observable in the same dashboard
timeline as writer events.

**Why no stub fallback.** The no-production-stubs lint
(`scripts/check-architecture-stubs.mjs`) catches any attempt to wire a
`fake`/`stub`/`noop`/`mock`-stem identifier as a production default. The test
fixture (`tests/fixtures/fragmentAuthoring.ts:buildFakeFragmentAuthorer`)
carries the `fake` stem deliberately, so it cannot accidentally land as a
production default — production must inject a real LLM-backed authorer via
`buildForgeFragmentAuthorerFactory` or fail loud at wiring time.

---

## §3 — the unified fragment library

`loadUnifiedFragmentLibrary(orgId, loadOrgFragments)`
(`engine/templates/fragments/unifiedLibrary.ts`) returns a SINGLE
`FragmentLibrary` that combines:

1. The bundled core fragments from `library/index.ts` (always present;
   evolved via tanren-monorepo PRs).
2. The org-scoped fragments persisted by the per-fragment authoring DAG into
   the `fragments` table (RLS-scoped to the org).

**Shadowing**: when an org-scoped fragment has the SAME `(kind, label)` as a
bundled core fragment, the org-scoped fragment WINS. This is the doctrine:
organizations may override Tanren's defaults; if they don't, they get the
core. The bundled fragment is replaced via the existing `replaceForTests`
seam (re-purposed; the override is a first-class behavior, not a test-only
path).

The `fragments` table schema (baseline migration `0018_fragments_doctrine_collapse.sql`):

```sql
CREATE TABLE fragments (
  fragment_id    text PRIMARY KEY,        -- "<orgId>:<kind>-<label>:<version>"
  org_id         text NOT NULL REFERENCES organizations(id),
  kind           text NOT NULL,
  label          text NOT NULL,
  version        text NOT NULL,           -- semver
  body_ts        text NOT NULL,           -- the default-exported Fragment source
  contract       jsonb NOT NULL,          -- mirrored from body for query
  depends_on     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status         text NOT NULL CHECK IN ('draft','validated'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  validated_at   timestamptz,
  UNIQUE (org_id, kind, label, version)
);
-- RLS: strictly org-scoped (no cross-org `official` tier — bundled core IS
-- the defaults; org fragments are always private).
```

The org-authored fragment BODY is interpreted (not executed) via the
constrained-subset parser, so an authored fragment cannot execute arbitrary
code at compose time even if the writer produces hostile output. The parser
rejects anything outside the allowed vfs operations at registration time.

---

## §4 — durable observability

Three events make the F2 path inspectable in the run/audit feed
(`engine/events/schemas/templates.ts`):

- `fragment.authoring.started` — one authoring run began for a missing slot
- `fragment.authoring.succeeded` — the writer's body validated + persisted
- `fragment.authoring.failed` — the writer hit a fixed point (loud terminal)

The corresponding sensitivity rules + default severities are in
`engine/events/sensitivityRules.templates.ts` and
`engine/notifications/eventDefaultSeverity.ts` (`failed` → severity `fail`
so it clears the matrix warn floor and reaches the operator).

---

## apex interaction — the next live-validation vehicle

apex will exercise the F2 path end-to-end the next time a captured lifecycle
references a fragment the bundled library doesn't have — the russian-
fanfiction case, the gcp→AWS deploy swap, etc. The first such run halts on
the authoring writer's output; the operator inspects the
`fragment.authoring.failed` event, refines the spec or the writer's prompt,
and retries. Each authored fragment lands in the org's `fragments` table and
is reusable across the org's projects.

DO NOT pre-seed the org `fragments` table — let apex flush the path
end-to-end so the writer's prompt + the validator's smoke composition are
proven on real cases.

---

## §5 — the writer-prompt MODE (specialize_seed vs from_scratch)

Task #86 (v64 root cause). Every spec carries a `mode` column — either
`specialize_seed` or `from_scratch` (DEFAULT) — that selects which standing
instructions the writer prompt assembles at every iteration. The two modes
exist because the workspace at the writer's first iteration looks
fundamentally different between the greenfield scaffold spec and every other
spec:

- `from_scratch` (DEFAULT — brownfield + non-scaffold specs): the workspace
  is the project's existing tree (or, in the legacy from-scratch case, an
  empty repo). The standing GRADING instruction tells the writer to "Build
  everything ELSE — manifest/lockfile, sources, configs, tests, fixtures"
  and to regenerate the lockfile after a manifest edit. This is the
  brownfield/legacy default and matches every spec created via the
  discovery/triage path, the BDD behavior path, the `build`/`deploy`
  foundation specs, etc.
- `specialize_seed` (greenfield's scaffold spec only, post-PR-G + PR #701):
  the workspace's initial commit IS the composed seed VFS — the manifest,
  lockfile, tsconfig, lint/test/build configs, contract files (justfile +
  `.tanren/ci.yml`), source skeleton, and demo are ALREADY in place AND
  proven green by composition. The standing instructions tell the writer to
  touch ONLY product-identity surfaces — the canonical list is the spec's
  acceptance criteria, typically the manifest's `name` field, the deploy
  descriptor's `app`/slug, `.env.example` placeholders, README, the
  product-specific demo. The writer is explicitly forbidden from rebuilding
  the manifest, regenerating the lockfile, editing tsconfig / lint configs
  / test configs / build configs, adding new tests or test fixtures, or
  touching the contract files. The lockfile-regeneration / manifest-
  companion / package-manager-upgrade rules are dropped entirely — they
  don't apply, since there ARE no manifest edits in seeded mode.

**Why both modes exist.** Before this fix, the standing instructions
contradicted the scaffold spec's text. The spec said "SEED FROM TEMPLATE —
INSTANTIATE the seed, touch only product-identity surface"; the standing
instructions said "Build everything ELSE — the manifest/lockfile, sources,
configs, tests, fixtures." The writer reads top→bottom and weights the LAST
thing it reads most heavily, so the standing instruction WON every
iteration: writer over-edits configs → checker rejects with a scope-drift
finding → writer over-edits a slightly DIFFERENT set of configs the next
iteration. v64 ran this loop for 6 hours / 61 writer iterations / 5 auditor
verdicts and produced ZERO merges — each iteration's diff was different, so
the fixed-point convergence detector (which fires only on byte-identical
diff + byte-identical rejection) never fired.

The fix is two-part: (1) the GRADING + CONTRACT standing instructions are
selected by `specMode` so the seeded scaffold spec gets the seeded
guidance, not the from-scratch guidance; (2) defensively, the rework reason
moved AFTER the standing instructions in every iteration (regardless of
mode), so on a re-iteration the LAST thing the writer reads is the concrete
failing reason — the strongest signal where it belongs.

**Plumbing.** `mode` originates in `scaffoldSpecsFor()`
(`engine/forge/interview/deriveScaffoldSpecs.ts`): the `scaffold` spec is
`specialize_seed`; `build`/`deploy` and every other spec stay
`from_scratch`. `createSpec` persists it to `specs.mode` (DB column with
default `from_scratch`, CHECK constraint mirroring the Zod enum).
`loadRunExecutionContext` reads it onto the `PlannerRunContext`;
`plannerRun` threads it into `SubtaskLoopInput.context.specMode`;
`writerPromptFor()` selects the matching standing instructions. The
`SpecMode` Zod enum lives in `engine/state/spec.ts`.

---

## Relationship to the stack-flexible contract

The templating system sits **above** the stack-flexible contract (the
`justfile` + `.tanren/ci.yml` contract; see
`docs/operator-guide/ci-config.md`):

- The **contract** is the generality mechanism — Tanren knows no stack; a
  project declares its lifecycle in a `justfile` + `.tanren/ci.yml` and
  Tanren runs it uniformly.
- The **composed seed** is the validated, fragment-built initial content of
  the project repo. The fragment composer produces a VFS that already
  satisfies the contract; the materializer pushes it directly into the
  project repo's default branch (PR-G — task #77).

> **Superseded line.** Earlier prose said "every project DAG seeds from a
> validated _template_ selected from a registry, or just-in-time-created via
> a meta-flow." The registry + meta-flow are GONE. Every seed is now a
> fragment composition; what was "create a whole template repo via an
> agent-driven DAG" is now "author each missing fragment via the F2 DAG, then
> compose."
>
> **Superseded line (PR-G — task #77).** Earlier prose said the materializer
> "creates a fresh template seed repo on the forge, pushes every composed
> file [into the seed repo]" and the run path "clones the seed into the
> project's workspace." The per-stack `tanren-tmpl-<slug>` seed repo is GONE.
> The composed VFS lands directly in the project repo as its initial content;
> the run path's separate seed-clone step is gone too.
