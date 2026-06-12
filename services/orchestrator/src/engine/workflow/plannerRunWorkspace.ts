// plannerRunWorkspace — the run's workspace-prep + bootstrap stage, extracted
// from plannerRun.ts to keep it under the 500-line architecture cap.
//
// It clones the target branch (capturing the clone HEAD), installs deps
// (bootstrap), and commits the bootstrap-generated tree as ONE synthetic
// commit. The bootstrap commit's sha becomes the writer's diff base, so the
// checker/auditor and the captured diff see only the writer's real changes —
// the install artifacts (lockfiles, node_modules) sit below the base. The
// `cloneHeadSha` is threaded onward so the PR-branch cleanup can replay the
// writer commits onto it (dropping the bootstrap commit) before the push.
import type { RunnerHandle } from "../contracts/allocator.js";
import type { ActorIdentity } from "../contracts/codeHostTypes.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import {
  bootstrapWorkspace,
  commitBootstrapState,
  materializeContractFilesInWorkspace,
  materializeTemplateSeedInWorkspace,
  provisionMiseToolchain,
  runWorkspaceSshCommand,
  seedWorkspaceLocalIgnore,
  type ProvisionMiseToolchainInput,
} from "../workspace/index.js";
import { gitAuthedCommand, gitTokenAuthPrelude } from "../workspace/githubPush.js";
import { resolveVcsActorIdentity, resolveVcsToken } from "../credentials/vcsCredentials.js";
import { resolveBootstrapCommand } from "./gate/index.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";
import { resolveAncestorStack } from "../dag/ancestorStack.js";
import { bootstrapDependentWorkspace, type ClonedWorkspace } from "./plannerRunJjLocalBootstrap.js";

// The workspace-prep step inputs (the run's bootstrap-install + commit-bootstrap-state
// seams). Co-located here with the workspace-prep stage that consumes them; `plannerRun.ts`
// re-imports them for the `RunPlannerLoopInput` test seams (a type-only import — no cycle).
export interface BootstrapStepInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  command?: string;
  // Plane B: the project's dev+test app env, injected at the SSH substrate boundary
  // (never folded into `command`, so a bootstrap failure can't leak it into the
  // error message / events). See bootstrap.ts. Undefined ⇒ no app env.
  appEnv?: Record<string, string>;
  timeoutMs: number;
}

export interface CommitBootstrapStepInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  timeoutMs: number;
}

export interface PreparedRunWorkspace {
  // The clone HEAD (base-branch tip). The writer commits replay onto this before
  // the PR is pushed, so the PR carries only the writer's source changes.
  cloneHeadSha: string;
  // The synthetic post-bootstrap commit (or "" on a fake SSH). The PR-branch
  // cleanup drops this commit (`bootstrapSha..HEAD` rebased onto the clone HEAD),
  // so EVERYTHING above it — the deterministic contract-files commit + the writer
  // commits — replays into the PR. This is the PUSH drop boundary, NOT the answerer base.
  bootstrapSha: string;
  // The ANSWERER review base: the writer's reviewed diff is `baseSha..HEAD`. It sits
  // ABOVE the Tanren-materialized contract-files commit (the contract-commit sha) when
  // one was made, ELSE the bootstrap commit, ELSE the clone HEAD (fake-SSH unit paths).
  // Anchoring it above the contract commit keeps the Tanren-owned `.tanren/ci.yml` +
  // `justfile` OUT of the writer's reviewed diff — so the checker/auditor/convergence
  // see ONLY the writer's code and never misread the contract files as writer-authored
  // (apex v28: the auditor flagged `contract-files-authored`). The files still ride into
  // the PR — only the answerer REVIEW base excludes them; the human/merge still sees them.
  baseSha: string;
  // WS-A PR-4 (walker-jj-local-integration-design.md §4): the merge-time rebase base when
  // the run's base was jj-ASSEMBLED locally from the ancestor stack (`WALKER_JJ_LOCAL_BASE`
  // on + a non-empty stack) — the LOCAL assembly bookmark name the bootstrap materialized.
  // It REPLACES `${targetBranch}@origin` as the conflict-resolver's `baseRevision` (the PR
  // head rebases onto the re-assembled stack head, not a synthesized host ref). Absent on
  // the legacy single-ref clone path (flag off / empty stack) ⇒ the conflict resolver keeps
  // `${targetBranch}@origin` exactly as today.
  bootstrappedBaseRevision?: string;
}

