# `VcsProvider` → `CodeHost` / `VisibilityProjection` decomposition — completed cutover record

> Status: **IMPLEMENTED — landed across a 9-PR series.** This doc was the design that
> gated the build; the build is now done. The 26-method `VcsProvider` interface and its
> impls (`engine/contracts/vcsProvider.ts`, `providers/githubVcsProvider.ts`,
> `buildVcsProvider.ts`, the `VcsProviderCodeHost` / `VcsProviderVisibilityProjection`
> adapters, `UnconfiguredVcsProvider`) are **DELETED** — a `grep VcsProvider services/*/src`
> finds only historical doc-comments. The methods are decomposed onto the minimal
> `CodeHost` (host I/O) + best-effort `VisibilityProjection` (PR/check/comment mirror);
> the `mergeable_state` read was severed to `CodeHost.compareRefs` (ancestry, not a forge
> verdict); the DEAD methods (`readPullRequestState`, `publishCheck`,
> `readPullRequestChecks`, …) were dropped, not ported; and the surviving primitives
> moved to `contracts/codeHostTypes.ts`, `providers/githubRepoRef.ts`, and the typed-pg-row
> read seam `engine/data/pgRows.ts`. The classification + PR sequence below is retained as
> the as-built record.

## 0. Context

The tanren-owns-the-engine cutover is **complete and unconditional** (the kill-switch
flags are deleted; the jj `WorkspaceVcsCore` + the fail-closed `MergeAuthority` + the
`integration_nodes` run model + the never-discard `BaseShiftCoordinator` are the single
live path). `docs/architecture/tanren-owns-the-engine.md` §6 defines the target host
seams that REPLACE the monolithic forge interface:

