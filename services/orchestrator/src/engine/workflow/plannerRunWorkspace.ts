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
import type { ActorIdentity } from "../contracts/vcsProvider.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import {
  bootstrapWorkspace,
  commitBootstrapState,
  runWorkspaceSshCommand,
  seedWorkspaceLocalIgnore,
} from "../workspace/index.js";
import { gitAuthedCommand, gitTokenAuthPrelude } from "../workspace/githubPush.js";
import { resolveBootstrapCommand } from "./gate/index.js";
import type { BootstrapStepInput, CommitBootstrapStepInput, RunPlannerLoopInput } from "./plannerRun.js";

export interface PreparedRunWorkspace {
  // The clone HEAD (base-branch tip). The writer commits replay onto this before
  // the PR is pushed, so the PR carries only the writer's source changes.
  cloneHeadSha: string;
  // The synthetic post-bootstrap commit (or "" on a fake SSH). The PR-branch
  // cleanup drops this commit.
  bootstrapSha: string;
  // The writer's diff base: the bootstrap commit, or the clone HEAD when the
  // bootstrap step yielded no sha (fake SSH unit paths).
  baseSha: string;
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
  const cloneHeadSha = await cloneWorkspace(input, target, workspacePath, resolved);

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
  // otherwise resolve the repo's .tanren/ci.yml `bootstrap.run`; when
  // the repo ships no .tanren/ci.yml the resolver yields undefined and the
  // bootstrap step falls back to its pnpm/npm-detecting DEFAULT_BOOTSTRAP_COMMAND.
  const resolvedBootstrapCommand =
    input.bootstrapCommand ??
    (await resolveBootstrapCommand({ ssh: input.ssh, target, workspacePath, timeoutMs: input.timeoutMs }));
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
  const baseSha = bootstrapSha === "" ? cloneHeadSha : bootstrapSha;

  return { cloneHeadSha, bootstrapSha, baseSha };
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
async function cloneWorkspace(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  resolved: ResolvedCloneCredential,
): Promise<string> {
  const result = await runWorkspaceSshCommand(input.ssh, target, {
    label: "prepare planner-loop workspace",
    timeoutMs: input.timeoutMs,
    command: buildCloneCommand(input.context.repoUrl, input.context.targetBranch, resolved, workspacePath),
    ...(resolved.token === undefined ? {} : { stdin: resolved.token }),
  });
  return result.stdout.trim();
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
interface ResolvedCloneCredential {
  token: string | undefined;
  identity: ActorIdentity | undefined;
}

// Resolves the run's GitHub token for the clone through the SAME VcsProvider
// seam the rest of the run path uses (`resolveToken`), so the clone is
// APP-FIRST: a caller-injected `githubToken` (test seam) wins; otherwise the
// provider mints an auto-rotating App installation token when the org installed
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
  const resolved = await input.vcsProvider.resolveToken({
    secrets: input.secrets,
    ...(input.context.installation !== undefined && { installation: input.context.installation }),
    ...(staticRef.trim() !== "" && { staticRef }),
    ...(input.githubAppMinter !== undefined && { minter: input.githubAppMinter }),
  });
  // LOUD FAILURE: an authenticated run MUST resolve a real pushing identity so its
  // commits are attributable — a throw here, never a degrade to `planner@tanren.invalid`.
  const identity = await input.vcsProvider.resolveActorIdentity(resolved);
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
