# Entity-Analysis Layer — `sem` as Tanren's entity primitive

> **Status: increment 1 is BUILT in this PR.** It vendors `sem` into the runner
> image and wires the Checker/Auditor + issue-triage answerer prompts to use it,
> with a graceful raw-`git diff` fallback. The cherry-picked NATIVE builds in §3 —
> the risk-triage/verdict oracle, the entity-merge first-pass in the jj
> `BaseShiftCoordinator`, and entity-anchored issue Claims — are **follow-ons**,
> deliberately not in scope here.

## §0 — Why this exists

Tanren's answerer lanes (the quality-audit Checker/Auditor and the issue-triage
"is this still present?" lane) reason about a change by inspecting a **raw line
diff** in a read-only sandbox on the runner (`git diff <baselineSha> -- .`). Line
diffs are the wrong altitude for the questions these agents actually ask:

- **"What structurally changed?"** A 400-line diff that only re-indents a file, or
  re-wraps comments, is cosmetic — but a line diff makes the agent read all 400
  lines to discover that. The agent should be able to see "0 entities changed,
  cosmetic-only" and move on cheaply.
- **"What is the blast radius?"** A one-line change to a hot function can break
  dozens of dependents and tests; a line diff shows the line, not the dependents.
- **"Does this issue's target still exist?"** An issue filed against
  `parseUserToken()` is stale if that function was renamed to `decodeAuthToken()`
  in a later refactor. Line/text tracking loses the identity across the rename;
  the issue looks live when it is actually resolved.

