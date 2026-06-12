# Environment management — toolchains as project-declared, never platform-baked

**Status: design, pending sign-off. Not yet built.** This doc defines how Tanren
provisions the **toolchain/runtime environment** a project builds in. It is the
environment-layer counterpart to the command-layer stack-agnosticism Tanren already
has, and it closes the gap apex-v33 surfaced.

## 1. The gap (why this exists)

Tanren's CI contract is **already stack-agnostic at the _command_ level**:
`CiConfigV1` (`.tanren/ci.yml`) carries an opaque `bootstrap.run`, opaque tier steps,
and a project-declared test-report path — "Tanren names no tech stack itself"
(`engine/ci/schema.ts`). The `justfile` is filled from the architecture step's
`CaptureLifecycle` (bootstrap/tier1-3/build/deploy command strings + a free-form
`stack` _label_). Tanren never parses those commands; a Rust project's `cargo clippy`
and a TS project's `pnpm lint` are identical from the engine's view.

But the **runner _image_ is stack-_specific_**. `runner/Dockerfile` bakes one
project toolchain — `nodejs` + `npm install -g pnpm@10` + `corepack` — alongside
Tanren's own harness (jj, just, codex). It is referenced as a single hardcoded
default `ghcr.io/cat-cave/tanren-runner:v0` (`workflow/projectSpec.ts:23`,
`config/shared.ts:94`); the `projects.runner_image` per-project override exists but
**nothing populates it**. So the contract invites any stack, while the runner can
only satisfy node/pnpm.

apex-v33 hit this concretely: a ts/pnpm scaffold's `just bootstrap`
(`corepack enable pnpm && pnpm install`) failed because `corepack enable` can't write
root-owned `/usr/bin` as the non-root `tanren` SSH user, and corepack then auto-fetched
a pnpm version broken against the baked node. **The reflex fix — pin node/pnpm versions
into the image — is the disease, not the cure.** It hardcodes one stack into core and
makes "build anything" (TS on alpha tooling; Python; Fortran with decades-old deps;
even non-code work) impossible.

**The miss:** toolchain _provisioning_ was never made a project-declared,
runtime-provisioned concern the way _commands_ were. It was implicitly assumed to live
in the baked image.

## 2. Doctrine

1. **Tanren core hardcodes zero toolchains, runtimes, or versions.** The project
   declares _what_ (which tools at which versions — its choice: latest, alpha, or
   ancient) and _how_ (the bootstrap shell). Tanren owns only language-agnostic
   machinery: caching, content-keying, validation, and upgrade _policy_.
2. **No from-scratch environment** — symmetric with the no-from-scratch-project
   doctrine (`docs/roadmap/templating-system.md`). Every workspace seeds from a
   **validated Environment image**; a no-match triggers **just-in-time environment
   creation** (research → author → build → validate-with-negative-controls → publish)
   or halts loud. The build-it-from-scratch flow survives only as the BUILD step of
   environment creation.
3. **Environments are first-class, templated, layered, living artifacts** — paired
   with code templates, not welded to them.

## 3. The model — four layers

### Layer 1 — Declaration (project-owned, like `ci.yml`)

The project ships its toolchain declaration in its repo, version-controlled:

- **Default tier — `mise.toml` + `mise.lock`.** The project declares
  `[tools] node = "22"`, `python = "3.13"`, `rust = "nightly"`, etc.; `mise.lock`
  pins exact versions + checksums + URLs (the determinism + cache-key anchor).
- **Escape-hatch tier — `flake.nix`.** For the genuine long tail (decades-old C/Fortran,
  exotic system-lib pinning, byte-reproducible nightly) the project ships a Nix flake.

The **writer authors** this file as part of the scaffold; the **architecture step seeds**
the initial versions. Versions are always the project's choice — never Tanren's. To
support this, `CaptureLifecycle` (today: `stack` label + command strings) gains an
optional **toolchain declaration** (the resolved tool set), and the scaffold skeleton
materializes the `mise.toml`/`flake.nix` the same deterministic way it already
materializes `justfile` + `.tanren/ci.yml`.

**Selection rule Tanren applies:** `flake.nix` present → Nix tier; else → mise tier.
Tanren detects the file; it never picks the versions.

### Layer 2 — Provisioning (the neutral, capable runner)

The runner becomes a **neutral sandbox**: base OS + `build-essential` (a C toolchain to
_compile_ things) + git + SSH + network + writable `$HOME`, plus Tanren's _own_ harness
(jj, just, codex/codexbar/ccusage — isolated from the project toolchain) and **one
general provisioner: `mise`**. The `bootstrap` shell stays opaque and omnipotent — it
can `mise install`, `nix develop`, `apt`, `curl|sh`, anything. The runner bakes **no
project toolchain**.

**Provisioner decision — `mise` primary, Nix escape hatch.**

