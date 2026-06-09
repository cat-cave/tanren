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
