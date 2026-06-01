// Barrel for the three Forge HTTP route groups so the feature-route mount table
// imports them from one module: the thread/tool routes (`createForgeRoutes`), the
// ⌘K conversation route (`createForgeAskRoutes`), and the write-action approval
// route (`createForgeProposalRoutes`). Collapsing them keeps the mount file under
// the module dependency cap; behavior is unchanged.

export { createForgeRoutes } from "./index.js";
export { createForgeAskRoutes } from "./ask.js";
export { createForgeProposalRoutes } from "./proposals.js";