- **`mise` (jdx/mise)** is the per-project, user-space provisioner for the ~95% case:
  rootless (installs under `~/.local/share/mise`, fits the non-root CI user), Rust-fast
  (~5ms vs asdf ~120ms shim overhead — matters because the gate shells in repeatedly),
  ~947 tools across secure backends (`aqua`/`github`/`cargo`/`npm`/`pipx`/`go`/`http`),
  a real lockfile (`mise.lock`), and nightly/alpha selectors. It reads `.tool-versions`
  too (asdf superset), so asdf is strictly dominated — no reason to choose it.
- **Nix flakes + a self-hosted binary cache (attic)** is the opt-in tier for what mise
  can't: reproducibly rebuilding decades-old toolchains (research rebuilt 99.94% of a
  6-year-old nixpkgs; 15-year-old apps build by pinning a historical commit). It is
  heavy (nix store, flake authoring), so it is **strictly flake-present-only**, backed
  by attic so cold builds become warm pulls.

Known tradeoff to accept: **mise nightly is not byte-reproducible** (no exact-date lock);
a project needing pinned nightly pins a dated channel (`nightly-2025-03-28`) or drops to
the Nix tier.

### Layer 3 — Layering: baseline (golden image) vs. delta (workspace-prep)

This is the **"what the image ships with" vs. "add/alter"** distinction as first-class
layers — and the **speed mechanism** (workspaces must boot fast).

- **Baseline = the golden image.** A pre-built, **trimmed** OCI image (BuildKit) per
  environment lineage, carrying the neutral sandbox + the harness + `mise` + a **warm
  `mise` cache of the empirically-common baseline** (recent Node/Python/Go LTS, etc.).
  Trim policy follows the GitHub `runner-images` discipline: **bake what's slow-to-install
  and common; omit the rare.** **Refreshed on every `main` update** via a scheduled
  BuildKit build, tagged by content digest.
- **Delta = workspace-prep.** The project's specific adds/version-changes layered on at
  prep time by `mise install` from its `mise.lock`, in user space. Tools already warm in
  the baseline are no-ops (instant); only the genuine diff downloads. The prepared layer
  is content-keyed and cached (below), so a second runner pulls rather than re-resolves.

### Layer 4 — Lifecycle: JIT creation, validation, refresh, forced upgrade

**JIT environment-image creation** (mirrors code-template creation):

- The environment's identity is its content hash:
  `env_key = sha256(base_digest ‖ mise.lock ‖ flake.lock?)`.
- **Match check = a registry HEAD** on `env:<env_key>` in a self-hosted OCI registry.
  **Hit → seed instantly. Miss → JIT build** (BuildKit for mise-tier; **nix2container +
  attic** for Nix-tier — ~1.8s rebuild/push, JIT-grade). Always base a JIT build on the
  current golden base, never scratch; feed BuildKit `--cache-from` the base + sibling
  envs (zstd, `mode=max`).
- **Validate before publish — positive smoke + negative controls** (the same oracle
  shape as code-template validation, `templates/validationProof.ts`):
  - _Positive:_ run the project's `bootstrap` + a toolchain-check (every declared tool
    resolves to its **locked** version, exit 0). The toolchain must actually _work_.
  - _Negative:_ an **undeclared** tool is **absent** (a Python-only env must fail to find
    a stray global Node) and a **wrong/forbidden version** is **not** resolvable. This
    proves isolation and catches golden-base leakage. **Non-optional** — without it,
    "isolated" envs silently aren't.
  - Only on green: `push` to `env:<env_key>`, mark **validated**, record provenance +
    proof. A failed validation never publishes.

**Continuous refresh + trim:** golden bases rebuild as `main`/env-specs change; the trim
pass keeps them lean (bake slow+common, delta the rest).

