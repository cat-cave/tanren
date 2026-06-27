// Templating barrel — fragments are the single primitive
// (docs/roadmap/templating-system.md). Re-exports the fragment composition path;
// no other surface lives here.
//
// The previous wave-1/wave-3/wave-5 modules (org `templates` table + repository,
// manifest/validationProof/negativeControls/validationHarness, creation meta-DAG,
// maintenance scheduler, scratchCopy) have been REMOVED — the doctrine collapse
// (docs/roadmap/templating-system.md) makes the FRAGMENT LIBRARY the only template
// primitive. A project's seed is `composeTemplate(config, library)` over a config
// `selectFragmentConfig` derived from the captured lifecycle. There is no
// registry-of-templates, no agent-template-build, no template-maintenance scheduler.

export * from "./fragments/index.js";