// Clones the target branch + installs deps + commits the bootstrap state, and
// returns the run's clone-HEAD / bootstrap / base shas.
export async function prepareRunWorkspace(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
): Promise<PreparedRunWorkspace> {
  // Resolve the run's clone token + MERGE-SAFETY pushing identity ONCE (fail-closed:
  // an authenticated run with an unresolvable identity throws here, before any clone,
  // rather than committing as an unattributable author). The SAME resolved value
  // authenticates the clone AND sets the workspace git author below.
  const resolved = await resolveCloneCredential(input);
  const cloned = await cloneWorkspace(input, target, workspacePath, resolved);
  const cloneHeadSha = cloned.cloneHeadSha;

  // MERGE-SAFETY (self-identity): set the workspace git author IMMEDIATELY after the
  // clone and BEFORE any commit (the bootstrap commit and every writer/rebase commit
  // that inherits this repo-local config). git auto-detects `<unix-user>@<host>.(none)`
  // — an unattributable author GitHub maps to a `null` login → the external-change gate
  // keys it `<unknown>` and BLOCKS Tanren's own PR. An explicit, separately-failing step
  // (not the clone command's tail) guarantees the author is configured before the commit.
  await configureWorkspaceGitIdentity(input, target, workspacePath, resolved.identity);

  // Durable node_modules guard: seed the checkout's LOCAL git ignore
  // (`.git/info/exclude`) right after clone, BEFORE any install/commit, so no
  // later `git add -A` (the bootstrap commit or any writer commit) can sweep a
  // node_modules/dist tree into the repo — which previously ballooned the writer
  // diff (and the checker/auditor prompt) past the model's input limit.
  await seedWorkspaceLocalIgnore({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs });

  // Command precedence: an explicit input.bootstrapCommand override wins;
  // otherwise resolve the repo's .tanren/ci.yml `bootstrap.run` (conventionally
  // `just bootstrap`); when the repo ships no .tanren/ci.yml the resolver yields
  // undefined and the bootstrap step falls back to the stack-agnostic
  // DEFAULT_BOOTSTRAP_COMMAND LOUD-fallback (just bootstrap, else a loud failure).
  const resolvedBootstrapCommand =
    input.bootstrapCommand ??
    (await resolveBootstrapCommand({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs }));
  // TOOLCHAIN PROVISION (environment-management.md §3 Layer 2): BEFORE the project's
  // `just bootstrap`, provision the declared toolchain. When the workspace already ships
  // a `mise.toml` at clone time (a brownfield/template-seeded repo) `mise trust && mise
  // install` lands the tools in the `tanren` user space so the bootstrap's bare
  // `pnpm`/`node` resolves correctly; a guarded no-op when no `mise.toml` is present
  // (the greenfield scaffold's first bootstrap is an empty repo — its mise.toml lands
  // with the contract files below, and the per-gate `ensureWorkspaceDepsInstalled`
  // provisions before each later bootstrap). A failed `mise install` HALTS the run
  // LOUDLY (WorkspaceMiseProvisionError) — never a silent skip. This is the PROJECT
  // path; codex/answerers keep the runner's isolated harness node (mise stays
  // un-globally-activated). Test seam: an injected `provisionMise` overrides it.
  const provisionMise =
    input.provisionMise ?? ((stepInput: ProvisionMiseToolchainInput) => provisionMiseToolchain(stepInput));
  await provisionMise({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs });
  const runBootstrap =
    input.runBootstrap ?? ((stepInput: BootstrapStepInput) => bootstrapWorkspace(stepInput).then(() => {}));
  // Plane B: the building agent runs install/build under the
  // project's dev+test app env. The app env is passed SEPARATELY (NOT folded into
  // the command string): `bootstrapWorkspace` builds the `export …;` prelude at
  // the SSH substrate boundary and prepends it to the EXECUTED command only, so
  // the ORIGINAL command — the value that flows into WorkspaceBootstrapError and
  // the `workspace.failed` / `run.failed` event payloads — never carries an
  // app-secret value. Distinct from Tanren's own provider creds.
  await runBootstrap({
    ssh: input.ssh,
    target,
    workspacePath,
    command: resolvedBootstrapCommand,
    ...(input.appEnv === undefined ? {} : { appEnv: input.appEnv }),
    timeoutMs: input.timeoutMs,
  });

  // Commit the bootstrap-generated tree as ONE synthetic commit on top of the
  // clone HEAD; its sha is the writer's diff base. When bootstrap produced
  // nothing the commit is empty (sha != cloneHeadSha); on a fake SSH the step
  // yields "" and baseSha falls back to cloneHeadSha.
  const commitBootstrap =
    input.commitBootstrap ?? ((stepInput: CommitBootstrapStepInput) => commitBootstrapState(stepInput));
  const bootstrapSha = await commitBootstrap({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs });
  const bootstrapBase = bootstrapSha === "" ? cloneHeadSha : bootstrapSha;

  // TEMPLATE SEED (templating-system.md §3): when a validated template was SELECTED at
  // derive, clone its conforming files into the workspace + commit them ON TOP of the
  // bootstrap base — so the scaffold writer's "the seed is ALREADY COMMITTED"
  // assertion is TRUE (it specializes the seed instead of authoring from scratch). The
  // seed brings the template's validated `.tanren/ci.yml` + `justfile`, so the
  // deterministic contract-files step below is a write-iff-absent no-op for them (the
  // PROVEN template contract wins). Absent templateSeed ⇒ "" (the from-scratch path).
  const seedSha = await materializeTemplateSeedCommit(input, target, workspacePath, resolved.token);
  const seedBase = seedSha === "" ? bootstrapBase : seedSha;

  // DETERMINISTIC CONTRACT FILES (v27 fix): materialize the `.tanren/ci.yml` +
  // `justfile` from the project's captured lifecycle and commit them as a REAL
  // commit ON TOP of the bootstrap base — so they ride into the writer's PR diff
  // (the bootstrap commit below the base is DROPPED on push; a contract commit ABOVE
  // it is replayed onto the PR branch). This takes contract-file authoring out of
  // the LLM writer's hands (it mangled the ci.yml YAML shape on apex v27). Write-iff-
  // absent (never-clobber): on a later run that re-clones a repo already carrying the
  // contract files, materialization is a no-op and NO commit is made (sha "").
  const contractSha = await materializeContractFilesCommit(input, target, workspacePath);

  // ANSWERER REVIEW BASE: anchor the writer's reviewed diff ABOVE the Tanren-owned
  // commits — the contract-files commit when one was made (apex v28 fix), ELSE the
  // template-SEED commit, ELSE the bootstrap base — so the template seed + the
  // Tanren-owned `.tanren/ci.yml` + `justfile` are NOT in the writer's reviewed diff
  // and the checker/auditor/convergence never misread them as writer-authored (the
  // writer only SPECIALIZES the seed). All these commits still RIDE INTO THE PR — the
  // push drops only `bootstrapSha` (below them), so each is replayed onto the PR branch.
  const baseSha = contractSha === "" ? seedBase : contractSha;

  return {
    cloneHeadSha,
    bootstrapSha,
    baseSha,
    // WS-A PR-4: surface the locally-assembled base revision ONLY when the bootstrap path
    // ran (flag on + non-empty stack); absent ⇒ the conflict resolver keeps the legacy
    // `${targetBranch}@origin` base.
    ...(cloned.bootstrappedBaseRevision !== undefined && {
      bootstrappedBaseRevision: cloned.bootstrappedBaseRevision,
    }),
  };
}