**Required `upgrade` verb — deterministic forced upgrades.** `CiConfigV1` gains an
`upgrade` lifecycle verb alongside bootstrap/tiers (and the `justfile` gains the target),
**required** so every project declares how to bump deps to latest (`pnpm update --latest`,
`cargo update`, `uv lock --upgrade`, `go get -u`, …). Tanren owns the **policy**, not the
command (Renovate-style, language-agnostic): a `keep-current` posture, a
`minimum_release_age` cooldown (dodge just-published supply-chain'd versions), and
group/one-PR knobs. A forced-upgrade run regenerates the lockfile, recomputes `env_key`,
rebuilds+revalidates the env image, and runs the existing tier/build gate to prove green
before merge — **forced upgrade and env-image refresh are the same pipeline.** This is
the _structural_ fix for agents picking multi-year-old versions, beyond prompting. Escape
hatch for a project that declares no `upgrade` verb: Tanren runs Renovate (self-hosted) to
open the changeset, then routes it through the same gate.

## 4. How it composes (one paragraph)

A project ships a **declaration** (`mise.toml`/`mise.lock`, or `flake.nix` for the long
tail) and a `.tanren/ci.yml` lifecycle (bootstrap/tier/build/deploy/**upgrade**). Tanren
keeps a **trimmed golden base image** (BuildKit, refreshed on `main`, warm mise baseline).
At workspace-prep it computes `env_key = hash(base_digest ‖ lockfiles)` and checks the
**OCI registry**; on hit it seeds instantly, on miss it **JIT-builds**, **validates with
positive smoke + negative controls**, and publishes the validated env image. The
**`upgrade` verb** (project command + Tanren policy) forces deps to latest, regenerates
lockfiles, recomputes `env_key`, and rebuilds+revalidates through the same gate. **Tanren
core hardcodes no toolchain or version anywhere.**

## 5. Coupling to code templates — paired, not welded

A code template **references** an Environment (a validated code template implies a
validated, fast-booting environment), but environments are **independently** created,
validated, versioned (`lts`/`nightly` channels, mirroring `TemplateStore`), and refreshed.
Re-point a code template at a newer environment; share one environment across many code
templates. The environment registry is a **parallel table to `templates`**, same
capability-keyed selection + negative-control publish gate.

## 6. Integration seams (grounded in current code)

| Concern                      | Today                                                                                                                      | Change                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Runner image                 | one hardcoded `tanren-runner:v0` default (`projectSpec.ts:23`, `shared.ts:94`); per-project `projects.runner_image` unused | resolve `env_key` → golden base image; runner stripped of project toolchain, gains `mise`                                        |
| Image selection              | per-project, resolved once; allocator blind to content (`AllocationRequest.runnerImage`)                                   | per-project env binding → image; add the env-resolve step before allocate                                                        |
| Env registry                 | none                                                                                                                       | new `environments` table + store, parallel to `TemplateStore`/`manifest.ts` (capabilities, channel, provenance, validationProof) |
| Toolchain declaration        | `CaptureLifecycle.stack` is a label only (`forge/interview/types.ts`)                                                      | add optional toolchain declaration; scaffold materializes `mise.toml`/`flake.nix` (skeleton path, like `contractFiles.ts`)       |
| `upgrade` verb               | absent from `CiConfigV1` (`ci/schema.ts`) + skeleton                                                                       | add `upgrade` to schema + `SKELETON_CI_CONFIG` + `justfile` targets                                                              |
| Workspace-prep delta         | clone → materialize contract files → jj init → bootstrap (`plannerRunWorkspace.ts`)                                        | insert env-resolve + `mise install` delta before bootstrap                                                                       |
| Validation negative controls | typecheck/lint/test/mutation (`validationProof.ts`)                                                                        | add a `toolchain`/isolation negative control for env images                                                                      |
| Golden-image build/cache     | none                                                                                                                       | BuildKit golden-base build (refresh-on-`main`) + OCI registry + `mode=max` cache; attic for Nix tier                             |

Constraint preserved: `.tanren/ci.yml` stays a **deterministic skeleton** (never
LLM-authored); only the `justfile` + the new `mise.toml`/`flake.nix` are lifecycle-filled.

## 7. Phased build plan (multi-PR)

- **P0 — Neutral runner + mise (unblocks apex).** Strip the project toolchain from
  `runner/Dockerfile`; add `mise` + a warm common baseline; keep the harness. Scaffold
  materializes a `mise.toml` from the lifecycle; bootstrap becomes `mise install &&
<project install>` in user space (kills the corepack/`/usr/bin` EACCES). _This alone
  lets apex proceed._
- **P1 — `upgrade` verb.** `CiConfigV1` + skeleton + `justfile` + the forced-upgrade
  policy; scaffold-time upgrade so new projects start near-latest.
- **P2 — Golden-image build + refresh-on-`main` + trim.** BuildKit pipeline, OCI
  registry, `mode=max` cache, content-digest tagging.
- **P3 — Environment registry + `env_key` resolution + per-project binding.** The
  `environments` table/store, the workspace-prep env-resolve + delta step.
- **P4 — JIT environment creation + validation.** research→author→build→validate
  (positive + negative controls)→publish, mirroring code-template creation; the no-match
  seam; the registry HEAD match.
- **P5 — Nix escape-hatch tier.** flake detection → nix2container + attic; the long tail.
- **P6 — Code-template ↔ environment reference.** Wire the pairing; channels.

P0 is the apex unblock and is independently shippable; P1–P6 deepen toward the full model.

## 8. Decisions to confirm before building

1. **mise primary + Nix escape hatch** (vs. Nix-first everywhere). Recommendation: mise
   primary — lighter, faster boot, pairs with the golden-image delta; Nix opt-in for the
   long tail. Net: two builders (BuildKit + nix2container) as deliberate surface area.
2. **`upgrade` verb required** (vs. optional). Recommendation: required — it's the
   structural anti-stale-version lever; a project with literally nothing to upgrade
   declares a no-op.
3. **Self-hosted OCI registry + attic** as the env-image + cache + NAR backend (vs. a
   hosted service). Recommendation: self-hosted (cost-conscious, no new external trust).
4. **Per-project env binding** (vs. per-run). Recommendation: per-project — matches
   today's image-selection grain; a re-bind is an explicit project change.
