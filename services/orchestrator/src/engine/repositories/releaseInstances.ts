// Compatibility facade for release lifecycle consumers. State/input contracts and
// SQL persistence are separate domains behind the historical module path.
export {
  InvalidReleaseStateTransitionError,
  ReleaseInstanceNotFoundError,
  RELEASE_ENVIRONMENTS,
  RELEASE_STATES,
} from "./releaseInstanceContracts.js";
export type {
  CreateReleaseInstanceInput,
  GetReleaseInstanceByDeploymentInput,
  MarkLiveReleaseInput,
  PromoteReleaseInput,
  ReleaseInstancesRepository,
  RollbackReleaseInput,
  SupersedePriorLiveInput,
  TeardownPreviewInput,
  TransitionReleaseInstanceInput,
} from "./releaseInstanceContracts.js";
export { ReleaseInstancesStore } from "./releaseInstanceStore.js";
