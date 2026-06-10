# Stack-flexible project contract (de-hardcode the build layer)

Tanren must build ANYTHING — TS/pnpm, Bun, Rust, Go, Python, a native iOS app, a
translation of a Russian novel — without hardcoding a single stack assumption in its
own code. The hardcoded-pnpm `scaffoldCiConfig.ts` / `DEFAULT_CI_CONFIG` /
`configInjection.ts` / Node-probing `bootstrap.ts` are the bug (found live on apex v25/v26).
Authoritative for the redesign. Supersedes #438/#442 + the frozen-lockfile band-aid.

## The principle

Tanren does NOT know any stack. It defines a **contract** — a repo folder structure + a
config file + **justfile command-name conventions** — that lets a PROJECT _declare_ what
its lifecycle is. Tanren reads the declaration and runs it, uniformly, across any stack —
**including a stack Tanren has never seen.** "What is tier-1/2/3? What is build? What is
deploy?" are answered PER-PROJECT (by the architecture decision + the agent), never by
Tanren's TypeScript.

## The contract (the ONLY thing Tanren's code knows)

1. **`justfile` with conventional targets** — the source of truth for the actual stack
   commands: `bootstrap`, `tier-1`, `tier-2`, `tier-3`, `build`, `deploy`. The project
   fills these for its stack (`pnpm install` / `cargo fetch` / `uv sync` / `aspell` /
   `pandoc … epub` / `xcodebuild` / …). Human-runnable locally (`just tier-1`).
2. **`.tanren/ci.yml`** (`CiConfigV1`, already generic) — what TANREN reads. It maps the
   lifecycle (tiers + `when` + bootstrap) to commands that **vastly prefer `just <target>`**:
   ```yaml
   version: 1
   bootstrap: { run: just bootstrap }
   tiers:
     fast: [{ name: tier-1, run: just tier-1 }]
     slow: [{ name: tier-2, run: just tier-2 }]
     merge: [{ name: tier-3, run: just tier-3 }]
   when: { fast: [per_iteration], slow: [pre_audit], merge: [pre_merge] }
   ```
   The ci.yml is stable + tiny + stack-agnostic; all stack specifics live in the justfile.
3. **Build + deploy** are conventional justfile targets (`just build`, `just deploy`) the
   deploy/build paths invoke — not Node-specific code.
4. Tanren's general knowledge is ONLY: the tier→lifecycle semantics (fast/per_iteration =
   cheap per-task, slow/pre_audit = at spec-completion, merge/pre_merge = at merge), the
   conventional target names, and the test-report convention (a tier that runs tests writes
   a machine-readable report to a known path so flaky-intelligence ingests it).

## The bare skeleton (the from-scratch starting point — "no-stack template")

A minimal, stack-AGNOSTIC skeleton embodying the contract: the `.tanren/ci.yml` above + a
`justfile` with STUB targets (each echoes "define <target> for this stack" + exits non-zero
so an unfilled target is loud) + READMEs explaining the contract + the folder structure.
The scaffold starts from this and the architecture FILLS the justfile targets. Lives where
the scaffold can author it from-scratch (no hardcoded stack content).

## The architecture step becomes load-bearing

The interview ALREADY captures architecture (`CaptureArchitectureLine`, free-form, e.g.
"web · next.js · turborepo") — but it's a descriptive string that the scaffold IGNORES in
favor of the Node hardcode. Fix: the architecture step captures the project's CONCRETE
lifecycle (what bootstrap/tier-1/2/3/build/deploy ARE for the chosen stack — even
"spellcheck"/"build epub" for a novel), and the scaffold AUTHORS the justfile (+ the stable
ci.yml lifecycle-map) FROM that — agent-authored against the contract, no hardcoded example.

## Delete (the hardcoding)

- `engine/forge/interview/scaffoldCiConfig.ts` — DELETE (the hardcoded pnpm example).
- `engine/ci/resolve.ts` `DEFAULT_CI_CONFIG` — replace the pnpm default with the stack-agnostic
  justfile-convention ci.yml (the map above), or remove (the repo's ci.yml is authoritative).
- `engine/forge/brownfield/configInjection.ts` — generalize: inject the justfile-convention
  ci.yml + detect/ask the lifecycle; never a pnpm YAML.
- `engine/workspace/bootstrap.ts` — remove the Node probing (`pnpm-lock`/`package-lock`/
  `package.json` → pnpm/npm). The bootstrap comes from the repo's ci.yml `bootstrap.run`
  (`just bootstrap`); frozen-vs-non-frozen is the project's concern inside `just bootstrap`,
  not Tanren's. Keep a minimal loud fallback only (no manifest + no ci.yml → a clear error /
  ask, NOT a silent Node assumption).
- The runner image must have **`just`** (the orchestration convention). Verify/install it.

## Template repos (the project SEED — see the templating doctrine)

`cat-cave/tanren-template-ts-vite`, `-rust-axum`, `-python-fastapi`, … : curated, up-to-date,
pre-filled skeletons (real hello-world conforming repos) that skip the bulk of scaffolding
with ZERO token spend. Added as REPOS (never TS).

> **Doctrine update (#498) — there is NO from-scratch-into-a-project fallback.** The
> architecture step queries the registry for a VALIDATED template; on a no-match it
> CREATES one just-in-time (research → author-from-scratch → build → validate-with-
> negative-controls → publish) and the scaffold SEEDS from it, or HALTS LOUD
> (`TemplateRequiredError` → 409). The from-scratch authoring survives ONLY as the
> BUILD step of template-creation — never as a project path. See the full doctrine in
> [templating-system.md](./templating-system.md). (The earlier "the agent authors
> from-scratch against the contract" fallback no longer exists for a project DAG.)

## Non-code projects

A Russian-novel translation conforms identically: `tier-1` = spellcheck/grammar, `tier-2` =
consistency checks, `build` = render epub, `deploy` = publish — all declared in the justfile.
Tanren runs them unchanged. The contract is the generality mechanism (see
[[feedback_tanren_general_build_engine]]).
