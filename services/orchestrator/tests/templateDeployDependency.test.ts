// The template-build deploy dependency must provision against the operator's EXPLICIT,
// already-linked derive provider — never one re-guessed from the lifecycle string that
// defaults to an unlinked `deploy.flyio`.
//
// The apex-v33 halt this proves: an operator drove a greenfield derive that named
// `deploy.vercel` (preflighted, guaranteed linked). On no matching template the
// just-in-time template-creation path built a throwaway template-build project that ITSELF
// requires a deploy dependency — and it re-guessed the provider from the `ts/pnpm`
// lifecycle string, which carried no "vercel" token, so it fell through to `deploy.flyio`
// (the org had NOT linked flyio). Template creation failed with "link deploy.flyio at the
// org level first…" → the derive halted with `TemplateRequiredError` → 409
// `template_required`, blocking the whole run. The fix threads the operator's explicit
// `deploy.providerKind` all the way into `deployDependencyFor`, where it is authoritative.

import { describe, expect, it } from "vitest";
import { deployDependencyFor } from "../src/routes/templates/createFlow.js";

const base = { stack: "ts-pnpm", runtime: "node", packageManager: "pnpm" } as const;

describe("deployDependencyFor — honors the operator's explicit linked deploy provider", () => {
  it("an explicit deployProviderKind is AUTHORITATIVE (vercel derive → deploy.vercel, not the flyio default)", () => {
    // The exact apex regression: ts/pnpm, deployTarget has no "vercel" token, but the operator
    // named deploy.vercel on the derive — the build must follow the explicit, linked choice.
    expect(
      deployDependencyFor({ ...base, deployTarget: "pnpm", deployProviderKind: "deploy.vercel" }).providerKind,
    ).toBe("deploy.vercel");
  });

  it("an explicit deployProviderKind is NOT shadowed by a conflicting deployTarget heuristic", () => {
    // Even when the (fragile) target string would heuristically map to "vercel", an explicit
    // deploy.flyio wins — the explicit, linked provider is always authoritative.
    expect(
      deployDependencyFor({ ...base, deployTarget: "vercel", deployProviderKind: "deploy.flyio" }).providerKind,
    ).toBe("deploy.flyio");
  });

  it("WITHOUT an explicit providerKind, the standalone create route still maps deployTarget (heuristic fallback)", () => {
    // The operator create-template route may pass a free-form deployTarget with no explicit
    // providerKind — the heuristic remains a sensible fallback there, never silently flyio when
    // the target clearly says vercel.
    expect(
      deployDependencyFor({ stack: "ts-next", runtime: "node", packageManager: "pnpm", deployTarget: "vercel" })
        .providerKind,
    ).toBe("deploy.vercel");
    expect(
      deployDependencyFor({ stack: "rust-axum", runtime: "cargo", packageManager: "cargo", deployTarget: "fly" })
        .providerKind,
    ).toBe("deploy.flyio");
  });

  it("the dependency name is stable + length-bounded (the template-build project deploy name)", () => {
    const dep = deployDependencyFor({ ...base, deployProviderKind: "deploy.vercel" });
    expect(dep.name).toBe("tmpl-ts-pnpm");
    expect(dep.name.length).toBeLessThanOrEqual(80);
  });
});
