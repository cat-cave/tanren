// P3-0010: thick-Forge conversation backend barrel.
//
// The LLM-backed conversation engine that replaces the templated v0 narration
// for operator-driven questions. The Forge thread route imports `askForge` +
// `wrapProviderAnswerer`; the scripted fake answerer is a test fixture.

export { askForge } from "./engine.js";
export type { ForgeAskInput, ForgeAskResult, ForgeConversationDeps, ForgeReadToolDispatcher } from "./engine.js";

export { wrapProviderAnswerer, ForgeAnswererStepSchema } from "./answerer.js";
export type { ForgeAnswererStepOutput, WrapProviderAnswererOptions } from "./answerer.js";

export { buildForgePrompt } from "./prompt.js";

export { FORGE_READ_TOOLS, isReadToolName } from "./types.js";
export type {
  ForgeConversationAnswerer,
  ForgeConversationContext,
  ForgeAnswererStep,
  ForgeReadToolCall,
  ForgeToolResult,
} from "./types.js";