// Materialize the SELECTED template's conforming files into the workspace + commit
// them as a dedicated commit above the bootstrap base (templating-system.md §3), so
// the scaffold writer's "the seed is ALREADY COMMITTED" assertion holds and it
// specializes the seed instead of authoring from scratch. Returns the new seed-commit
// sha, or "" when no commit was made: the run selected no template (`templateSeed`
// absent — the from-scratch path), a fake SSH yields no sha, OR the seed produced no
// new files (write-iff-absent left nothing). The clone authenticates with the run's
// resolved token so a PRIVATE template repo is reachable.
async function materializeTemplateSeedCommit(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  token: string | undefined,
): Promise<string> {
  const seed = input.context.templateSeed;
  if (seed === undefined) return "";
  const result = await materializeTemplateSeedInWorkspace({
    ssh: input.ssh,
    target,
    workspacePath,
    repoRef: seed.repoRef,
    token,
    timeoutMs: input.timeoutMs,
  });
  // Nothing newly seeded (fake SSH / empty tree / fully shadowed) ⇒ no commit.
  if (!result.seeded) return "";
  const committed = await runWorkspaceSshCommand(input.ssh, target, {
    label: "commit template seed",
    cwd: workspacePath,
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      // Stage everything the seed copied (-A) — the bootstrap commit already absorbed
      // install artifacts below the base, and `.git/info/exclude` keeps node_modules out.
      "git add -A",
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' " +
        `git commit -q -m ${quoteSshShellArg(`tanren: seed from template ${seed.repoRef}`)}`,
      // Echo the seed-commit sha LAST (the command's stdout). Fake SSH yields "".
      "git rev-parse HEAD",
    ].join(" && "),
  });
  return committed.stdout.trim();
}

