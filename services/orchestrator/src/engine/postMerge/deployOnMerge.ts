export {
  DeployOnMergeWatcher,
  type DeployOnMergeWatcherDeps,
  type ProjectDeployTarget,
} from "./deployOnMergeShared.js";
export { buildDeployOnMergeWatcher } from "./buildDeployOnMergeWatcher.js";
// Re-export the demo-on-deploy watcher factory off this same module so the autonomy-loops
// boot imports both deploy-path watchers from ONE symbol source (the max-dependencies cap).
export { buildDemoOnDeployWatcher } from "./demoOnDeploy.js";