- **`CodeHost`** — minimal hosting: create repo · read default branch · push/fetch refs
  · read commit/diff/file by sha · **land an authorized ref into `main`** (a ff-only
  compare-and-swap push, NOT the host's "merge PR" API). Already exists at
  `services/orchestrator/src/engine/contracts/codeHost.ts` (8 methods) with a live
  GitHub impl `githubCodeHost.ts`.
- **`VisibilityProjection`** — the best-effort PR/check/comment mirror; every method is
  optional and the engine only ever holds the never-rejecting `SafeVisibilityProjection`
  (built via `harden`). Already exists at
  `services/orchestrator/src/engine/contracts/visibilityProjection.ts` with a live
  GitHub impl `githubVisibilityProjection.ts`.

This net-delete cleanup the cutover deferred (§7) is now **DONE**: the 26-method
`VcsProvider` (`engine/contracts/vcsProvider.ts`) plus its impls
(`githubVcsProvider.ts`, `buildVcsProvider.ts`, the `VcsProviderCodeHost` /
`VcsProviderVisibilityProjection` adapters, `UnconfiguredVcsProvider`) are **deleted**,
and the ~32 `: VcsProvider`-annotated importers were migrated onto the target seams. No
`: VcsProvider` type annotation survives.

This document preserves the design audit that classified every `VcsProvider` method,
bucketed its importers, and recorded the additive-then-migrate-then-delete sequence.
Sections 1–2 use the pre-cutover source locations and call sites; they are historical,
not a description of a live `VcsProvider` surface.

The retired interface was at
`services/orchestrator/src/engine/contracts/vcsProvider.ts:261-434`. Historical
`engine/...` paths in this record are relative to `services/orchestrator/src/`.

## 1. Historical per-method classification

The retired interface declared **26 methods**. Its design-time classification was:
**CodeHost = 9 · VisibilityProjection = 7 · DEAD = 5 · unhomed-flag = 5**.

The table is retained as the audit snapshot. “Caller,” “raw use,” “new method,” and
“migrate” refer to the state before the completed cutover; §§3–7 record the landed
outcomes.

| #   | Method (`vcsProvider.ts:line`)     | Target                                                               | Existing seam method?                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `resolveToken` (`:268`)            | **unhomed-flag → CodeHost (token supplier) / shared resolver**       | — (no seam method)                                         | The credential resolver. Every seam (CodeHost, VisibilityProjection, the jj authed-push, the provisioners) needs an access token; today they all receive `() => VcsProvider.resolveToken(creds)`. This is the credential plumbing, NOT a forge op. Recommendation §5a.                                                                                                                                                                                                                                                                                                                                                                                          |
| 2   | `resolveActorIdentity` (`:276`)    | **unhomed-flag → shared identity helper**                            | —                                                          | Merge-safety self-identity (git author / merge identity). Consumed by `botPushIdentity.ts`, `plannerRunWorkspace.ts`, `mergeDispatch.ts`. Not a host nor a projection op. Recommendation §5a.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3   | `parseRepository` (`:279`)         | **unhomed-flag → pure helper**                                       | —                                                          | Pure URL→`{owner,name}` parse (`parseGitHubRepository`). 6 call sites. Becomes a free function, not a seam method. Recommendation §5b.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | `parsePullRequest` (`:282`)        | **unhomed-flag → pure helper**                                       | —                                                          | Pure URL→`{repo,number}` parse. 3 call sites (`watcher.ts:110`, `reviewPolling.ts:113`, `mergeDispatch.ts:89`). Pure helper. Recommendation §5b.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 5   | `readPullRequestState` (`:289`)    | **DEAD**                                                             | —                                                          | **Zero external callers** (only `githubReviewMerge.ts:258` calls the underlying service internally). The recovery path that read forge-authoritative terminal state is gone after the cutover (`MergeAuthority.land` is transactional + `merge_state_unknown`-reconciled). Delete the method (keep the underlying `GitHubReviewMergeService.readPullRequestState`, still used internally).                                                                                                                                                                                                                                                                      |
| 6   | `createRepository` (`:299`)        | **CodeHost**                                                         | `CodeHost.createRepo` (`codeHost.ts:77`)                   | 2 callers: `routes/projects/greenfield.ts:145`, `forge/interview/derive.ts:225` (the latter via its own injected `createRepository` closure). Maps 1:1 onto `createRepo` (same auto-init / 422-exists / 403-forbidden typed errors).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 7   | `pushBranch` (`:302`)              | **CodeHost** (genuinely-needed; see flag)                            | — (close to `pushRef`, but SSH-over-runner)                | 1 caller: `githubDraftPr.ts:148`. This is the **SSH push from the runner workspace** (`pushWorkspaceBranchToGitHub`), NOT the HTTPS `git/refs` push `CodeHost.pushRef` does. Different transport + input shape (`ssh`/`target`/`workspacePath`). **unhomed-flag**: see §5c — pick whether this is a new `CodeHost.pushWorkspaceRef` or stays a workspace helper.                                                                                                                                                                                                                                                                                                |
| 8   | `openDraftPullRequest` (`:305`)    | **VisibilityProjection**                                             | `openOrUpdateChangeRequest` (`visibilityProjection.ts:64`) | The draft-PR open is a forge-UI mirror. Already adapted in `vcsProviderVisibilityProjection.ts:66`. The remaining raw caller is `githubDraftPr.ts:166`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | `publishCheck` (`:314`)            | **DEAD**                                                             | —                                                          | **Zero callers.** The native check-run publish (`checks:write`) is superseded by the commit-status path (`publishStatus` → `tanren/gate`); the live publisher `githubChecks.ts` + `publishGateVerdict.ts` use STATUS, not check-runs. Delete the method (and `publishGitHubCheck` if it loses its last caller).                                                                                                                                                                                                                                                                                                                                                 |
| 10  | `publishStatus` (`:322`)           | **VisibilityProjection**                                             | `publishGate` (`visibilityProjection.ts:65`)               | The `tanren/gate` commit status. Already adapted in `vcsProviderVisibilityProjection.ts:82`. Raw caller: `publishGateVerdict.ts:54` (the gate-verdict publisher).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 11  | `createIssue` (`:330`)             | **VisibilityProjection** (new method; see §4)                        | — (no seam method yet)                                     | 1 caller: post-merge `watcher.ts:263`. The post-merge-failure tracking issue is a best-effort human-facing forge artifact → it belongs on `VisibilityProjection`. Needs a new `openTrackingIssue?` method (§4).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 12  | `markReadyForReview` (`:333`)      | **VisibilityProjection** (new method; see §4) OR **DEAD** (see flag) | —                                                          | 1 caller: `reviewPolling.ts:370` (`markReady`). Un-drafting the PR is a forge-UI nicety. **unhomed-flag**: in the cutover doctrine the draft/ready gate no longer gates merge (`tanren-owns-the-engine.md` §6 "draft/ready gates merge … After: best-effort mirror"). Either a new best-effort `markChangeRequestReady?` (§4) or removed entirely (§5d).                                                                                                                                                                                                                                                                                                        |
| 13  | `readPullRequestChecks` (`:339`)   | **DEAD**                                                             | —                                                          | **Zero callers.** The native gate is the sole CI authority; reading host PR check-runs is gone. Delete the method.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | `readBranchChecks` (`:349`)        | **unhomed-flag → CodeHost OR a read helper**                         | —                                                          | 1 caller: post-merge `watcher.ts:111` (reads the BASE-branch CI after a merge to decide whether to file a tracking issue). This is a genuine forge **read** of CI on a branch ref. The cutover doctrine says Tanren's gate is authoritative, but post-merge watches the _host's_ default-branch CI (which may be GitHub Actions on the built app's repo). **unhomed-flag**: §5e — keep as a host read (`CodeHost.readBranchChecks`) or fold the watcher onto Tanren's own post-merge gate.                                                                                                                                                                      |
| 15  | `readReviewVerdict` (`:352`)       | **unhomed-flag → VisibilityProjection-read OR DEAD**                 | —                                                          | 1 caller: `reviewPolling.ts:371` (`fetchVerdict`), feeding `reviewPolling.ts:199` control flow. Per §6 doctrine host reviews become "optional external approvals" and Tanren's review record is authoritative. **unhomed-flag**: §5f — keep as a best-effort external-approval read or replace with the internal review record.                                                                                                                                                                                                                                                                                                                                 |
| 16  | `readPullRequestDiff` (`:355`)     | **CodeHost** (`readDiff`)                                            | `CodeHost.readDiff` (`codeHost.ts:92`)                     | 1 caller: `reviewPolling.ts:372` (`fetchDiff`, the reviewer Answerer's diff). `CodeHost.readDiff(repo, baseSha, headSha)` already renders the same shape from `/compare`. Migrate to the sha-addressed read.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 17  | `submitReview` (`:358`)            | **VisibilityProjection**                                             | `publishReview` (`visibilityProjection.ts:66`)             | Already adapted: `reviewPolling.ts:368` routes `submitReview` through `harden(new VcsProviderVisibilityProjection(...))`. The remaining raw use is only inside that adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 18  | `listContributors` (`:364`)        | **unhomed-flag → VisibilityProjection-read OR CodeHost**             | —                                                          | 2 sites: `mergeDispatch.ts:237,330` (the governance external-change gate reads the PR's author+committer logins). This is forge-PR-shaped (commits-on-a-PR). **unhomed-flag**: §5g — a `CodeHost`-side commit-author read keyed on the branch range, or a best-effort external read. The governance posture is a real gate, so it cannot be best-effort if it still gates.                                                                                                                                                                                                                                                                                      |
| 19  | `mergePullRequest` (`:375`)        | **DEAD**                                                             | —                                                          | **Zero callers.** The cutover removed the host-merge land path entirely: `MergeAuthority` lands via `CodeHost.landAuthorizedRef` (`mergeLandPaths.ts:108` → `runAuthorityLand` → host CAS land). The only reference is `githubVcsProvider.ts:299` delegating to the service. Delete the method (keep `GitHubReviewMergeService.mergePullRequest` only if it has another caller — it does not on the land path; verify at delete time).                                                                                                                                                                                                                          |
| 20  | `readFileOnBranch` (`:387`)        | **CodeHost**                                                         | `CodeHost.readFile` (`codeHost.ts:95`)                     | 1 caller via the adapter (`vcsProviderCodeHost.ts:52`). `CodeHost.readFile` is byte-identical. Migrate the read to the host seam.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 21  | `readBranchHeadSha` (`:397`)       | **CodeHost**                                                         | `CodeHost.fetchRef` (`codeHost.ts:86`)                     | 3 sites: `batchChecker.ts:190`, `baseShiftLiveResolve.ts:324`, and the adapter `vcsProviderCodeHost.ts:46`. `CodeHost.fetchRef({repo, remoteBranch})` returns the head sha — identical semantics. Migrate.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 22  | `readMergeability` (`:405`)        | **unhomed-flag → mostly DEAD; one survivor**                         | —                                                          | 5 sites, ALL on the legacy merge-dispatch probe path: `batchChecker.ts:140`, `mergeDispatch.ts:303`, `mergeLandPaths.ts:107`, `mergeDispatcher.ts:204`, `speculativeStackRetarget.ts:145`. Post-cutover the AUTHORITY decides freshness, not `mergeable_state`; but `mergeLandPaths.ts:107` STILL reads it to feed `runAuthorityLand` (`baseBranch`/`headBranch` + the `behind` rebase trigger). **unhomed-flag**: §5h — this is the `mergeable_state`/`update-branch` GitHub-coupling §6 explicitly names to sever; the migration must replace the mergeability READ with a jj-local / `CodeHost.fetchRef`-derived base/head signal before the method can die. |
| 23  | `updateBranch` (`:415`)            | **DEAD (after base-shift fold)**                                     | —                                                          | The legacy server-side `update-branch`. Live only as the `mergeLandPaths.ts:49` FALLBACK when `baseShiftRebase` is absent (the "pre-fold path retained through S2"). Production ALWAYS wires `baseShiftRebase` (the unified `BaseShiftCoordinator.rebaseOnto`), so the fallback is test-only. Delete once the fallback branch is removed (the unified hook is unconditional).                                                                                                                                                                                                                                                                                   |
| 24  | `retargetPullRequestBase` (`:425`) | **VisibilityProjection**                                             | `retargetChangeRequest` (`visibilityProjection.ts:67`)     | 2 sites: `mergeDispatch.ts:305` (`retargetBase`, the stacked-PR walk) + the adapter `vcsProviderVisibilityProjection.ts:108`. Re-pointing the PR base is a forge-UI mirror op → `retargetChangeRequest`. (Note: `speculativeStackRetarget.ts` is itself a §7-deferred cleanup; the method maps regardless.)                                                                                                                                                                                                                                                                                                                                                     |
| 25  | `readFileOnBranch` covered (#20)   | —                                                                    | —                                                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 26  | `deleteBranch` (`:433`)            | **DEAD**                                                             | —                                                          | **Zero callers.** The ephemeral `tanren/integ/<dep>` integration-branch cleanup is gone (no synthesized integ host ref — the jj `ancestor_stack` is the sole base model; `githubRefReset.ts:5` notes `buildIntegrationBranch` was already deleted). Delete the method.                                                                                                                                                                                                                                                                                                                                                                                          |

### 1a. Historical summary counts

- **CodeHost (5 clean maps):** `createRepository`→`createRepo`, `readPullRequestDiff`→`readDiff`, `readFileOnBranch`→`readFile`, `readBranchHeadSha`→`fetchRef`, plus `pushBranch` (flagged: SSH transport, §5c). Counting `pushBranch` as CodeHost-bound → **CHost: 6**; the 3 unhomed-with-CodeHost-recommendation (`readBranchChecks`, `listContributors`, and `readMergeability`'s base/head read) push the CodeHost-eligible set toward **~9** depending on the §5 forks.
- **VisibilityProjection (clean maps):** `openDraftPullRequest`→`openOrUpdateChangeRequest`, `publishStatus`→`publishGate`, `submitReview`→`publishReview`, `retargetPullRequestBase`→`retargetChangeRequest` = **4 existing**, plus 2 new (`createIssue`→`openTrackingIssue?`, `markReadyForReview`→`markChangeRequestReady?`) + 1 flagged (`readReviewVerdict` as external-approval read) = up to **7**.
- **DEAD (zero live callers, delete on sight):** `readPullRequestState`, `publishCheck`, `readPullRequestChecks`, `mergePullRequest`, `deleteBranch` = **5 hard-dead**; `updateBranch` is **dead-after-fold** (test-only fallback) → effectively **6**.
- **unhomed-flag (genuine forks, §5):** `resolveToken`, `resolveActorIdentity`, `parseRepository`, `parsePullRequest` (the 4 non-forge primitives), plus the doctrine forks on `pushBranch` / `readBranchChecks` / `readReviewVerdict` / `listContributors` / `readMergeability`.

The design-time headline was: **5 methods are immediately deletable, 4 map cleanly onto
existing `CodeHost` methods, 4 map cleanly onto existing `VisibilityProjection` methods,
2 need new best-effort `VisibilityProjection` methods, and ~5 are genuine doctrine forks
to decide before deletion.**

## 2. Historical importer buckets

Before the cutover, ~32 files carried a `: VcsProvider` type annotation; a handful more
referenced it only in comments. They were bucketed by the seam they needed:

### 2a. Need only `CodeHost` (code reads + ref fetch + land + repo-create)

| File                                      | VcsProvider methods used                                                   | Target                                         |
| ----------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| `routes/projects/greenfield.ts`           | `resolveToken`, `createRepository`                                         | `CodeHost.createRepo` + token supplier         |
| `routes/projects/index.ts`                | (threads provider for greenfield create)                                   | `CodeHost`                                     |
| `routes/templates/createFlow.ts`          | (threads provider for repo create)                                         | `CodeHost`                                     |
| `engine/forge/interview/derive.ts`        | injected `createRepository` closure                                        | `CodeHost.createRepo`                          |
| `engine/dag/baseShiftLiveResolve.ts`      | `resolveToken`, `parseRepository`, `readBranchHeadSha`                     | `CodeHost.fetchRef` + parse helper + token     |
| `engine/dag/baseShiftLiveSeams.ts`        | type-only field                                                            | `CodeHost`                                     |
| `engine/merge/batchChecker.ts`            | `resolveToken`, `parseRepository`, `readMergeability`, `readBranchHeadSha` | `CodeHost.fetchRef` + (§5h mergeability fork)  |
| `engine/providers/vcsProviderCodeHost.ts` | the adapter itself (`readBranchHeadSha`, `readFileOnBranch`)               | **DELETED** (callers move to `GitHubCodeHost`) |

### 2b. Need only `VisibilityProjection` (best-effort forge-UI mirror)

| File                                                   | VcsProvider methods used                              | Target                                                            |
| ------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `engine/workflow/gate/publishGateVerdict.ts`           | `publishStatus`                                       | `SafeVisibilityProjection.publishGate`                            |
| `engine/workflow/gate/publishGateVerdictBestEffort.ts` | (best-effort gate publish)                            | `SafeVisibilityProjection.publishGate`                            |
| `engine/postMerge/watcher.ts`                          | `createIssue`, `readBranchChecks`, `parsePullRequest` | `VisibilityProjection.openTrackingIssue?` (new) + (§5e read fork) |
| `engine/providers/vcsProviderVisibilityProjection.ts`  | the adapter itself                                    | **DELETED** (callers move to `GitHubVisibilityProjection`)        |

### 2c. Need BOTH seams (the run/merge lifecycle + the worker wiring)

These thread `VcsProvider` because the lifecycle does both code reads/land AND forge-UI
mirroring. They move to holding the `ProjectHostSeams` pair (`{ codeHost, visibility }`
from `hostFactory.ts:31`) — or the two seams separately:

| File                                                                                                                                           | Why both                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine/workflow/githubDraftPr.ts`                                                                                                             | `resolveToken` + `pushBranch` (host) + `openDraftPullRequest` (projection)                                                                            |
| `engine/workflow/reviewMerge/reviewPolling.ts`                                                                                                 | `markReadyForReview`/`readReviewVerdict`/`submitReview` (projection) + `readPullRequestDiff` (host read); already partially on the projection adapter |
| `engine/workflow/reviewMerge/mergeDispatch.ts`                                                                                                 | `resolveActorIdentity`, `listContributors`, `readMergeability`/`updateBranch`/`retargetBase` (the probe surface)                                      |
| `engine/workflow/reviewMerge/mergeDispatchTypes.ts`                                                                                            | `MergeProbe` type field                                                                                                                               |
| `engine/merge/mergeAuthorityBundleBuild.ts`                                                                                                    | builds `GitHubCodeHost` from `vcsProvider.http` (`:105`) — **already on the real host**; only needs the http client + token supplier                  |
| `engine/worker/boot.ts`, `autonomyLoops.ts`, `lifecycle.ts`, `runExecutor.ts`                                                                  | construct + thread the provider into the lifecycle                                                                                                    |
| `engine/merge/coordinatorBuild.ts`, `batchCoordinatorBuild.ts`, `driveCi.ts`, `driveConflictResolve.ts`, `freshRunnerGate.ts`, `subscriber.ts` | thread the provider into the merge runner                                                                                                             |
| `engine/dag/percolation.ts`, `percolationBuild.ts`, `percolationPg.ts`                                                                         | the percolation read model reads ancestor head shas (`CodeHost.fetchRef`) — §7-deferred path but still threads the provider                           |
| `engine/providers/liveJjWorkspace.ts`, `botPushIdentity.ts`                                                                                    | `resolveToken`/`resolveActorIdentity` for the jj authed push + bot identity                                                                           |
| `engine/workflow/reviewMerge/conflictResolver/jjAuthedPush.ts`, `jjWorkspaceApplier.ts`                                                        | `resolveToken` for the authed push (token supplier only)                                                                                              |
| `engine/workflow/plannerRun.ts`, `plannerRunWorkspace.ts`, `plannerRunCi.ts`                                                                   | `resolveToken` + `resolveActorIdentity` + `parseRepository` for clone/CI                                                                              |
| `mountFeatureRoutes.ts`, `mountRootApiRoutes.ts`, `main.ts`, `routes/onboarding/index.ts`                                                      | the HTTP wiring that builds + injects the provider                                                                                                    |

### 2d. Type-thread only (no method call — just carries the type)

`engine/merge/subscriber.ts` (`vcsProvider?: VcsProvider`), `routes/onboarding/index.ts`
(`vcsProvider?: VcsProvider`), and the various `…Build.ts` / `…Deps` interfaces. These
flip mechanically to the new seam type(s) with no behavior change.

### 2e. Comment-only / non-importers (no migration)

`sentryProvisioner.ts`, `deployProvisioner.ts`/`buildDeployAdapter.ts`,
`integrationProvisioner.ts`, `githubCapability.ts`, `github.ts`, `githubRefReset.ts`,
`githubRepoCreate.ts`, `githubPush.ts`, `githubActorIdentity.ts`, `githubPublishCheck.ts`
reference `VcsProvider` only in doc comments (they have their OWN grant-based
`resolveToken` or are composed BY the impl). They need at most a comment touch-up, not a
type migration. The `sentryProvisioner`/`deployProvisioner` `resolveToken` is the
_integration-grant_ resolver, NOT `VcsProvider.resolveToken` — do not conflate them.

## 3. Landed architecture

All migration steps landed across the 9-PR series. This is the authoritative live
inventory; the source locations and plan in §§1–2 and §§4–6 are historical.

- `CodeHost` (`codeHost.ts`) + `GitHubCodeHost` (`githubCodeHost.ts`) exist, conformance-
  validated (`tests/conformance/codeHost*.ts`). Live land uses `GitHubCodeHost` via
  `MergeAuthority`. Extra host reads absorbed during migration:
  `compareRefs` (ancestry; severs `mergeable_state`), `readCommitAuthors`,
  `readBranchChecks`.
- `VisibilityProjection` + `GitHubVisibilityProjection` + `harden`/`SafeVisibilityProjection`
  exist, conformance-validated. The cutover added these best-effort methods:
  `openTrackingIssue?`, `markChangeRequestReady?`, plus external-approval reads.
- `buildProjectHostSeams` (`hostFactory.ts`) builds `{ codeHost, visibility }` from the
  http client + a token supplier — **live call sites** include greenfield repo
  create/delete, post-merge watcher, review/draft PR paths, and merge dispatch.
- The transitional adapters (`VcsProviderCodeHost`, `VcsProviderVisibilityProjection`),
  the `VcsProvider` contract, `GitHubVcsProvider`, `buildVcsProvider`, and
  `UnconfiguredVcsProvider` are **DELETED**. A `grep VcsProvider services/*/src` finds
  only historical doc-comments.
- Primitives rehomed off the God-interface: `resolveVcsToken` /
  `resolveActorIdentity` (credentials), `parseGitHubRepository` /
  `parseGitHubPullRequest` (`githubRepoRef.ts` / `codeHostTypes.ts`), SSH workspace
  push stays a workspace helper (`pushWorkspaceBranchToGitHub` — §5c helper fork).

The seams, GitHub implementations, conformance suites, importer migration, and net-delete
are **complete**.

## 4. Responsibilities absorbed by the target seams

`CodeHost` required no new methods for the clean maps (#6, #16, #20, #21). The cutover
added two best-effort `VisibilityProjection` responsibilities:

1. **`VisibilityProjection.openTrackingIssue?(input): Promise<{ url; number }>`** — for
   `createIssue` (#11), the post-merge-failure tracking issue (`watcher.ts:263`). It is
   a best-effort human-facing forge artifact → optional + best-effort on the projection,
   `harden`-severed like the others. (The post-merge watcher must tolerate a `skipped`
   projection on a host with no issue support.)

2. **`VisibilityProjection.markChangeRequestReady?(input): Promise<void>`** — for
   `markReadyForReview` (#12). It remains a best-effort un-draft of the PR mirror.

The former fork reads were resolved as follows: `readBranchChecks` (#14) became
`CodeHost.readBranchChecks`; `readReviewVerdict` (#15) became the best-effort
`VisibilityProjection.readExternalApproval?`; `listContributors` (#18) became
`CodeHost.readCommitAuthors`; and `readMergeability` (#22) was replaced by
`CodeHost.compareRefs` ancestry plus `fetchRef`.

`pushBranch` (#7) was deliberately kept as the workspace-layer
`pushWorkspaceBranchToGitHub` helper, rather than enlarging `CodeHost`.

## 5. Design forks and their landed outcomes

### 5a. `resolveToken` / `resolveActorIdentity` — where does credential resolution live?

These are not forge ops; they were credential plumbing passed as
`() => VcsProvider.resolveToken(creds)` closures. **Outcome:** the cutover extracted
`resolveVcsToken(creds)` and `resolveVcsActorIdentity(token)` into the credentials path,
which `buildProjectHostSeams`, the jj authed push, and provisioners consume. The seams
remain token-free, avoiding GitHub credential shape in `CodeHost`.

### 5b. `parseRepository` / `parsePullRequest` — pure helpers, not seam methods.

**Outcome:** they became the pure `parseGitHubRepository` and
`parseGitHubPullRequest` helpers. They carry no provider state; keeping them outside a
seam preserves the small, host-neutral contract while allowing each host to parse its
own URL shape.

### 5c. `pushBranch` (#7) — SSH workspace push vs HTTPS ref push.

`CodeHost.pushRef` pushes via the `git/refs` HTTP API; `pushBranch` pushes the runner
workspace branch over SSH (`pushWorkspaceBranchToGitHub`, token-via-stdin). They are
different transports. **Outcome: (b)** — `githubDraftPr.ts` calls the workspace-layer
`pushWorkspaceBranchToGitHub` helper with a resolved token. It remains outside
`CodeHost` because it needs `ssh`/`target`/`workspacePath` and is a runner-workspace
concern, not a host-API concern.

### 5d. `markReadyForReview` (#12) — keep as best-effort, or delete?

Per §6, the draft/ready state no longer gates merge. **Outcome:** it is retained as the
optional, best-effort `markChangeRequestReady?` projection method: a human-facing
courtesy that never gates Tanren's authoritative review record.

### 5e. `readBranchChecks` (#14) — settled host-CI read for the post-merge watcher.

The post-merge watcher reads the _host's_ default-branch CI (which, for the built app's
repo, may legitimately be GitHub Actions) to decide whether to file a tracking issue.
The design fork was (a) `CodeHost.readBranchChecks(repo, branch)` as a host read, or (b)
re-point the watcher at Tanren's own post-merge gate run on landed `main`. **Landed
outcome: (a)** — the post-merge watcher watches the _external_ repo's CI signal (a
regression the built app's own CI catches), which is a host read, not Tanren's gate.

### 5f. `readReviewVerdict` (#15) — external approval read vs internal record.

The design fork was to retain a best-effort `readExternalApproval?` (host reviews as
optional external approvals) or drop the read for Tanren's internal review record.
**Landed outcome:** the read moved to the best-effort projection path without changing its
control flow; it remains advisory rather than an authoritative gate.

### 5g. `listContributors` (#18) — governance gate read.

The external-change governance gate reads the PR's author+committer logins
(`mergeDispatch.ts:237`). This is a REAL gate, so it cannot be best-effort while it gates.
The design fork was a host-neutral `CodeHost.readCommitAuthors(repo, baseSha, headSha)`
read or a forge-PR-shaped API. **Landed outcome: (a)** — contributors are derived from
the sha range via the host, making the real gate host-neutral and authoritative.

### 5h. `readMergeability` (#22) + `updateBranch` (#23) — the `mergeable_state` coupling §6 names.

This was the GitHub coupling the design identified: `mergeable_state`/`update-branch`
deciding freshness. **Landed outcome:** authority plus jj now decide freshness/conflict;
`CodeHost.compareRefs` ancestry (with `fetchRef`) supplies the base/head signal, and the
always-wired `baseShiftRebase` hook replaces `update-branch`. No host `mergeable_state`
gate remains.

## 6. Historical PR-by-PR delivery record

The cutover followed ADDITIVE → MIGRATE-by-area → DELETE-last. Each of the **9 landed
PRs** was independently green (`just ci` + `just smoke`) and up-to-date with `main`; no
PR removed a method with a caller. The original PR titles and scopes below are retained as
a delivery record, not as an outstanding execution plan.

> **Historical serialization:** PR-1 (new contract methods) and PR-8/PR-9 (deletions) touched shared
> contract files (`visibilityProjection.ts`, `codeHost.ts`, `contracts/index.ts`) and the
> worker boot wiring (`boot.ts`, `mountFeatureRoutes.ts`) — serialize those against each
> other and against any other contract-touching work. The area-migration PRs (3–6) edit
> disjoint file sets and can run in parallel worktrees AFTER PR-1/PR-2 land. None touch a
> DB migration.

| PR    | Title                                                                                                      | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Size                 | Depends on |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ---------- |
| **1** | `feat(visibility): add openTrackingIssue + markChangeRequestReady best-effort methods`                     | Add the 2 new optional methods to `VisibilityProjection` + `SafeVisibilityProjection` + `harden` + the GitHub impl; extend `visibilityProjectionConformance`. ADDITIVE — no caller yet.                                                                                                                                                                                                                                                                                              | S (~150 LOC + tests) | —          |
| **2** | `refactor(credentials): extract resolveVcsToken + resolveActorIdentity off VcsProvider`                    | §5a: standalone credential resolver + identity helper; rewire `hostFactory`, the jj authed-push, `botPushIdentity`, planner clone to consume them. `VcsProvider.resolveToken` stays (delegates) so nothing breaks. ADDITIVE.                                                                                                                                                                                                                                                         | M (~250 LOC)         | —          |
| **3** | `refactor(routes): migrate greenfield/template repo-create onto CodeHost.createRepo`                       | §2a routes + `forge/interview/derive.ts` → `CodeHost.createRepo` via `buildProjectHostSeams`. Drop `createRepository` usage.                                                                                                                                                                                                                                                                                                                                                         | M                    | PR-2       |
| **4** | `refactor(gate+postMerge): migrate publishStatus/createIssue onto VisibilityProjection`                    | `publishGateVerdict*.ts` → `publishGate`; `postMerge/watcher.ts` → `openTrackingIssue?` (+ §5e read fork: keep `readBranchChecks` as a host read for now).                                                                                                                                                                                                                                                                                                                           | M                    | PR-1, PR-2 |
| **5** | `refactor(review): migrate reviewPolling/draftPr onto CodeHost + VisibilityProjection`                     | `githubDraftPr.ts` (`openDraftPullRequest`→projection; `pushBranch` per §5c stays a workspace helper); `reviewPolling.ts` (`readPullRequestDiff`→`CodeHost.readDiff`; `markReadyForReview`→`markChangeRequestReady?`; `readReviewVerdict` step-1 →best-effort projection read per §5f).                                                                                                                                                                                              | M-L                  | PR-1, PR-2 |
| **6** | `refactor(dag+merge-reads): migrate head-sha/file reads onto CodeHost.fetchRef/readFile`                   | `baseShiftLiveResolve.ts`, `batchChecker.ts` (head-sha + file reads), percolation read model → `CodeHost.fetchRef`/`readFile`. Delete the `VcsProviderCodeHost` adapter (its 2 read methods now have real `GitHubCodeHost` callers).                                                                                                                                                                                                                                                 | M                    | PR-2       |
| **7** | `refactor(merge): replace mergeable_state read with jj/CodeHost-derived freshness`                         | §5h: replace `readMergeability` in `mergeLandPaths.ts`/`mergeDispatch.ts`/`batchChecker.ts`/`speculativeStackRetarget.ts` with a base/head signal derived from `CodeHost.fetchRef` (+ jj-local state); remove the `updateBranch` fallback in `mergeLandPaths.ts:49` (confirm `baseShiftRebase` is unconditional); `retargetPullRequestBase`→`retargetChangeRequest`; `listContributors`→`CodeHost.readCommitAuthors` (§5g). This is the load-bearing coupling PR — review carefully. | L                    | PR-2, PR-6 |
| **8** | `refactor(contracts): drop VcsProviderVisibilityProjection adapter + dead methods`                         | Delete `VcsProviderVisibilityProjection`; remove `mergePullRequest`, `publishCheck`, `readPullRequestChecks`, `readPullRequestState`, `deleteBranch`, `updateBranch` from the `VcsProvider` interface + `GitHubVcsProvider` + `UnconfiguredVcsProvider` (and the now-orphaned underlying services if no other caller).                                                                                                                                                               | M                    | PR-3..PR-7 |
| **9** | `refactor(contracts): delete VcsProvider + GitHubVcsProvider + buildVcsProvider + UnconfiguredVcsProvider` | Remove the contract file, the GitHub impl, the registry/factory, the unconfigured impl, the worker-boot wiring, the conformance suites for `VcsProvider`, and every residual `: VcsProvider` annotation (now zero). Flip `boot.ts`/`mountFeatureRoutes.ts`/`main.ts` to construct + thread `ProjectHostSeams`. Final net-delete PR.                                                                                                                                                  | L (large net-delete) | PR-8       |

Notes:

- PR-7 was the genuine-risk delivery (the freshness coupling) and was on the critical path
  to deleting the interface in PR-9.
- The `speculativeStackRetarget.ts` / `resolveSpeculativeState` cleanup remained outside
  this decomposition because `retargetPullRequestBase` already mapped to
  `retargetChangeRequest`.
- PR-9 realized `docs/architecture/tanren-owns-the-engine.md` §7's minimal `CodeHost`
  seam; that document records the landed state.

## 7. Open decisions (resolved as-built)

The genuine forks from the design phase, resolved on `main`:

1. §5c — `pushBranch`: **workspace-helper** (`pushWorkspaceBranchToGitHub`).
2. §5d — `markReadyForReview`: **kept** as best-effort `VisibilityProjection.markChangeRequestReady?`.
3. §5e — `readBranchChecks`: **`CodeHost.readBranchChecks`** (post-merge watcher host CI read).
4. §5f — `readReviewVerdict`: external-approval read on the projection path (best-effort).
5. §5g — `listContributors`: **`CodeHost.readCommitAuthors`** over a sha range.
6. §5h — `readMergeability`/`updateBranch`: **severed** to `CodeHost.compareRefs` ancestry
   (+ `fetchRef`); no host `mergeable_state` gate remains.

Residual outside this decomposition (not VcsProvider work): the stacked-PR retarget walk
(`resolveSpeculativeState` / `speculativeStackRetarget.ts`) still lives as the jj-local
`ancestor_stack` base + PR-base retarget — possible rename off "speculative" vocabulary
only. See `docs/architecture/tanren-owns-the-engine.md`.
