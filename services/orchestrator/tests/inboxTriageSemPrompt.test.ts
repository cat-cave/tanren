// Prompt-content test for the issue-triage ENTITY-IDENTITY accelerator block
// (docs/roadmap/entity-analysis-layer.md §2.3). The triage agent uses `sem`'s
// structural-hash entity identity to decide whether an issue's target entity still
// exists / was modified / renamed / removed since the issue was filed — so a stale
// issue about a since-refactored function is correctly resolved rather than re-routed.
// `sem` is an OPTIONAL accelerator: the block MUST name the raw git/grep fallback so it
// can never be silently dropped, and must never instruct the agent to block on `sem`.
import { describe, expect, it } from "vitest";
import { buildTriagePrompt } from "../src/engine/forge/inbox/index.js";
import type { InboxSource, TriageAnswererContext } from "../src/engine/forge/inbox/index.js";

const source: InboxSource = {
  id: "s",
  orgId: "o",
  projectId: "p",
  kind: "issues",
  name: "gh",
  detail: "",
  config: {},
  enabled: true,
  autoRoute: false,
};

const ctx: TriageAnswererContext = {
  candidate: { title: "t", body: "b", severity: "info", sourceKind: "issues", projectId: "p" },
  source,
  existingSpecs: [],
};

describe("issue-triage prompt — sem entity-identity staleness check", () => {
  const prompt = buildTriagePrompt(ctx);

  it("instructs the agent to use sem entity identity to judge whether the target still exists", () => {
    expect(prompt).toContain("ENTITY-IDENTITY check");
    expect(prompt).toContain("STILL");
    expect(prompt).toContain("RENAMED");
    expect(prompt).toContain("sem blame <file>");
    expect(prompt).toContain("sem log <entity>");
    expect(prompt).toContain("sem diff --from <sha> --to HEAD --format json");
  });

  it("keeps sem optional with an authoritative raw git/grep fallback", () => {
    expect(prompt).toContain("optional accelerator");
    expect(prompt).toContain("cannot parse the stack");
    expect(prompt).toContain("fall back to a raw");
    expect(prompt).toContain("`git log`/grep search");
    expect(prompt).toContain("Never block or change your verdict merely because `sem` is unavailable.");
  });
});
