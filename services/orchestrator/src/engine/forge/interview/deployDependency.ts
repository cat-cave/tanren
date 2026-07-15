import type { ProvisionMode } from "../../contracts/integrationProvisioner.js";
import {
  resolveProviderKind,
  type NotLinkedResult,
  type ProvisionedResult,
  type SelectionRequiredResult,
} from "../../integrations/provisioningEngine.js";

type DeployAuthorityChoice = { connectionId?: string; grantId?: string };
export type GreenfieldDeployUnavailable = NotLinkedResult | SelectionRequiredResult;

export interface GreenfieldDeployDependency extends DeployAuthorityChoice {
  providerKind?: string;
  mode?: ProvisionMode;
  chosenResourceId?: string;
  stack?: string;
  name?: string;
}

export interface ResolvedGreenfieldDeployDependency extends DeployAuthorityChoice {
  providerKind: "deploy.vercel" | "deploy.flyio";
  mode: ProvisionMode;
  chosenResourceId?: string;
  stack?: string;
  name?: string;
}

export type DeployPreflightCallback = (input: {
  orgId: string;
  providerKind: "deploy.vercel" | "deploy.flyio";
  connectionId?: string;
  grantId?: string;
}) => Promise<GreenfieldDeployUnavailable | undefined>;

export interface PreparedGreenfieldDeploy {
  outcome: ProvisionedResult;
  projectConfig: Record<string, unknown>;
}

export function isDeployUnavailable(
  value: GreenfieldDeployUnavailable | PreparedGreenfieldDeploy,
): value is GreenfieldDeployUnavailable {
  return "status" in value && (value.status === "not_linked" || value.status === "selection_required");
}

export type PrepareDeployCallback = (input: {
  orgId: string;
  capability: "deploy";
  providerKind: "deploy.vercel" | "deploy.flyio";
  mode: ProvisionMode;
  projectKey: string;
  projectName: string;
  connectionId?: string;
  grantId?: string;
  chosenResourceId?: string;
  stack?: string;
  name?: string;
}) => Promise<GreenfieldDeployUnavailable | PreparedGreenfieldDeploy>;

export type PersistDeploySelectionCallback = (input: {
  orgId: string;
  projectId: string;
  providerKind: "deploy.vercel" | "deploy.flyio";
  connectionId: string;
  grantId: string;
}) => Promise<void>;

export class DeployProviderMissingError extends Error {}

export class DeployProviderInvalidError extends Error {}

export class DeployNotLinkedError extends Error {
  constructor(readonly outcome: NotLinkedResult) {
    super(outcome.message);
  }
}

export class DeploySelectionRequiredError extends Error {
  constructor(readonly outcome: SelectionRequiredResult) {
    super(outcome.message);
  }
}

export class DeployProvisioningUnavailableError extends Error {}

export function missingDeployProviderError(): DeployProviderMissingError {
  return new DeployProviderMissingError(
    "greenfield/apex creation requires an explicit deploy providerKind (deploy.vercel or deploy.flyio)",
  );
}

export function missingDeployProvisionerError(): DeployProvisioningUnavailableError {
  return new DeployProvisioningUnavailableError("deploy was required, but no deploy preparation callback was wired");
}

export function resolveGreenfieldDeployDependency(
  deploy: GreenfieldDeployDependency | undefined,
  options: { required: boolean },
): ResolvedGreenfieldDeployDependency | undefined {
  if (deploy === undefined) {
    if (options.required) throw missingDeployProviderError();
    return undefined;
  }
  if (deploy.providerKind === undefined || deploy.providerKind === "") {
    throw missingDeployProviderError();
  }
  let providerKind: string;
  try {
    providerKind = resolveProviderKind("deploy", deploy.providerKind);
  } catch (error) {
    throw new DeployProviderInvalidError(error instanceof Error ? error.message : String(error));
  }
  if (providerKind !== "deploy.vercel" && providerKind !== "deploy.flyio") {
    throw new DeployProviderInvalidError(`unsupported deploy provider '${providerKind}'`);
  }
  return {
    providerKind,
    mode: deploy.mode ?? "greenfield",
    ...(deploy.connectionId === undefined ? {} : { connectionId: deploy.connectionId }),
    ...(deploy.grantId === undefined ? {} : { grantId: deploy.grantId }),
    ...(deploy.chosenResourceId === undefined ? {} : { chosenResourceId: deploy.chosenResourceId }),
    ...(deploy.stack === undefined ? {} : { stack: deploy.stack }),
    ...(deploy.name === undefined ? {} : { name: deploy.name }),
  };
}
