<!-- cspell:ignore adapterization -->

# VCS / CI / merge-integration adapterization plan (plan-only)

**Status: PLAN ONLY — do not build from this doc.** This makes the GitHub seam
concrete enough to decide whether to invest. It does not authorize work.

GitHub is hardcoded across Tanren's run loop. The existing deferral
(`docs/roadmap/expansion-and-strictness-plan.md` §"Deferred (NOT a clean
adapter) — GitLab / VCS-provider abstraction") scoped this at ~3–4 weeks and
held it "for later deliberate design. Do not build blind." This doc IS that
deliberate design: it maps every GitHub-assuming surface in code, proposes a
contract set mirroring the existing clean adapter seams (Allocator /
SecretStore / SourceConnector + their conformance suites), states what a second
backend (GitLab/Gitea) concretely requires, and gives an honest effort +
sequencing estimate. It does not duplicate the connectivity/SaaS priming track
— this is purely the VCS/CI/merge coupling.

The headline conclusion up front: **the VCS-operations layer (PR / push /
checks / repo-read) is a genuinely clean adapter and is worth doing. The CI
provider and the merge integration are NOT clean adapters** — they encode the
"GitHub Actions runs `tanren-ci.yml`" and "Mergify watches a label on a GitHub
org" execution models, which a second backend does not share. Those two are the
hard, expensive part and should stay GitHub-only behind a thin seam until a real
second-backend requirement exists.

---

## 1. The coupling map (every GitHub-assuming surface in code)

All paths are under `services/orchestrator/src/` unless noted.

### 1a. VCS operations — PR / push / checks / repo-read

| File                                                              | What it assumes about GitHub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/providers/github.ts`                                      | The core. `GitHubHttpClient` (`/repos/:owner/:name/...`, `Bearer` token, `api.github.com`, `X-GitHub-Api-Version`), `GitHubPullRequestService.ensureDraftPullRequest` (POST `/pulls` with `draft:true`, 422-race reuse), `GitHubStatusService.fetchPullRequestChecks` (separate `/commits/:sha/check-runs` + `/commits/:sha/status` endpoints — GitHub's two distinct check models), `fetchRequiredContexts` (`/branches/:b/protection/required_status_checks`), and URL parsers hardwired to `github.com/:owner/:name` and `.../pull/:n`. Rate-limit backoff reads `X-RateLimit-*` / `Retry-After`. |
| `engine/providers/githubReviewMerge.ts`                           | `markReadyForReview` (PATCH `{draft:false}`), `fetchReviewVerdict` (GET `/pulls/:n/reviews` + GitHub's per-reviewer "latest non-comment wins" precedence), `applyQueueLabel` (POST `/issues/:n/labels` — Mergify trigger), `mergePullRequest` (PUT `/pulls/:n/merge`, 405/409 = conflict). The review-state vocabulary (`approved`/`changes_requested`/`commented`/`dismissed`) is GitHub's.                                                                                                                                                                                                         |
| `engine/providers/githubAppTokenMinter.ts`                        | The entire GitHub App auth model: RS256 JWT `iss=appId`, exchange at `/app/installations/:id/access_tokens`, ~1h installation tokens, in-memory cache. No analog on a PAT-only or GitLab backend.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `engine/workflow/githubDraftPr.ts`                                | Orchestrates push + `ensureDraftPullRequest`; persists `runs.pr_url`; emits `github.branch.pushed` / `github.pr.created` / `github.failed` events (GitHub-named event types).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `engine/workflow/ciPolling.ts`                                    | `GitHubPullRequestChecks` → `CiObservation`. Encodes GitHub's dual check-run-vs-commit-status model, the `success`/`neutral`/`skipped` conclusion set, and required-context gating from branch protection. Task `cli` column is literally `'github'`.                                                                                                                                                                                                                                                                                                                                                |
| `engine/workflow/ciWebhook.ts` + `routes/githubWebhooks/index.ts` | Parses GitHub `check_run`/`check_suite`/`status` webhook payload shapes (`X-GitHub-Event` header, `pull_requests[].html_url`). Resolves runs by `pr_url`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `engine/workspace/githubPush.ts`                                  | `git push https://github.com/...` over HTTPS with an `x-access-token` askpass shim. The remote URL is built by `githubHttpsRemote()`; assumes installation/PAT tokens work as the HTTPS password.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `engine/forge/brownfield/githubRepoReader.ts`                     | Brownfield reader: lists `/git/trees/:ref?recursive=1`, reads `/contents/:path` (base64). High-signal fragments include `.github/workflows/` and `.mergify.yml`. Implements the already-abstracted `RepoReader` interface (`forge/brownfield/types.ts`) — the one place a clean seam already exists.                                                                                                                                                                                                                                                                                                 |
| `engine/forge/brownfield/githubConfigInjection.ts`                | Writes Tanren config back into the repo via GitHub.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `engine/forge/inbox/githubConnector.ts` / `issuesConnector.ts`    | GitHub Issues as a candidate source. (Adjacent to the already-abstracted `SourceConnector` inbox seam — not core to the run loop, but GitHub-coupled.)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `engine/notifications/channels/githubChecks.ts`                   | Posts a commit _status_ (`POST /repos/.../statuses/:sha`) as a notification channel. Already behind the `NotificationChannel` seam, but the impl is pure GitHub.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `engine/observability/timedGitHubHttp.ts`                         | Decorator over `GitHubHttpClient` for timing — wraps the GitHub client specifically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 1b. Credentials / auth

