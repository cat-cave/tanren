// Public types for completed vision capture → durable, resumable product derive.

import type { ActorContext } from "../../../auth/schemas.js";
import type { CreatedRepository, CreateRepositoryInput } from "../../contracts/codeHostTypes.js";
import type { DesignAgent } from "../../design/designAgent.js";
import type {
  ProvisionAutonomousProjectInput,
  ProvisionAutonomousProjectResult,
} from "../../workflow/provisionAutonomousProject.js";
import type {
  FragmentAuthoring,
  FragmentLibrary,
  MaterializeTemplate,
  ProductContext,
  SeededTemplate,
} from "../../templates/index.js";
import type {
  DeployPreflightCallback,
  GreenfieldDeployDependency,
  PrepareDeployCallback,
  PersistDeploySelectionCallback,
} from "./deployDependency.js";
import type { DeleteRepositoryCallback } from "./deriveCompensation.js";
import type { InterviewCapture } from "./types.js";

export { FragmentAuthoringFailedError, UnresolvableLifecycleError } from "../../templates/index.js";
export { ProjectBootstrapIncompleteError, deriveProductGraph } from "./deriveProductGraph.js";
export { ProjectDerivationConflictError } from "../../repositories/projects.js";

export interface DeriveInput {
  orgId: string;
  capture: InterviewCapture;
  actor: ActorContext;
  /** Explicit repo override for engine tests; production supplies owner+creator. */
  repoUrl?: string;
  owner?: string;
  private?: boolean;
  description?: string;
  createRepository?: (input: CreateRepositoryInput) => Promise<CreatedRepository>;
  autonomy?: "auto" | "simulated" | "human";
  deploy?: GreenfieldDeployDependency;
  preflightDeploy?: DeployPreflightCallback;
  prepareDeploy?: PrepareDeployCallback;
  persistDeploySelection?: PersistDeploySelectionCallback;
  materializeTemplate?: MaterializeTemplate;
  fragmentLibrary?: FragmentLibrary;
  runFragmentAuthoring?: FragmentAuthoring;
  designAgent?: DesignAgent;
  /** Repo-create compensation applies only before the durable deriving shell lands. */
  deleteRepository?: DeleteRepositoryCallback;
  probeRepoBareAutoInit?: (target: { owner: string; name: string }) => Promise<boolean>;
  /** Test seam; production uses the real complete autonomous bootstrap. */
  bootstrapProject?: (input: ProvisionAutonomousProjectInput) => Promise<ProvisionAutonomousProjectResult>;
}

export interface DeriveResult {
  projectId: string;
  projectName: string;
  repository?: CreatedRepository;
  specIds: string[];
  personaIds: string[];
  behaviorIds: string[];
  milestoneIds: string[];
  designContractId?: string;
  templateSeed?: SeededTemplate;
  /** Complete, error-free autonomous bootstrap receipt required for activation. */
  bootstrap?: ProvisionAutonomousProjectResult;
}

export type {
  FragmentAuthoring,
  FragmentAuthoringInput,
  FragmentAuthoringResult,
} from "../../templates/fragments/fragmentAuthoringRun.js";
export type { ProductContext };
export { buildProductContextFromCapture } from "./deriveBehaviorSpec.js";