// Materialize the deterministic contract files into the workspace + commit them as a
// dedicated commit above the bootstrap base, so they become part of the writer's PR
// diff. Returns the new contract-commit sha (the answerer review base anchors ABOVE it,
// so the Tanren-owned files are kept out of the writer's reviewed diff — apex v28 fix),
// or "" when no commit was made: the run carries no contract manifest (the project
// captured no lifecycle), a fake SSH yields no sha, OR the files were already present
// (a brownfield re-clone — write-iff-absent left nothing newly written). On a "" the
// caller keeps the bootstrap base, so the answerers diff from the same place as before.
async function materializeContractFilesCommit(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
): Promise<string> {
  const files = input.context.contractFiles;
  if (files === undefined || files.length === 0) return "";
  const result = await materializeContractFilesInWorkspace({
    ssh: input.ssh,
    target,
    files,
    workspacePath,
    timeoutMs: input.timeoutMs,
  });
  // Nothing newly written (every file already present) ⇒ no commit, no base shift.
  if (result.written.length === 0) return "";
  const committed = await runWorkspaceSshCommand(input.ssh, target, {
    label: "commit deterministic contract files",
    cwd: workspacePath,
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      // Stage ONLY the contract files (not -A) so this commit carries the contract
      // and nothing else — the bootstrap commit already absorbed install artifacts.
      `git add ${result.written.map((p) => quoteSshShellArg(p)).join(" ")}`,
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' " +
        `git commit -q -m ${quoteSshShellArg("tanren: project contract files (.tanren/ci.yml + justfile)")}`,
      // Echo the contract-commit sha LAST so it is the command's stdout — it becomes
      // the answerer review base. A fake SSH yields ""; the real runner a 40-hex sha.
      "git rev-parse HEAD",
    ].join(" && "),
  });
  return committed.stdout.trim();
}

// Clones the target branch and returns the clone HEAD. `git rev-parse HEAD` runs
// LAST in the chain and is the only stdout-producing step, so the returned
// stdout is the clone HEAD sha. Returns "" only on a fake SSH that yields no
// output; the real runner always returns a 40-hex sha.
//
// When a GitHub token is threaded (`resolved.token`) the clone authenticates over
// HTTPS as `x-access-token:<token>` so a PRIVATE target repo can be cloned. The
// token is fed to the command over SSH stdin via the shared git credential helper
// (the same mechanism `githubPush.ts` uses) — it never appears in the command
// string, the process args, or any emitted `workspace.*` event. Without a token
// the clone runs unauthenticated against the repo URL as-is (public-repo path),
// unchanged. The git AUTHOR is configured by a separate step (configureWorkspace
// GitIdentity) right after this clone, BEFORE the first commit.
//
// When this is a DEPENDENT speculative run (a non-empty ancestor stack), it routes to the
// jj-LOCAL base bootstrap (`bootstrapDependentWorkspace`, plannerRunJjLocalBootstrap.ts); a
// non-speculative run (empty stack) takes the plain `default_branch` single-ref clone below.
async function cloneWorkspace(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  resolved: ResolvedCloneCredential,
): Promise<ClonedWorkspace> {
  // walker-jj-local-integration-design.md §2.1: a DEPENDENT speculative run (a non-empty
  // ancestor stack) jj-ASSEMBLES its base LOCALLY from the real ancestor PR-head refs on the
  // run's OWN runner (`bootstrapDependentBase`) — there is NO orchestrator-synthesized
  // `tanren/integ/<dep>` host ref. A non-speculative run (empty stack) takes the plain
  // `default_branch` single-ref clone below.
  const stack = resolveAncestorStack({ ancestorStack: input.context.ancestorStack });
  if (stack.length > 0) {
    return bootstrapDependentWorkspace(input, target, workspacePath, resolved, stack);
  }
  const result = await runWorkspaceSshCommand(input.ssh, target, {
    label: "prepare planner-loop workspace",
    timeoutMs: input.timeoutMs,
    command: buildCloneCommand(input.context.repoUrl, input.context.targetBranch, resolved, workspacePath),
    ...(resolved.token === undefined ? {} : { stdin: resolved.token }),
  });
  return { cloneHeadSha: result.stdout.trim() };
}

