// The canonical stack-agnostic project skeleton — the single source of the
// project CONTRACT shape (the justfile-convention lifecycle + the generic
// `.tanren/ci.yml` that defers to it). Wave B's scaffold writer consumes
// SKELETON_FILES; the bootstrap LOUD-fallback + brownfield config-injection
// consume the individual constants.
export {
  SKELETON_CI_CONFIG,
  SKELETON_CI_CONFIG_PATH,
  SKELETON_FILES,
  SKELETON_JUSTFILE,
  SKELETON_JUSTFILE_PATH,
  SKELETON_README,
} from "./skeleton.js";
export type { SkeletonFile } from "./skeleton.js";
// The DETERMINISTIC contract-file projection (v27 fix): the `.tanren/ci.yml` +
// `justfile` the RUN path materializes verbatim from the captured lifecycle — no
// LLM authoring of the contract files.
export { materializeContractFiles, renderLifecycleJustfile } from "./contractFiles.js";
export type { ContractFile } from "./contractFiles.js";
