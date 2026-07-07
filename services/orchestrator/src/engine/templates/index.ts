// Templating barrel — fragments are the single primitive
// (docs/roadmap/templating-system.md). Re-exports the fragment composition path;
// no other surface lives here. A project's seed is `composeTemplate(config, library)`
// over a config `selectFragmentConfig` derived from the captured lifecycle. A missing
// fragment spawns the per-fragment authoring DAG (F2); there is no fallback path.

export * from "./fragments/index.js";
