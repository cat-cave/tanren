export {
  checkFullProjectConfigPatch,
  checkGenericProjectCreateConfig,
} from "../../engine/workflow/projectConfigWriteGuards.js";

// gv-3: re-export so projects/index stays under max-dependencies while the
// exclusive implementation lives in policyIdentity.ts.
export { handlePolicyIdentityGet } from "./policyIdentity.js";