[`sem`](https://github.com/Ataraxy-Labs/sem) (Ataraxy Labs) is an **entity-level
diff tool**: it parses code with tree-sitter (26+ languages), extracts every
function / class / method / type as a node in a dependency graph, and gives each a
**structural-hash identity** that survives a rename/move. On top of git it
provides `sem diff` (entity add/modify/delete/rename + cosmetic-vs-structural),
`sem impact` (dependents + affected tests), `sem blame`, and `sem log` (an
entity's evolution through history). That is exactly the altitude the answerer
lanes want.

This is an accelerator **for use INSIDE Tanren — on the projects Tanren builds**.
It is NOT part of Tanren's own monorepo CI, and it is NOT a merge/jj engine
change.

## §1 — Constraints this layer must respect (non-negotiable)

1. **Optional accelerator, graceful fallback.** `sem` is a tool the AGENT runs in
   its sandbox, never a hard dependency. It covers many languages but not every
   stack; Tanren bakes in **no language assumption** (the stack-flexible contract,
   `docs/roadmap/stack-flexible-contract.md`). When `sem` is absent, errors, or
   cannot parse the stack, the agent falls back to the raw `git diff` / `git log`,
   which **remains authoritative**. An agent must never block or change its verdict
   because `sem` is unavailable.
2. **The answerer keeps its architecture.** The Checker/Auditor/triage agents
   **inspect the diff themselves** in a read-only sandbox (`baselineSha` → `HEAD`);
   prompts STEER the agent, they are NOT injected context. `sem` slots in as one
   more tool the agent runs there — Tanren does not run `sem` host-side and inject
   its output. (See the memory note: "Answerer prompt architecture".)
3. **No jj / merge changes here.** The entity-merge idea (§3.2) is a deferred
   follow-on precisely because it touches the conflict path; this increment does
   not.

## §2 — Increment 1 (this PR): vendor + answerer wiring

### 2.1 Vendor `sem` into the runner image

`runner/Dockerfile` installs the prebuilt `sem` release binary (pinned
`SEM_VERSION`, arch-mapped `linux-x86_64` / `linux-arm64`), verified against the
release's combined `checksums.txt`, to `/usr/local/bin/sem` — the same
download-verify-install pattern the image already uses for `codexbar` / `jj` /
`just`. `cargo install` is NOT used: it fails on an OpenSSL native-dep in this
image. The runner shells `sem` over SSH exactly like `git` / `jj` / `just`, so it
lands on PATH for the answerer sandboxes. A Dockerfile-inventory test asserts the
binary is installed and verified.

### 2.2 Checker / Auditor (the quality-audit lane)

Both answerer paths share one self-inspection block in
`services/orchestrator/src/engine/workflow/answererPrompts.ts`. That block now
instructs the agent, **when `sem` is available**, to run
`sem diff --from <baselineSha> --to HEAD --format json` for the entity-level change
map (added/modified/deleted/renamed; cosmetic-vs-structural) and
`sem impact <entity> --json` for the blast radius — so the audit focuses on the
structurally-impactful entities and can skip cosmetic-only changes cheaply. The
existing raw `git diff <baselineSha>` inspection stays as the **explicit
fallback** and the authoritative source.

### 2.3 Issue-triage (the "is this issue still present?" lane)

`services/orchestrator/src/engine/forge/inbox/prompt.ts` now instructs the triage
agent to use `sem`'s **entity identity** — `sem blame <file>`, `sem log <entity>`,
`sem diff` — to locate the issue's target entity and determine whether it still
exists / was modified / renamed / removed since the issue was filed, so a stale
issue about a since-refactored function is correctly resolved instead of re-routed
as live work. Structural-hash identity survives the refactor that line-tracking
would lose. The raw `git log` / grep search of the named symbol remains the
fallback and is authoritative.

### 2.4 Tests

- A Dockerfile-inventory assertion: the runner image installs + verifies `sem`.
- Prompt-content tests: the Checker/Auditor + triage prompts instruct `sem` usage
  AND name the raw-diff fallback (so the fallback can never be silently dropped).

## §3 — Cherry-picked NATIVE builds (follow-ons, NOT in this PR)

These are the durable wins, mapped onto Tanren's existing seams. Each is a
separate increment with its own design + tests.

### 3.1 Native risk-triage + verdict for the checker (our oracle taxonomy)

Fold an entity-change **risk triage** (cf. `inspect`'s risk model) and a
**structural verdict** (cf. the ConGra change-grading work) into the checker as part of
the **oracle taxonomy** (memory: "Tanren = general build engine" — the oracle
taxonomy is the generality mechanism). The entity-level change map becomes a
first-class signal the checker reasons over deterministically before the LLM
judgement: a cosmetic-only change is a different risk class than a public-API
signature change. This is **native** (built into the checker/oracle), not a
shelled tool, so it composes with the P0–P3 finding currency.

### 3.2 Entity-merge as a deterministic first-pass in the jj `BaseShiftCoordinator`

`weave`'s entity-level merge can resolve a class of conflicts deterministically
(two edits to DIFFERENT entities in the same file are not a real conflict). Wire it
as a **deterministic first-pass** inside the never-discard `BaseShiftCoordinator`
conflict path: try entity-merge first; only a genuine same-entity conflict falls
through to the agent resolver (memory: "Conflict-handling architecture" — a
conflict must never brick; genuine conflicts are agent-resolved).

> **EXPLICITLY NOT weave-as-a-git-merge-driver.** weave ships as a git merge
> driver; Tanren's delivery runs on **jj** (`WorkspaceVcsCore`, jj-only, no git
> fallback — `docs/architecture/tanren-owns-the-engine.md`). A git merge driver
> clashes with jj. The entity-merge value is taken as a **library first-pass in
> the coordinator**, not as a git-config merge driver. This is why §3.2 is
> deferred: it touches the merge/jj engine, which increment 1 does not.

### 3.3 Entity-anchored issue Claims

Anchor an issue/finding to a **durable entity Claim** (the structural-hash identity,
not a file:line) in the Tanren-native defect ledger (memory: "Lodestar
Tanren-native ledger" — durable Claim + self-validating oracle). A Claim anchored
to an entity self-resolves when `sem` reports the entity removed/refactored, and
survives the refactors that would orphan a line-anchored claim. This is the
durable form of the §2.3 staleness check: the triage agent's one-shot decision
becomes a standing, self-validating Claim.

## §4 — Open questions / follow-on sequencing

- **§3.1 first** (it sharpens the checker with no engine risk), then **§3.3**
  (entity Claims ride the same `sem` primitive), then **§3.2** (gated behind the
  post-apex jj/merge cutover, since it touches the engine).
- **Cache locality:** `sem` keeps a SQLite entity cache; on the ephemeral runner
  sandbox each invocation may rebuild. If the entity map becomes a hot path (§3.1),
  evaluate persisting/priming the cache per workspace. Out of scope for
  increment 1, where `sem` is an occasional agent-run accelerator.
- **Version pin cadence:** `sem` is pre-1.0 and fast-moving; the `SEM_VERSION`
  build-arg keeps bumps a one-line change, like `codexbar` / `jj` / `just`.
