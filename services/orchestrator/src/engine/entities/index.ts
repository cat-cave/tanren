// P2A-0018 product entities barrel. CRUD routes (P2A-0013) and downstream
// surfaces import the typed stores and Zod schemas from here.
export {
  PersonaScope,
  PersonaMetadata,
  PersonaRow,
  PersonaCreateInput,
  PersonaStore
} from "./personas.js";
export {
  BehaviorMetadata,
  BehaviorRow,
  BehaviorCreateInput,
  BehaviorStore
} from "./behaviors.js";
export {
  MilestoneStatus,
  MilestoneRow,
  MilestoneCreateInput,
  MilestoneStore
} from "./milestones.js";
export {
  SpecDependencyRow,
  SpecDependencyStore,
  CyclicSpecDependencyError,
  SelfSpecDependencyError,
  assertNoCycle
} from "./specDependencies.js";
