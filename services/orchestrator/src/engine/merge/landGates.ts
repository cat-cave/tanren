// Land-time acceptance-gate readers barrel. The bundle build + the MQ-2 gather resolve
// BOTH the runtime-behavior gate and the design-render gate at land time; importing them
// from one module keeps those gather sites within the module-dependency cap.

export { resolveLandTimeBehaviorGate, type BehaviorLandGate } from "./behaviorLandGate.js";
export { resolveDesignRenderGate, type DesignRenderGate } from "./designRenderLandGate.js";
