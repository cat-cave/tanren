// TEMPLATE-SEED materialization in the workspace (templating-system.md §3).
//
// When a validated template was SELECTED at derive (`projectConfig.templateRef`),
// the run path SEEDS the greenfield repo from the template's conforming files BEFORE
// the writer runs — so the scaffold writer's "the seed is ALREADY COMMITTED"
// assertion (scaffoldAuthoring.buildSeedScaffoldDescription) is actually TRUE: the
// template's `.tanren/ci.yml` + `justfile` contract and its working skeleton land as
// the scaffold base, and the writer SPECIALIZES the seed instead of authoring from
// scratch. Without this step the seed assertion was a lie (only the 2 deterministic
// contract files landed), so the writer had to invent the whole project anyway.
//
// MECHANISM: clone the template repo (depth-1, the validated head) into a temp dir on
// the runner, then copy its tracked tree (everything except `.git`) into the
// workspace WRITE-IFF-ABSENT — so an auto-init `README` or anything already present
// is never clobbered, but the template's files (the vast majority on a fresh repo)
// land. The clone authenticates with the run's resolved token (so a PRIVATE template
// repo is reachable) exactly like the workspace clone — token over stdin via the
// shared askpass helper, never on the command line. Returns whether any file was
// seeded (false on a fake SSH or an empty/already-present tree) so the caller decides
// whether to make a seed commit.
//
// STACK-AGNOSTIC: nothing here knows the template's stack — it copies the validated
// tree verbatim. A ts/pnpm, rust/cargo, or novel/pandoc template seeds identically.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { gitAuthedCommand, gitTokenAuthPrelude } from "./githubPush.js";
import { runWorkspaceSshCommand } from "./ssh.js";

export interface MaterializeTemplateSeedInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  // The template repo to seed from (owner/repo or a clone url). Normalized to the
  // HTTPS remote the token authenticates against.
  repoRef: string;
  // The run's resolved GitHub token (App-first or static). Required to clone a PRIVATE
  // template repo. Absent ⇒ an unauthenticated clone of a public template repo.
  token: string | undefined;
  timeoutMs: number;
}

export interface MaterializeTemplateSeedResult {
  // Whether any seed file was written into the workspace (false on a fake SSH, an
  // empty template tree, or a tree fully shadowed by already-present files).
  seeded: boolean;
}

// A bare `owner/repo` template ref (no scheme, exactly one `/`, no whitespace) — the
// shape the registry stores. A full clone URL goes through `parseGitHubRepository`.
const BARE_OWNER_REPO = /^[^/\s:]+\/[^/\s:]+$/u;

// Resolve the HTTPS clone remote for a template `repoRef`. A bare `owner/repo` is
// expanded to the GitHub HTTPS remote; a full clone url is parsed + normalized so the
// askpass token auth applies uniformly.
function seedRemote(repoRef: string): string {
  if (BARE_OWNER_REPO.test(repoRef)) {
    const [owner, name] = repoRef.split("/");
    return githubHttpsRemote({ owner: owner ?? "", name: (name ?? "").replace(/\.git$/u, "") });
  }
  return githubHttpsRemote(parseGitHubRepository(repoRef));
}

// Materialize the template seed into the workspace over SSH. Clones the template repo
// into a temp dir, copies its tree (sans `.git`) into the workspace write-iff-absent,
// and echoes a sentinel reporting whether anything was seeded. The whole sequence is
// ONE SSH round-trip (the token, when present, is fed over stdin to the askpass
// helper). Fails LOUD (non-zero exit propagates) if the clone fails — a selected seed
// that cannot be cloned must not silently degrade to from-scratch mid-run.
export async function materializeTemplateSeedInWorkspace(
  input: MaterializeTemplateSeedInput,
): Promise<MaterializeTemplateSeedResult> {
  const remote = quoteSshShellArg(seedRemote(input.repoRef));
  const dest = quoteSshShellArg(input.workspacePath);
  const seededMarker = "tanren: template seed materialized";
  const emptyMarker = "tanren: template seed produced no new files";

  // The copy core: for each path in the cloned template tree (excluding .git), copy
  // it into the workspace ONLY when the destination path is absent (write-iff-absent,
  // never clobber an auto-init file). Track whether anything was written.
  const copyTree = [
    'seed_dir="$tmpdir/seed"',
    // Walk the template tree (relative paths), copying each file iff its destination
    // is absent. `find -type f` over the seed dir; strip the seed-dir prefix; mkdir
    // the dest parent; copy iff absent.
    'wrote=0',
    'cd "$seed_dir"',
    // Use a NUL-delimited find so paths with spaces are safe.
    'while IFS= read -r -d "" rel; do',
    '  rel="${rel#./}"',
    `  destpath=${dest}"/$rel"`,
    '  if [ ! -e "$destpath" ]; then',
    '    mkdir -p "$(dirname "$destpath")"',
    '    cp -p "$seed_dir/$rel" "$destpath"',
    '    wrote=1',
    '  fi',
    'done < <(find . -type f -not -path "./.git/*" -print0)',
    `if [ "$wrote" = "1" ]; then echo ${quoteSshShellArg(seededMarker)}; else echo ${quoteSshShellArg(emptyMarker)}; fi`,
  ];

  const cloneSeed =
    input.token === undefined
      ? [`git clone --depth 1 ${remote} "$tmpdir/seed"`]
      : [...gitTokenAuthPrelude(), gitAuthedCommand(["clone", "--depth", "1", remote, '"$tmpdir/seed"'])];

  // When a token is present, gitTokenAuthPrelude already created `$tmpdir`; otherwise
  // we make one here. Build the command so `$tmpdir` exists either way.
  const setupTmp =
    input.token === undefined
      ? ['tmpdir=$(mktemp -d)', 'cleanup() { rm -rf "$tmpdir"; }', 'trap cleanup EXIT']
      : [];

  const command = [
    "set -eu",
    // bash for `read -d "" ` + process substitution `< <(...)`.
    ...setupTmp,
    ...cloneSeed,
    ...copyTree,
  ].join("\n");

  const result = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "materialize template seed",
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    command: `bash -c ${quoteSshShellArg(command)}`,
    ...(input.token === undefined ? {} : { stdin: input.token }),
  });
  return { seeded: result.stdout.includes(seededMarker) };
}
