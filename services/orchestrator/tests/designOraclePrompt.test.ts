// Native design subsystem (WS-D4) — the design-oracle PROMPT builder. Asserts the
// MOAT content the oracle prompt must carry: the exhaustive behavior-coverage
// checklist (every behavior, with its given/when/then + its persona), the
// persona-scoped fidelity framing (resolved personas, dimension persona-scopes), and
// the DOMAIN-AWARE verification posture (the agent chooses the mode from the domain —
// proven across ≥2 domains, web + a non-web domain, so nothing is web-baked).
//
// "then" below is the BDD Given/When/Then behavior vocabulary, not a thenable —
// the awaitable-object lint does not apply to these fixtures.
/* eslint-disable unicorn/no-thenable */
import { describe, expect, it } from "vitest";

import { buildDesignOraclePrompt } from "../src/engine/workflow/designOracle/designOraclePrompt.js";

const baselineSha = "a".repeat(40);

describe("buildDesignOraclePrompt — the moat content", () => {
  it("renders the role framing, domain-aware mode, and read-only self-inspection (never injects a diff)", () => {
    const prompt = buildDesignOraclePrompt({
      domain: "saas-web",
      identity: "calm dense trustworthy ops console",
      intent: "an ops console that feels effortless under load",
      principles: ["no AI-slop gradients"],
      constraints: ["WCAG AA"],
      dimensions: [],
      personas: [],
      behaviors: [],
      baselineSha,
    });
    expect(prompt).toContain("You are the Tanren Design Oracle.");
    // Domain-aware: it must name the domain and tell the agent to CHOOSE the mode.
    expect(prompt).toContain("The design domain is: saas-web");
    expect(prompt).toContain("you are NOT assuming a web UI");
    expect(prompt).toContain("report it in `verificationMode`");
    // Self-inspection — the agent diffs the built output itself, no diff injected.
    expect(prompt).toContain(`git diff ${baselineSha} -- . ':(exclude)node_modules'`);
    expect(prompt).not.toContain("diff --git");
    // Read-only + no-verdict boundaries.
    expect(prompt).toContain("READ-ONLY sandbox");
    expect(prompt).toContain("Render NO pass/fail verdict");
    // The contract bar is rendered.
    expect(prompt).toContain("Design identity: calm dense trustworthy ops console");
    expect(prompt).toContain("- no AI-slop gradients");
    expect(prompt).toContain("- WCAG AA");
  });

  it("builds an EXHAUSTIVE behavior-coverage checklist — every behavior, its given/when/then + persona", () => {
    const prompt = buildDesignOraclePrompt({
      domain: "saas-web",
      identity: "console",
      intent: "effortless",
      principles: [],
      constraints: [],
      dimensions: [],
      personas: [
        { id: "persona_admin", name: "Admin", description: "runs the org" },
        { id: "persona_viewer", name: "Viewer", description: "read-only" },
      ],
      behaviors: [
        {
          id: "behavior_invite",
          personaId: "persona_admin",
          title: "Invite a teammate",
          given: "an admin on the members page",
          when: "they submit an email",
          then: "an invite is sent and shown pending",
        },
        {
          id: "behavior_view",
          personaId: "persona_viewer",
          title: "View the dashboard",
          given: "a viewer signed in",
          when: "they open the dashboard",
          then: "they see read-only metrics",
        },
      ],
      baselineSha,
    });
    // The checklist header + the coverage-gap rule (a behavior with no surface = finding).
    expect(prompt).toContain("BEHAVIOR-COVERAGE CHECKLIST");
    expect(prompt).toContain("every behavior MUST have a designed surface/flow");
    expect(prompt).toContain("A behavior with NO");
    // EVERY behavior is listed with its given/when/then AND its persona (the moat:
    // coverage is attributed per resolved persona, not guessed).
    expect(prompt).toContain("[behavior_invite] (persona persona_admin) Invite a teammate");
    expect(prompt).toContain("Given an admin on the members page");
    expect(prompt).toContain("When they submit an email");
    expect(prompt).toContain("Then an invite is sent and shown pending");
    expect(prompt).toContain("[behavior_view] (persona persona_viewer) View the dashboard");
    // Resolved personas are rendered (no "assume default admin").
    expect(prompt).toContain("[persona_admin] Admin: runs the org");
    expect(prompt).toContain("[persona_viewer] Viewer: read-only");
    // Persona-scoped fidelity rule.
    expect(prompt).toContain("PERSONA-SCOPED FIDELITY");
  });

  it("renders persona-scoped dimensions vs all-persona dimensions distinctly", () => {
    const prompt = buildDesignOraclePrompt({
      domain: "saas-web",
      identity: "console",
      intent: "effortless",
      principles: [],
      constraints: [],
      dimensions: [
        { key: "tokens", label: "Design tokens", intent: "restrained palette", guidance: "", personaRefs: [] },
        {
          key: "admin-density",
          label: "Admin density",
          intent: "dense tables for power users",
          guidance: "prefer compact rows",
          personaRefs: ["persona_admin"],
        },
      ],
      personas: [{ id: "persona_admin", name: "Admin", description: "runs the org" }],
      behaviors: [],
      baselineSha,
    });
    // An unscoped dimension applies to all personas; a scoped one names its persona.
    expect(prompt).toContain("[tokens] Design tokens (scope: all personas on the contract)");
    expect(prompt).toContain("Intent: restrained palette");
    expect(prompt).toContain("[admin-density] Admin density (scope: personas persona_admin)");
    expect(prompt).toContain("Guidance: prefer compact rows");
  });

  // DOMAIN-GENERAL across ≥2 domains: the SAME builder renders a non-web (novel
  // translation) contract just as faithfully — proving nothing is web-baked.
  it("is domain-general — renders a non-web (novel-translation) contract the same way", () => {
    const prompt = buildDesignOraclePrompt({
      domain: "novel-translation",
      identity: "austere literary classic",
      intent: "preserve the source register and the translator's voice",
      principles: ["keep the translator's voice consistent"],
      constraints: ["match the source work's typographic register"],
      dimensions: [
        { key: "typography", label: "Typography", intent: "a classic serif measure", guidance: "", personaRefs: [] },
        { key: "voice", label: "Voice", intent: "consistent translated register", guidance: "", personaRefs: [] },
      ],
      personas: [
        { id: "persona_reader", name: "Reader", description: "reads the finished translation" },
        { id: "persona_editor", name: "Editor", description: "reviews fidelity to the source" },
      ],
      behaviors: [
        {
          id: "behavior_chapter",
          personaId: "persona_reader",
          title: "Read a chapter",
          given: "a reader opens chapter 1",
          when: "they read a translated passage",
          then: "the voice matches the source register",
        },
      ],
      baselineSha,
    });
    expect(prompt).toContain("The design domain is: novel-translation");
    // Domain-aware guidance names the non-web verification modes explicitly.
    expect(prompt).toContain("a novel translation by its prose and");
    expect(prompt).toContain("[typography] Typography");
    expect(prompt).toContain("[voice] Voice");
    // The behavior-coverage checklist works identically for a non-web domain.
    expect(prompt).toContain("[behavior_chapter] (persona persona_reader) Read a chapter");
    expect(prompt).toContain("[persona_editor] Editor: reviews fidelity to the source");
    // No web vocabulary is hardcoded as the ONLY mode — the builder offers the domain a choice.
    expect(prompt).toContain("Decide the verification mode that");
  });

  it("renders an explicit empty state when no behaviors are bound (no invented obligation)", () => {
    const prompt = buildDesignOraclePrompt({
      domain: "saas-web",
      identity: "console",
      intent: "effortless",
      principles: [],
      constraints: [],
      dimensions: [],
      personas: [],
      behaviors: [],
      baselineSha,
    });
    expect(prompt).toContain("no behaviors bound — there is no coverage obligation; do not invent one");
    expect(prompt).toContain("Design principles: (none)");
    expect(prompt).toContain("(no personas bound)");
    expect(prompt).toContain("(no dimensions declared)");
  });
});
