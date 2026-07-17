import { AppEnvRuntimeAttachedPayload } from "./integrations.js";

export const appEnvironmentEventRegistry = {
  "app_env.runtime_attached": AppEnvRuntimeAttachedPayload,
} as const;
