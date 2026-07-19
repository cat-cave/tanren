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
export {
  ProjectBootstrapIncompleteError,
  ProjectDesignElaborationStateUnknownError,
  deriveProductGraph,
} from "./deriveProductGraph.js";
export { ProjectDerivationConflictError } from "../../repositories/projects.js";

/** The ds-composer seam signature: compose+publish the project's web design system
 * (idempotent, fail-closed). Threaded into the derive so it runs once the HEAD design
 * contract exists. Production wires `composeProjectWebDesignSystem`. */
export type ComposeDesignSystemCallback = (input: { orgId: string; projectId: string }) => Promise<void>;

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
  /** ds-composer — the DESIGN-SYSTEM COMPOSITION seam (the design analog of
   * `runFragmentAuthoring`). Runs AFTER the design contract is persisted (the graph
   * step) and BEFORE bootstrap: it reads the project HEAD contract, authors the
   * missing design fragments through ds-3 F2D, and publishes the web design release
   * the run-context reader (`resolveProjectWebDesignSystem`) resolves. Idempotent
   * (short-circuits on an already-published lineage) + fail-closed (an authoring
   * failure propagates, blocking activation). Absent ⇒ no design system is composed
   * (the injected-seam / engine-graph test path). */
  composeDesignSystem?: ComposeDesignSystemCallback;
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
  designContract: { id: string; version: number; domain: string; digest: string };
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
