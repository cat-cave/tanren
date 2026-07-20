export {
  DeployOnMergeWatcher,
  type DeployOnMergeWatcherDeps,
  type ProjectDeployTarget,
} from "./deployOnMergeShared.js";
export { buildDeployOnMergeWatcher } from "./buildDeployOnMergeWatcher.js";
// in-17: the durable delivery DAG driver factory rides this same barrel so the
// autonomy-loops boot imports all three post-merge factories from ONE module (dep cap).
export { buildDeliveryDagDriver } from "./delivery/buildDeliveryDagDriver.js";
// Re-export the demo-on-deploy watcher factory off this same module so the autonomy-loops
// boot imports both deploy-path watchers from ONE symbol source (the max-dependencies cap).
export { buildDemoOnDeployWatcher } from "./demoOnDeploy.js";
