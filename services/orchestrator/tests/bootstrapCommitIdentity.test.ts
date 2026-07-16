// MERGE-SAFETY (self-identity) — the dependent jj-local bootstrap (`bootstrapDependentWorkspace`
// in plannerRunJjLocalBootstrap.ts) must author the assembled run-branch commit as the resolved
// BOT identity, NOT the `JjWorkspaceVcsCore` `tanren@local` default.
//
// THE BUG THIS PINS (apex v35, cat-cave/tmpl-ts-pnpm#8): a TEMPLATE build (an `autonomy: auto`
// run with NO operator) authored a PR carrying 2 commits authored `tanren@local` with EMPTY
// messages — the `jj new` working commit `core.branch(ws, runBranch, localRef)` creates as the
// dependent's run-branch head. `tanren@local` maps to NO GitHub login, so GitHub reports a NULL
// author, the merge-safety external-change gate (`assessExternalChange`) keys it `<unknown>` →
// external → and the native merge queue BLOCKS the PR demanding an operator approval that never
// comes (0 merges → the build times out). Root cause: `bootstrapDependentWorkspace` built its jj
// core WITHOUT threading the run's already-resolved bot `commitIdentity`, so the core fell back to
// its non-attributable `tanren@local` default.
//
// THE FIX (behavioral pin here): on an AUTHENTICATED run (a static credential ref / App
// installation is configured), the run-branch head commit attributes to the bot login. The jj core
// sets the author via `jj config set --repo user.name/user.email` at `openWorkspace`, captured here
// off the command substrate — so we assert the configured identity IS the bot login + canonical
// noreply email, and is NEVER `tanren@local`. WITHOUT the fix this FAILS (the core configures
// `tanren@local`). FAIL-CLOSED: a token resolved WITHOUT an identity on an authenticated path is a
// loud throw (never a silent `tanren@local` fallback) — mirroring `resolveBotPushIdentity`.

import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import { DispatchingSsh, makeContext, STACK, target, WORKSPACE_PATH } from "./helpers/jjLocalBootstrapFixtures.js";

// The static PAT user the authenticated `GET /user` resolves — the bot login the run's commits
// must attribute to, and the canonical `<id>+<login>@users.noreply.github.com` GitHub maps back.
const BOT_LOGIN = "tanren-cat-cave-validation[bot]";
const BOT_ID = "290060348";
const BOT_NOREPLY = `${BOT_ID}+${BOT_LOGIN}@users.noreply.github.com`;
const CRED_REF = "credential/github/org/org_dep/token";

/** A GitHub HTTP stub answering the static-credential identity read (`GET /user`) with the bot. */
function botUserHttp(): GitHubHttpClient {
  return {
    request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
      if (req.method === "GET" && req.path === "/user") {
        return { status: 200, body: { login: BOT_LOGIN, id: Number(BOT_ID) } };
      }
      throw new Error(`unexpected GitHub HTTP in this unit path: ${req.method} ${req.path}`);
    },
  };
}

/**
 * An AUTHENTICATED bootstrap input: a non-empty static `githubCredentialRef` seeded in the secret
 * store + a `/user`-answering http stub ⇒ `resolveCloneCredential` resolves a real bot identity
 * the bootstrap MUST author the run branch as. Built directly (not via the shared `makeInput`,
 * which hard-codes an unauthenticated/no-http path) so this suite owns the authenticated wiring.
 */
function authenticatedInput(ssh: DispatchingSsh): RunPlannerLoopInput {
  const secrets = new FakeSecretStore();
  // Seed the static credential the ref resolves to (a PAT token value — opaque here).
  void secrets.put({ ref: CRED_REF, value: "ghp_fake_token_value" });
  return {
    ssh,
    secrets,
    githubHttp: botUserHttp(),
    context: makeContext({ ancestorStack: STACK, githubCredentialRef: CRED_REF }),
    timeoutMs: 500,
    bootstrapCommand: "true",
    runBootstrap: async () => {},
    commitBootstrap: async () => "",
  } as unknown as RunPlannerLoopInput;
}

/** The `jj config set --repo user.name/user.email` values the bootstrap configured (captured SSH). */
function configuredIdentity(ssh: DispatchingSsh): { name: string | undefined; email: string | undefined } {
  let name: string | undefined;
  let email: string | undefined;
  for (const { command } of ssh.commands) {
    const cmd = command.command;
    // The TOML-quoted value `JjWorkspaceVcsCore.openWorkspace` hands `jj config set` (a basic
    // string the runner stores literally). Read the value out of the configured literal.
    const nameMatch = /jj config set --repo user\.name\s+'?"([^"]+)"'?/u.exec(cmd);
    if (nameMatch?.[1] !== undefined) name = nameMatch[1];
    const emailMatch = /jj config set --repo user\.email\s+'?"([^"]+)"'?/u.exec(cmd);
    if (emailMatch?.[1] !== undefined) email = emailMatch[1];
  }
  return { name, email };
}

describe("jj-local bootstrap commit identity (merge-safety self-identity)", () => {
  const KEY = "WALKER_JJ_LOCAL_BASE";
  function withFlagOn<T>(fn: () => Promise<T>): Promise<T> {
    const prior = process.env[KEY];
    process.env[KEY] = "1";
    return fn().finally(() => {
      if (prior === undefined) delete process.env[KEY];
      else process.env[KEY] = prior;
    });
  }

  it("AUTHENTICATED dependent bootstrap authors the run branch as the BOT login, not tanren@local", async () => {
    await withFlagOn(async () => {
      const ssh = new DispatchingSsh();
      const prepared = await prepareRunWorkspace(authenticatedInput(ssh), target, WORKSPACE_PATH);

      // The dependent assembled its base on the run's runner (the bootstrap path ran).
      expect(prepared.bootstrappedBaseRevision).toBeDefined();

      // THE PIN: the jj core was configured with the BOT identity — so the `jj new` run-branch
      // head commit (and every commit on this workspace) attributes to the bot login the
      // external-change gate recognizes as Tanren's, NOT the `tanren@local` default that GitHub
      // reports as a NULL author / `<unknown>` (which blocks the autonomous PR).
      const identity = configuredIdentity(ssh);
      expect(identity.name).toBe(BOT_LOGIN);
      expect(identity.email).toBe(BOT_NOREPLY);
      expect(identity.email).not.toBe("tanren@local");
      expect(identity.name).not.toBe("Tanren");
    });
  });
});