// MERGE-SAFETY (self-identity): configure the workspace's repo-local git author so
// every commit it makes (the bootstrap commit + every writer/rebase commit, which
// inherit `.git/config`) is ATTRIBUTABLE. Runs as its OWN SSH step after the clone
// and before any commit — distinct from the clone command so the author is set even
// if the clone path changes, and so a failure to set it surfaces on its own label.
//
// AUTHENTICATED runs set the RESOLVED bot login + its canonical
// `<id>+<login>@users.noreply.github.com` noreply email, so GitHub maps the commit
// email back to the bot login, the PR-commits author is populated, and the
// external-change gate sees TANREN's login (not `<unknown>`). A run with an
// unresolvable identity already threw in resolveCloneCredential (fail-closed) — it
// never reaches here. The genuinely UNAUTHENTICATED public-repo clone (no identity)
// keeps a non-attributable placeholder: it never pushes as Tanren, but git still
// refuses to commit without SOME configured author, so the bootstrap commit needs one.
export async function configureWorkspaceGitIdentity(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  identity: ActorIdentity | undefined,
): Promise<void> {
  await runWorkspaceSshCommand(input.ssh, target, {
    label: "configure workspace git identity",
    cwd: workspacePath,
    timeoutMs: input.timeoutMs,
    command: ["set -eu", ...gitIdentityConfig(identity)].join(" && "),
  });
}

/**
 * The resolved clone credential: the push token (fed to the clone over stdin) +
 * MERGE-SAFETY the resolved actor identity Tanren commits as. Both derive from the
 * SAME `resolveToken`, so the runner's git author (here) and the merge stage's
 * Tanren-identity set (mergeDispatch) attribute to the SAME login. A genuinely
 * unauthenticated public-repo clone has neither (it never pushes as Tanren).
 */
export interface ResolvedCloneCredential {
  token: string | undefined;
  identity: ActorIdentity | undefined;
}

