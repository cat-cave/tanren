## (1) IDEAL DESIGN + how it fits the engine + the owned-stack advantages it exploits

Build a `DesignSystemEngine`: an executable compiler, package registry, curation DAG, and render-proof system—not a larger design prompt.

Today Tanren has strong intent lineage but no executable design system:

- `DesignContractV1` is strict and durable, but each dimension is prose: `intent`, `guidance`, and references. It cannot carry typed tokens, modes, component source, render entrypoints, or artifacts ([designContract.ts:75](/home/trevor/projects/tanren/services/orchestrator/src/engine/design/designContract.ts:75), [designContract.ts:115](/home/trevor/projects/tanren/services/orchestrator/src/engine/design/designContract.ts:115)).
- The design phase explicitly authors “the CONTRACT only,” not UI or assets ([designPhase.ts:20](/home/trevor/projects/tanren/services/orchestrator/src/engine/design/designPhase.ts:20)).
- Writers receive that contract as rendered prose ([designWriterContext.ts:167](/home/trevor/projects/tanren/services/orchestrator/src/engine/design/designWriterContext.ts:167)).
- The oracle explicitly cannot start a server or inspect rendered pixels ([designOraclePrompt.ts:194](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/designOracle/designOraclePrompt.ts:194)); the roadmap calls live rendering an unbuilt `WS-D4a` capability ([native-design-subsystem.md:342](/home/trevor/projects/tanren/docs/roadmap/native-design-subsystem.md:342)).

The ideal system has three deliberately separate layers:

1. **Intent:** `DesignContractV2`, migrated losslessly from V1, continues to capture identity, principles, constraints, personas, behaviors, desired surfaces, platform capabilities, accessibility posture, and acceptance intent. It never embeds generated source.

2. **Reusable source:** an immutable, org-owned `DesignSystemReleaseV1` contains canonical DTCG tokens, resolver contexts, component contracts, assets, fragment selections, licenses, and provenance.

3. **Framework projection:** a content-addressed `FrameworkDesignArtifactV1` contains real source, assets, catalog entrypoints, fixtures, exports, and validation evidence for one target profile.

### The fragment compiler

Mirror the existing template engine’s strongest doctrine: one composer, mandatory base fragment, typed phases, open-world selection, F2 authoring for gaps, and no silent fallback. That doctrine already exists for templates ([fragment README:3](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/README.md:3), [fragment README:43](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/README.md:43), [fragment README:120](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/README.md:120)).

Every design composition begins with an immutable `base/plain` fragment containing:

- Valid DTCG primitive, semantic, and component token groups.
- Light, dark, high-contrast, reduced-motion, and density contexts.
- Intentionally plain typography, spacing, color, motion, and icon defaults.
- Headless component contracts for core interaction roles.
- Minimal fixtures proving that the base renders before curation.
- A target bootstrap supplied by the selected framework adapter.

Curation never destroys the plain state. It composes polished overlays, preserving a machine-readable `plain → polished` diff.

Proposed ordered fragment phases:

1. `base`
2. `primitive-tokens`
3. `semantic-tokens`
4. `component-tokens`
5. `theme-modes`
6. `typography-icons-assets`
7. `component-primitives`
8. `components`
9. `patterns-and-templates`
10. `motion-and-interaction`
11. `platform-binding`
12. `catalog-and-scenarios`
13. `exporters`
14. `postprocessors`

Each `DesignFragmentV1` has:

- `kind`, `label`, semantic version, digest, provenance.
- Compatibility predicates and target capabilities.
- `requires`, `provides`, `dependsOn`, conflicts, and replacement rules.
- Token/component/file outputs.
- Persona and behavior references.
- A required conformance suite.
- License, dependency, and asset provenance.
- A deterministic apply plan over a typed `DesignVfs`.

The VFS supports constrained operations such as `addTokenSet`, `addMode`, `addAlias`, `addComponent`, `addScenario`, `addAsset`, `addExporter`, and `addCatalogRoute`. File collisions, unresolved capabilities, undeclared dependencies, token cycles, or incompatible adapters fail loudly.

### F2D: author missing design fragments from scratch

`selectDesignFragmentConfig` remains open-string, exactly like template selection. If `bevy.tactical-hud`, `swiftui.spatial-navigation`, or an unknown future framework capability is absent, Tanren creates a per-fragment authoring DAG rather than substituting “closest available.”

The authoring loop is:

1. A read-only Answerer produces a strict `DesignFragmentPlanV1`.
2. A Writer/Codex agent receives the plan, DesignContract, working fragments, framework adapter contract, and rejection history, then writes real source/assets in an isolated jj workspace.
3. Deterministic validators check schema, token resolution, dependencies, buildability, exports, and component contracts.
4. Checker and auditor inspect correctness and security.
5. A4 renders the isolated fragment and the complete composed library.
6. The design oracle evaluates actual pixels, accessibility trees, interaction traces, and behavior coverage.
7. Rejections re-drive the Writer.
8. Only a fully conformant package is atomically persisted.
9. All newly authored fragments are composed together again before the release can publish; a failed full-library composition retracts the batch.

