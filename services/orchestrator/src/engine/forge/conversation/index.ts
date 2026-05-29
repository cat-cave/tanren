// P3-0010: thick-Forge conversation backend barrel.
//
// The LLM-backed conversation engine that replaces the templated v0 narration
// for operator-driven questions. The Forge thread route imports `askForge` +
// `wrapProviderAnswerer`; tests import `createFakeForgeAnswerer`.

export { askForge } from "./engine.js";
export type { ForgeAskInput, ForgeAskResult, ForgeConversationDeps, ForgeReadToolDispatcher } from "./engine.js";

export { wrapProviderAnswerer, createFakeForgeAnswerer, ForgeAnswererStepSchema } from "./answerer.js";
export type { ForgeAnswererStepOutput, WrapProviderAnswererOptions, FakeForgeAnswererOptions } from "./answerer.js";

export { buildForgePrompt } from "./prompt.js";

export { FORGE_READ_TOOLS, isReadToolName } from "./types.js";
export type {
  ForgeConversationAnswerer,
  ForgeConversationContext,
  ForgeAnswererStep,
  ForgeReadToolCall,
  ForgeToolResult,
} from "./types.js";