// Resolves the run's GitHub token for the clone through the SAME standalone
// credential resolver the rest of the run path uses (`resolveVcsToken`), so the
// clone is APP-FIRST: a caller-injected `githubToken` (test seam) wins; otherwise the
// resolver mints an auto-rotating App installation token when the org installed
// the App (`context.installation`), else reads the static `github_token` at the
// run's resolved credential ref. This is a deliberate behavior change from the
// prior static-ref-only clone — clone now prefers the App token when an App is
// present, matching the CI-poll / merge stages (no more asymmetry).
//
// MERGE-SAFETY (self-identity): from the SAME resolved credential we ALSO resolve
// Tanren's pushing identity (`resolveActorIdentity`) and set it as the runner's
// git author below — so Tanren's own commits attribute to a REAL GitHub login
// (not the old `.invalid` email that GitHub reports as a `null` author, which the
// external-change gate keys `<unknown>` → external → blocked). The merge stage
// derives its Tanren-identity set from the same credential, so they agree.
//
// When NEITHER an App nor a static credential ref is configured the clone must
// still run for the public-repo path, so we return undefined token + identity
// (unauthenticated clone) instead of throwing; that path does not push as Tanren.
// A missing secret at a CONFIGURED ref still propagates so a misconfigured private
// run fails loudly. LOUD-FAILURE: when the run IS authenticated, identity
// resolution failing is a hard throw — never a silent `.invalid` fallback.
async function resolveCloneCredential(input: RunPlannerLoopInput): Promise<ResolvedCloneCredential> {
  // Test seam: a pre-resolved raw clone token bypasses the provider's credential
  // resolution entirely (it is not a resolvable App/static credential), so there is
  // no genuine identity to resolve — keep the non-attributable placeholder. Production
  // omits `githubToken` and takes the real resolution path below.
  if (input.githubToken !== undefined) {
    return { token: input.githubToken, identity: undefined };
  }
  const staticRef = input.context.githubCredentialRef;
  // No App installation AND no static ref → unauthenticated public-repo clone: no
  // token, no Tanren identity (it never pushes as Tanren).
  if (input.context.installation === undefined && staticRef.trim() === "") {
    return { token: undefined, identity: undefined };
  }
  // §5a: token + identity resolution is credential PLUMBING — resolve via the standalone
  // helpers over the shared GitHub client, never a forge op on a host seam.
  const http = input.githubHttp;
  const resolved = await resolveVcsToken(http, {
    secrets: input.secrets,
    ...(input.context.installation !== undefined && { installation: input.context.installation }),
    ...(staticRef.trim() !== "" && { staticRef }),
    ...(input.githubAppMinter !== undefined && { minter: input.githubAppMinter }),
  });
  // LOUD FAILURE: an authenticated run MUST resolve a real pushing identity so its
  // commits are attributable — a throw here, never a degrade to `planner@tanren.invalid`.
  const identity = await resolveVcsActorIdentity(resolved);
  return { token: resolved.token, identity };
}

function buildCloneCommand(
  repoUrl: string,
  targetBranch: string,
  resolved: ResolvedCloneCredential,
  workspacePath: string,
): string {
  const branch = quoteSshShellArg(targetBranch);
  const dest = quoteSshShellArg(workspacePath);
  // The git AUTHOR is configured by configureWorkspaceGitIdentity (its own step)
  // right after this clone — NOT in the clone command's tail. So the clone only
  // verifies the checkout (`git rev-parse HEAD`) and the author is set separately,
  // guaranteed before the first commit and failing on its own label if it can't.
  const post = [`cd ${dest}`, "git rev-parse HEAD"];
  const token = resolved.token;

  // No token → plain unauthenticated clone of the repo URL as configured.
  if (token === undefined) {
    return [
      "set -eu",
      `rm -rf ${dest}`,
      `git clone --depth 1 --branch ${branch} ${quoteSshShellArg(repoUrl)} ${dest}`,
      ...post,
    ].join(" && ");
  }

  // Token present → authenticate over HTTPS via the stdin-fed credential helper
  // (token never on the command line). Normalize the repo URL to the HTTPS
  // remote the helper authenticates against.
  const remote = quoteSshShellArg(githubHttpsRemote(parseGitHubRepository(repoUrl)));
  return [
    "set -eu",
    ...gitTokenAuthPrelude(),
    `rm -rf ${dest}`,
    gitAuthedCommand(["clone", "--depth", "1", "--branch", branch, remote, dest]),
    ...post,
  ].join(" && ");
}

/**
 * MERGE-SAFETY (self-identity): the `git config user.name/user.email` lines for
 * the run's commits. AUTHENTICATED runs set the RESOLVED login + its canonical
 * `<id>+<login>@users.noreply.github.com` noreply email, so every writer/rebase
 * commit (which inherits this config) is ATTRIBUTABLE — GitHub maps the email back
 * to the login, the PR-commits author is populated, and the external-change gate
 * sees Tanren's login (not `<unknown>`). The genuinely UNAUTHENTICATED public-repo
 * clone (no identity) keeps a non-attributable placeholder — it never pushes as
 * Tanren, so attribution is moot, but git still needs a configured author.
 */
function gitIdentityConfig(identity: ActorIdentity | undefined): string[] {
  if (identity === undefined) {
    return ["git config user.name 'Tanren Planner'", "git config user.email 'planner@tanren.invalid'"];
  }
  return [
    `git config user.name ${quoteSshShellArg(identity.login)}`,
    `git config user.email ${quoteSshShellArg(identity.noreplyEmail)}`,
  ];
}