This generalizes the existing F2 loop, which already validates isolated and full-library composition and persists atomically ([fragmentAuthoringRun.ts:1](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/fragmentAuthoringRun.ts:1), [fragmentAuthoringRun.ts:310](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/fragmentAuthoringRun.ts:310)). Production template F2 also wires real runtime resolvers rather than trusting manifest syntax ([fragmentAuthoring.ts:17](/home/trevor/projects/tanren/services/orchestrator/src/routes/onboarding/fragmentAuthoring.ts:17), [fragmentAuthoring.ts:204](/home/trevor/projects/tanren/services/orchestrator/src/routes/onboarding/fragmentAuthoring.ts:204)). Design F2 must make real rendering equally non-optional.

Complex component source must remain Writer-owned. Answerers may select, plan, critique, and return verdict JSON, but must not mutate workspaces; that preserves Tanren’s structural Writer/Answerer split ([PROJECT_BRIEF.md:185](/home/trevor/projects/tanren/PROJECT_BRIEF.md:185)).

### Framework adapters behind one contract

Define a `DesignTargetAdapter` contract:

- `detectTarget(workspace)`
- `bootstrapPlainSystem()`
- `materialize(fragmentGraph, designVfs)`
- `buildCatalog()`
- `validateStatic()`
- `renderScenarioMatrix()`
- `export(format)`
- `enumerateProofRequirements()`

Initial adapters:

- **Web React:** shadcn-style open source, Radix/Base primitives, Tailwind/CSS variables, registry output, Storybook-compatible stories.
- **Generic web:** CSS custom properties, Web Components, framework-local components.
- **Bevy:** RON/JSON token resources, fonts, texture atlases, materials, UI scenes, input/focus contracts, game-state fixtures, WebGPU/native render harness.
- **Mobile:** SwiftUI, Jetpack Compose, Flutter, and React Native components plus platform resource formats.
- **Document/media:** presentation, PDF, HTML, image, motion, and video profiles where the DesignContract calls for them.

Every adapter ships the same adversarial conformance suite. Unsupported capabilities are typed gaps that invoke F2D; they are never silently omitted.

### The real artifact

`FrameworkDesignArtifactV1` is a signed, Merkle-addressed bundle containing:

- `manifest.json`
- DTCG `.tokens.json` files and `.resolver.json`
- Component contracts, source, variants, states, slots, and events
- Framework-native assets
- Catalog source and static build
- Persona/behavior-linked scenarios
- Export outputs
- SBOM, license inventory, dependency locks, and font/asset provenance
- Plain and polished release digests
- Fragment lineage and authoring-run IDs
- Build, token, accessibility, interaction, render, and oracle proofs
- Commit, gate, merge, deploy, and demo linkage

### A4 visual verification

Implement the requested A4 as the repository’s missing live-render capability:

- Start the real catalog/application in a runner container through SSH.
- Render a risk-selected matrix of component state × theme × viewport × locale × input mode × persona × behavior.
- Capture pixels, accessibility trees, DOM/scene graphs, console output, network failures, animation traces, and interaction recordings.
- Run deterministic checks first: build, schema, DTCG resolution, contrast, focus order, keyboard/touch behavior, reduced motion, overflow, missing glyphs/assets, target-size rules, and export round-trips.
- Then let the multimodal design oracle judge visual hierarchy, contract fidelity, consistency, and behavior suitability.
- Require negative controls in adapter conformance: intentionally broken contrast, focus, token alias, layout, and screenshot changes must cause the oracle/gate to fail.
- Convert all failures into the existing normalized finding currency so the ordinary Writer loop repairs them.

The oracle supplies evidence and findings. It does not become a second merge authority.

### Owned-stack advantage

Point tools stop at one boundary. Tanren can maintain one causal chain:

`Forge sentence → persona/behavior → DesignContract → fragment selection/F2 authoring → source files → rendered scenario → native gate → speculative integration → MergeAuthority → live deployment → per-behavior demo`

That enables:

- Parallel design-direction tournaments in jj workspaces, with evidence-based selection.
- Proof reuse keyed by fragment, target, environment, scenario, and artifact digests.
- Affected-only rendering for ordinary changes, full critical matrices at `pre_merge`.
- Batch visual testing and culprit bisection in the eager merge queue.
- Automatic org-wide impact DAGs when a shared theme release changes.
- Deployed demonstrations that prove the selected design actually serves the original behaviors.
- Production feedback becoming new specs or design-system releases rather than disconnected analytics.

---

## Continue reading

This bucket is split to respect the 500-line source-file cap. Section (1) above is the ideal design and owned-stack advantages; the operational spec continues in this sibling file:

1. [(2) comparator parity, (3) data model, (4) engine integration, (5) HTTP surface, (6) UI/dashboard, (7) runtime-behavior provability, (8) effort + phasing, (9) risks/unknowns](./design-engine-surfaces-phasing-risks.md)