| File                                                                                      | What it assumes                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/credentials/githubTokenResolver.ts`                                               | The resolution chain: App-installation token (preferred) → static `credential/github/...` ref. Hands back `{ token, source, refresh() }`. This is the chokepoint every VCS call funnels through — and the natural place a `VcsAuth` seam would sit.                                                                                                                                                   |
| `engine/credentials/githubApp.ts`, `orgGithubApp.ts`, `githubToken.ts`, `refNamespace.ts` | App credential load, per-org installation persistence (`organizations.config.github_app`), static-ref validation, ref namespacing. All GitHub-shaped.                                                                                                                                                                                                                                                 |
| `routes/auth/githubAppInstall.ts`                                                         | The App install onboarding flow (state cookie → GitHub install URL → callback persists `{installationId, appId, credentialRef}`). Pure GitHub App lifecycle.                                                                                                                                                                                                                                          |
| `auth/githubProvider.ts`                                                                  | **Operator identity** via GitHub OAuth (`/login/oauth/authorize`, `/user`, `/user/emails`, `/user/orgs`). NOTE: this is ALREADY abstracted behind the `IdentityProvider` interface + registry in `mainAuth.ts` (alongside OIDC/Authentik/local_dev). It is **out of scope** for VCS adapterization — operator login and repo connectivity are separate concerns and the identity seam already exists. |

### 1c. The gate — native, not a CI provider

There is **no CI-provider coupling to abstract**: delivery is Action-less. The gate
is Tanren's own and is provider-neutral by construction:

- **`engine/ci/schema.ts` + `engine/ci/resolve.ts`** — the versioned `.tanren/ci.yml`
  contract (tiers `fast`/`slow`, `when` lifecycle points, `bootstrap`). A
  `CiConfigV1`, not an Actions workflow.
- **`engine/workflow/gate/**`** — Tanren runs those tier steps **itself\*\*, over SSH
  on the runner workspace, and reads the verdict from exit codes. This is just
  shell; it is provider-neutral and not coupled to any VCS.
- **Verdict publication** — the result is published back to the forge as a
  `tanren/gate` check (`engine/workflow/plannerRunCi.ts`); the `pre_merge` tier is
  the merge authority. There is no external CI to trigger or poll; the dead Actions
  observe path (the old `ciPolling.ts` / `ciWebhook.ts` model) was pruned in the
  no-Actions cutover. Reading post-merge branch checks for the auto-issue watcher
  uses `VcsProvider.readBranchChecks`, the same provider seam below.

So the only VCS coupling here is **publishing** a check result, which is part of
the `VcsProvider` surface (§2), not a separate CI-provider abstraction.

### 1d. Merge integration — native queue (no Mergify)

- **`engine/workflow/reviewMerge/mergeDispatch.ts`** — the merge stage. Four
  modes from project config: `direct_merge` (PUT `/pulls/:n/merge`),
  `native_queue` (enter Tanren's **own** intelligent merge queue — DAG-order
  serialized merge + speculative batch-check + bisect + intent-preserving conflict
  resolution; no external app), `external_reviewer` (hand off to a human),
  `not_configured` (safe default → hand off). Emits `merge.queued` /
  `merge.completed` / `merge.conflict` / `merge.failed` / `merge.blocked`.
- **`engine/workflow/reviewMerge/governancePosture.ts`** — strict/open/audit_only
  posture gate; resolves PR contributors via GET `/pulls/:n/commits` GitHub
  logins to detect external (non-Tanren) changes.
- **`engine/workflow/reviewMerge/reviewPolling.ts` + `context.ts`** — mark-ready +
  review-verdict polling (GitHub review model).

The merge engine itself (`native_queue`) is Tanren's own and provider-neutral in
intent — what it needs from a VCS is mechanical: open/update a PR, read review +
check state, and accept a merge. Those calls are the `VcsProvider` surface (§2);
GitLab/Gitea would supply their own impl (MR API, pipeline/check state, merge-train
or merge-when-pipeline-succeeds). There is no Mergify-style external app to port.

### 1e. Anything else that purely assumes GitHub

- **Wiring / construction:** `main.ts` constructs a single
  `new TimedGitHubHttpClient(new FetchGitHubHttpClient())` and threads
  `githubHttp` into the worker (`engine/worker/runExecutor.ts`,
  `engine/worker/index.ts`), webhooks, brownfield, forge, inbox routes. One
  construction point — good for adapterization, but everything downstream takes
  a `GitHubHttpClient` typed parameter, not a neutral interface.
- **Event vocabulary:** `engine/events/registry.ts` (+ `sensitivityRules.infra.ts`)
  define `github.branch.pushed`, `github.pr.created`, `github.pr.ready`,
  `github.pr.merged`, `github.failed` event types. Provider-named in the durable
  event log.
- **DB:** `runs.pr_url` is a GitHub PR URL; `tasks.cli = 'github'` for CI/merge
  system tasks; `organizations.config.github_app` holds the installation.
- **URL shapes:** `parseGitHubRepository` / `parseGitHubPullRequestUrl` /
  `githubHttpsRemote` hard-code the `github.com` host + `/pull/` path. GitLab uses
  `/-/merge_requests/`, Gitea uses `/pulls/`.

**Count:** ~20 source files materially assume GitHub (the deferral note said
~18; close). The HTTP client funnel (`github.ts`) + token resolver are the two
chokepoint files; the CI-observe and merge-dispatch logic are where the real
provider semantics leak out.

---

## 2. Proposed contract set

Modeled on the existing seams: a small neutral interface + a `Fake` impl +
factory/registry + a conformance suite invoked once per impl (exactly how
`Allocator` / `SecretStore` / `SourceConnector` are structured). Place under
`engine/contracts/vcs/`.

### 2a. `VcsProvider` — PR / repo / push / checks (the clean one)

Neutral domain types first (no GitHub names):

```ts
export interface RepoRef {
  host: string;
  owner: string;
  name: string;
} // host generalizes github.com
export interface ChangeRequest {
  id: string;
  number: number;
  url: string;
  draft: boolean;
  baseBranch: string;
}
// "ChangeRequest" deliberately neutral: PR (GitHub/Gitea) ≡ MR (GitLab).
export interface CheckResult {
  name: string;
  state: "pending" | "success" | "failure";
  url?: string;
  required?: boolean;
}
export interface ChangeChecks {
  headSha: string;
  checks: CheckResult[];
  requiredContexts?: string[];
}
export type ReviewVerdict = "approved" | "changes_requested" | "pending";

export interface VcsProvider {
  parseRepoRef(repoUrl: string): RepoRef;
  cloneUrl(repo: RepoRef): string; // https remote for push
  ensureDraftChangeRequest(i: EnsureDraftInput): Promise<ChangeRequest & { reused: boolean }>;
  fetchChecks(i: { repo: RepoRef; number: number } & Auth): Promise<ChangeChecks>;
  markReady(i: { repo: RepoRef; number: number } & Auth): Promise<void>;
  fetchReviewVerdict(
    i: { repo: RepoRef; number: number } & Auth,
  ): Promise<{ verdict: ReviewVerdict; reviewer?: string; feedback?: string }>;
  listContributors(i: { repo: RepoRef; number: number } & Auth): Promise<{ logins: string[] }>; // for governance posture
  readRepoTree(i: { repo: RepoRef; ref: string } & Auth): Promise<RepoTree>; // absorbs RepoReader
  readFile(i: { repo: RepoRef; path: string; ref: string } & Auth): Promise<string | undefined>;
}
```

`Auth` is `{ token: string; refresh?: () => Promise<string> }` — the existing
`ResolvedGithubToken` shape, generalized. **The 401-refresh + rate-limit-backoff
machinery in `FetchGitHubHttpClient` stays per-impl** (it's GitHub's header
vocabulary); the contract only promises "a call may transparently refresh once."

This contract absorbs `github.ts`, `githubReviewMerge.ts`, `githubRepoReader.ts`,
`githubPush.ts`'s remote-building, and the contributor-listing in
`governancePosture`. The brownfield `RepoReader` interface already proves
`readRepoTree`/`readFile` are cleanly extractable.

### 2b. `VcsAuth` — token resolution (the chokepoint)

```ts
export interface ResolvedToken {
  token: string;
  source: string;
  refresh(): Promise<string>;
}
export interface VcsAuth {
  resolve(ctx: { installation?: unknown; staticRef?: string }): Promise<ResolvedToken>;
}
```

This generalizes `githubTokenResolver.ts`. The GitHub impl keeps the App-token
minter; a GitLab impl uses a project/group access token or OAuth refresh token.
**The App-installation model does not generalize** — `installation` stays an
opaque per-provider blob in `organizations.config`.

### 2c. `CiProvider` — run/observe CI (NOT clean; thin seam only)

```ts
export interface CiProvider {
  // Trigger is OPTIONAL: GitHub's impl is a no-op (Actions auto-runs on push).
  triggerCi?(i: { repo: RepoRef; ref: string } & Auth): Promise<void>;
  observeCi(i: { repo: RepoRef; number: number; headSha: string } & Auth): Promise<ChangeChecks>;
}
```

Honest framing: `observeCi` is just `VcsProvider.fetchChecks` re-skinned. The
_reason_ to split it out is that a non-Actions backend (GitLab CI, Buildkite)
observes pipelines through a **different API surface** than the VCS's
PR/MR/checks endpoints, and may need `triggerCi`. For GitHub it collapses back
into `fetchChecks`. Keep `CiProvider` as a marker seam that defaults to the
VcsProvider's checks; do not over-build it until a non-Actions backend is real.

### 2d. `MergeIntegration` — queue/merge (NOT clean; mode-pluggable shell only)

```ts
export type MergeMode = "direct_merge" | "queue" | "external_reviewer" | "not_configured";
export interface MergeResult {
  merged: boolean;
  queued: boolean;
  mergeSha?: string;
  conflict: boolean;
  message: string;
}
export interface MergeIntegration {
  mode: MergeMode;
  enqueue(i: { repo: RepoRef; number: number } & Auth): Promise<void>; // GitHub: apply Mergify label; GitLab: add to merge train
  merge(i: { repo: RepoRef; number: number; method?: string } & Auth): Promise<MergeResult>; // direct merge
}
```

The dispatcher (`mergeDispatch.ts`) already routes on mode + emits neutral-ish
`merge.*` events; that structure survives. What does NOT survive: the
`mergify_queue` _implementation_ (a GitHub-org label convention) and the merge
trains _implementation_ are unrelated. The contract papers over them with
`enqueue()`, but each impl is bespoke. This is the single hardest seam to make
honest — see §5.

### 2e. What stays explicitly GitHub-only (for now)

- The GitHub **App** installation flow (`routes/auth/githubAppInstall.ts`, the
  minter) — no second backend justifies it yet; keep it behind `VcsAuth` as the
  GitHub impl's private detail.
- The check webhook route (`routes/githubWebhooks/`) — GitHub payload shapes.
  Keep as a GitHub-only fast-path; polling is the provider-neutral fallback.
- `github.*` event types in the durable log — renaming them is a migration; defer
  until a second backend forces it (add neutral aliases then, don't rewrite
  history).

---

## 3. What a second backend (GitLab / Gitea) concretely requires

Per contract, what a GitLab impl (the harder of the two; Gitea is closer to
GitHub) must supply:

| Contract                                | GitLab reality                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VcsProvider.parseRepoRef` / `cloneUrl` | `gitlab.com/group/subgroup/project` (nested namespaces — `owner` is insufficient; need a path). URL host configurable for self-hosted.                                                                                                                                                                                                       |
| `ensureDraftChangeRequest`              | Merge Requests API (`POST /projects/:id/merge_requests`), `draft:` via title `Draft:` prefix or `draft` flag. Projects are addressed by numeric/encoded ID, not `owner/name` — need a path→id lookup.                                                                                                                                        |
| `fetchChecks` / `observeCi`             | GitLab **pipelines** + **jobs** (`/projects/:id/pipelines/:sha`), not check-runs+statuses. Different status vocabulary (`success`/`failed`/`running`/`canceled`/`manual`). Required-context gating ≈ "pipeline must succeed" project setting, not branch-protection contexts. **This is a from-scratch rewrite of `evaluateCiObservation`.** |
| `markReady` / `fetchReviewVerdict`      | MR `draft` flip via `PUT`; "approvals" API is different from GitHub reviews (approval rules, not approved/changes_requested states). Review-verdict reduction logic is GitHub-specific and must be rewritten.                                                                                                                                |
| `listContributors`                      | MR commits API — comparable, low-risk.                                                                                                                                                                                                                                                                                                       |
| `readRepoTree` / `readFile`             | Repository tree + files API (`/projects/:id/repository/tree`, `/files/:path/raw`) — comparable, low-risk (Gitea/GitLab both have these).                                                                                                                                                                                                     |
| `VcsAuth`                               | Project/group access tokens or OAuth; **no App-installation analog.** GitLab's closest is a group access token, provisioned differently.                                                                                                                                                                                                     |
| `CiProvider.triggerCi`                  | GitLab CI runs `.gitlab-ci.yml` on push (like Actions) — but Tanren's `tanren-ci.yml`→Actions bridge has no GitLab equivalent. Someone must author a `.gitlab-ci.yml` that runs the `tanren-ci.yml` tiers, OR Tanren generates one. **New work with no current analog.**                                                                     |
| `MergeIntegration.enqueue`              | **Merge trains** (`merge when pipeline succeeds`) — a native API enqueue, not a label. Mergify does not exist on GitLab. Bespoke.                                                                                                                                                                                                            |

**Gitea** is materially easier: its API is deliberately GitHub-shaped
(`/pulls/:n`, check-runs-ish via integrated Actions, `owner/repo`), so a Gitea
impl is mostly URL/host changes + auth. **If a second backend is wanted to prove
the seam, do Gitea first, not GitLab** — it validates `VcsProvider` for ~1/3 the
cost without paying the GitLab CI/merge-train tax.

---

## 4. Conformance-suite approach (new backend = new impl + registry entry)

Mirror `tests/conformance/**` exactly. The Allocator suite is the template: a
reusable `describeVcsProviderConformance(label, harness)` invoked once per impl
in a `vcsProvider.conformance.test.ts`, asserting **the contract only** (shapes,
idempotency, the refresh-once promise), never GitHub-specific request paths or
mock-call counts. Each impl is driven by an injected fake HTTP transport (the
allocator suite injects mock cloud clients the same way).

```
tests/conformance/
  vcsProviderConformance.ts          # describeVcsProviderConformance(label, { make, repoRef, ... })
  vcsProvider.conformance.test.ts    # describeVcsProviderConformance("GitHub", {...})
                                     # describeVcsProviderConformance("Gitea", {...})  ← one line to add a backend
  mergeIntegration.conformance.test.ts
```

Contract assertions worth pinning (drawn from how `allocatorConformance.ts`
asserts well-formed results + idempotency):

- `ensureDraftChangeRequest` returns a well-formed `ChangeRequest` (non-empty
  url, `draft:true`, correct baseBranch) and is **idempotent / reuse-safe**
  (second call with the same head/base returns `reused:true`, no duplicate).
- `fetchChecks` reduces a mixed pending/failed/passed transport response to the
  documented `pending`/`failure`/`success` rollup, and honors `requiredContexts`
  gating when present (the `evaluateCiObservation` truth table becomes the
  conformance fixture — provider-neutral).
- `merge` distinguishes conflict (recoverable) from hard failure.
- A 401 from the transport triggers exactly one `refresh()` + retry.

A new backend becomes: implement `VcsProvider`, add one
`describeVcsProviderConformance("X", …)` line + a registry entry in the
`buildVcsProvider(env)` factory (mirroring `buildSecretStore`). No refactor of
call sites — they already take the interface.

---

## 5. Effort, sequencing, and the honest verdict

**Total: ~3–4 weeks, matching the original estimate.** This did not get cheaper
on inspection. The breakdown:

**Phase 1 — extract `VcsProvider` + `VcsAuth` (the clean, worth-it core).
~1.5 wk.** Define neutral types; refactor `github.ts` + `githubReviewMerge.ts` +
`githubRepoReader.ts` + `githubPush.ts` to implement `VcsProvider`; generalize
`githubTokenResolver.ts` to `VcsAuth`; thread the interface (not
`GitHubHttpClient`) through `githubDraftPr.ts`, `ciPolling.ts`, `reviewMerge/**`,
the worker, and `main.ts`'s single construction point; add the factory +
conformance suite with GitHub as the only impl. **This is real, mostly
mechanical, and pays off immediately** (it makes the worst-coupled files testable
against a neutral fake and is a prerequisite for everything else). Low risk —
no behavior change, GitHub stays the only backend, full green CI is achievable.

**Phase 2 — prove the seam with Gitea (optional, only if a second backend is
actually wanted). ~1 wk.** Gitea's GitHub-shaped API makes this mostly host/URL

- auth. Validates that `VcsProvider` is genuinely neutral. Skip GitLab here.

**Phase 3 — CI provider + merge integration (the hard, expensive part).
~1.5–2 wk and NOT a clean adapter.** This is where the estimate is honest about
pain:

- **Hardest coupling #1 — CI observe model.** `ciPolling.ts`'s
  `evaluateCiObservation` encodes GitHub's dual check-run/commit-status model,
  the `success`/`neutral`/`skipped` conclusion set, and branch-protection
  required-context gating. A GitLab/Buildkite backend observes _pipelines/jobs_
  with a different status vocabulary. There is no shared abstraction that isn't
  lossy; `CiProvider.observeCi` papers over genuinely different APIs. Plus the
  **CI trigger gap**: today Actions is assumed pre-wired and Tanren only
  observes — a non-Actions backend needs trigger logic that does not exist in
  code at all.

- **Hardest coupling #2 — merge integration.** `mergify_queue` is a GitHub-org
  label convention watched by a third-party GitHub App; GitLab's merge trains are
  a native, unrelated mechanism. `MergeIntegration.enqueue()` unifies them only
  superficially — each impl is bespoke, and Mergify simply does not exist off
  GitHub. The governance-posture external-change detection
  (`governancePosture.ts`) also leans on GitHub commit-author _logins_; identity
  attribution differs per backend.

**Sequencing decision: do Phase 1 if/when there is appetite for it on its own
testability/longevity merits** (it aligns with the contracts-as-durable-asset
goal in `docs/architecture/portability-and-longevity.md`). **Do NOT do Phase 3
speculatively** — it is the bulk of the cost, has no clean abstraction, and only
pays off with a committed non-GitHub-Actions / non-Mergify customer. Keep CI and
merge GitHub-only behind the thin `CiProvider` / `MergeIntegration` markers (which
default to GitHub) so the seam _exists_ without the expensive second impls.

**Recommendation:** the value of this doc is the decision it enables.
**Phase 1 is a defensible standalone investment** (~1.5 wk) that improves
testability and de-risks the worst-coupled files with zero behavior change.
**Phases 2–3 stay deferred** until a concrete second-backend requirement
appears — and when it does, **Gitea before GitLab**, and budget the full ~3–4 wk
because the CI + merge layers were never clean adapters and inspection confirms
they still aren't.

---

_See also: `docs/roadmap/expansion-and-strictness-plan.md` (the original
deferral rationale), `docs/architecture/portability-and-longevity.md`
(contracts-as-durable-asset / conformance-suite philosophy), and
`tests/conformance/**` (the seam-conformance template this plan mirrors)._
