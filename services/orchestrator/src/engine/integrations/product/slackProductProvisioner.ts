import type {
  ApplicationIntegrationProvisioner,
  ApplicationObservation,
  ProductProvisionPlan,
  ProvisionedApplicationArtifact,
  ResolvedApplicationOutput,
} from "../../contracts/applicationIntegrationProvisioner.js";
import type { AppBindingOutputV1 } from "../../contracts/integrationBindingOutput.js";
import type { EligibleOperationExpectation, IntegrationOperationTarget } from "../../contracts/integrationAuthority.js";
import { projectIntegrationOperationTarget } from "../../contracts/integrationAuthority.js";
import { parseDigest } from "../../contracts/cas.js";
import { generationSecretRef, type ExactSecretCoordinate } from "../../contracts/integrationSecretStore.js";
import type {
  CapabilityId,
  ExistingResource,
  OrgGrant,
  ProjectContext,
} from "../../contracts/integrationProvisioner.js";
import type { IntegrationRequirementV1 } from "../../contracts/integrationRequirement.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import {
  deriveProductProvisionPlan,
  finalizeProductArtifact,
  PRODUCT_ADAPTER_VERSION,
  ProductProvisionFailedError,
} from "./applicationProvisionerKit.js";

export const SLACK_PRODUCT_MESSAGE_PROVIDER_KIND = "slack.product.message.v1";

const CAPABILITY_MESSAGING: CapabilityId = "messaging.send";
const SLACK_CHANNEL_NAME_MAX = 80;
const PRODUCT_CHANNEL_PREFIX = "tanren-product-";
const DIRECT_REQUIRED_OPERATIONS = ["chat.postMessage"] as const;
const DIRECT_REQUIRED_SCOPES = ["chat:write", "channels:read", "channels:manage", "channels:join"] as const;

export interface SlackProductChannel {
  readonly id: string;
  readonly name: string;
  readonly isMember: boolean;
}

export interface SlackProductMessageReceipt {
  readonly channelId: string;
  readonly messageTs: string;
}

/** Product-local Slack API surface; production sends real `conversations.*` + `chat.postMessage`. */
export interface SlackProductTransport {
  listChannels(): Promise<readonly SlackProductChannel[]>;
  createChannel(name: string): Promise<SlackProductChannel>;
  joinChannel(channelId: string): Promise<SlackProductChannel>;
  postMessage(channelId: string, text: string): Promise<SlackProductMessageReceipt>;
}

export type SlackProductTransportFactory = (token: string) => SlackProductTransport;

/** Direct product bot: no archive without durable ownership evidence. */
export class SlackProductProvisioner implements ApplicationIntegrationProvisioner {
  constructor(
    private readonly makeTransport: SlackProductTransportFactory,
    private readonly secrets: SecretStore,
  ) {}

  capability(): CapabilityId[] {
    return [CAPABILITY_MESSAGING];
  }

  plan(requirement: IntegrationRequirementV1, projectCtx: ProjectContext): ProductProvisionPlan {
    const base = deriveProductProvisionPlan(requirement, projectCtx, {
      providerKind: SLACK_PRODUCT_MESSAGE_PROVIDER_KIND,
      capabilities: [CAPABILITY_MESSAGING],
    });
    validateDirectOutputs(base.bindingOutputs, "plan");
    if (base.providerName !== "slack") {
      throw new ProductProvisionFailedError(
        "plan",
        `direct Slack provider requires provider 'slack', got '${base.providerName}'`,
      );
    }
    const plan = { ...base, desiredResourceName: productChannelName(projectCtx) };
    validateDirectPlan(plan, "plan");
    return plan;
  }

  async discover(grant: OrgGrant, projectCtx: ProjectContext): Promise<ExistingResource[]> {
    const transport = await this.transportFor(grant, projectCtx, "discover", {});
    const channels = await this.listChannels(transport, "discover");
    return channels.map((channel) => ({
      id: channel.id,
      label: channel.name,
      metadata: { isMember: channel.isMember },
    }));
  }

  async provision(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    validateDirectPlan(plan, "provision");
    const target = projectIntegrationOperationTarget(projectCtx);
    const transport = await this.transportFor(grant, projectCtx, "provision", target);
    const found = (await this.listChannels(transport, "provision")).find(
      (channel) => channel.name === plan.desiredResourceName,
    );
    const result =
      found === undefined
        ? await this.createOrFindChannel(transport, plan.desiredResourceName)
        : { channel: found, created: false };
    const channel = await this.ensureMember(transport, result.channel, "provision");

    // A newly-created channel is a real provider mutation. Slack confirms it again
    // with a non-blank `(channel, ts)` receipt from chat.postMessage. We do not send
    // a second setup message when the stable channel already exists, preserving
    // provision's idempotent find-or-create behavior.
    const receipt = result.created ? await this.sendBindingMessage(transport, channel, plan, "provision") : undefined;
    return this.artifactFor(grant, plan, channel, result.created, receipt, "provision");
  }

  async bind(
    grant: OrgGrant,
    existingResourceId: string,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    validateDirectPlan(plan, "bind");
    const target = projectIntegrationOperationTarget(projectCtx, existingResourceId);
    const transport = await this.transportFor(grant, projectCtx, "bind", target);
    const found = (await this.listChannels(transport, "bind")).find((channel) => channel.id === existingResourceId);
    if (found === undefined) {
      throw new ProductProvisionFailedError(
        "bind",
        `cannot bind unknown Slack product channel '${existingResourceId}'`,
      );
    }
    const channel = await this.ensureMember(transport, found, "bind");
    // Binding verifies the direct product bot can actually deliver to the exact
    // channel it will ship into app env. The returned provider receipt is evidence
    // of Slack's confirmed response, not product-reported success.
    const receipt = await this.sendBindingMessage(transport, channel, plan, "bind");
    return this.artifactFor(grant, plan, channel, false, receipt, "bind");
  }

  async observe(grant: OrgGrant, projectCtx: ProjectContext): Promise<ApplicationObservation> {
    const transport = await this.transportFor(grant, projectCtx, "discover", {});
    const channel = (await this.listChannels(transport, "observe")).find(
      (candidate) => candidate.name === productChannelName(projectCtx),
    );
    if (channel === undefined) return { present: false, drift: ["direct Slack product channel absent"] };
    return {
      present: true,
      externalResourceId: channel.id,
      drift: channel.isMember ? [] : ["direct Slack product bot is not a channel member"],
    };
  }

  async reconcile(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    return this.provision(grant, plan, projectCtx);
  }

  async rotate(
    _grant: OrgGrant,
    plan: ProductProvisionPlan,
    _projectCtx: ProjectContext,
  ): Promise<ProvisionedApplicationArtifact> {
    validateDirectPlan(plan, "rotate");
    // Credential rotation is an IntegrationAuthority operation. Reusing the same
    // token and pretending it rotated would be a fabricated credential generation.
    throw new ProductProvisionFailedError(
      "rotate",
      "direct Slack bot credentials rotate through IntegrationAuthority; this binding cannot fabricate a rotation",
    );
  }

  async teardown(_grant: OrgGrant, _projectCtx: ProjectContext): Promise<void> {
    // A direct channel can be operator-selected. No durable direct ownership marker
    // exists in this node, so archiving by a mutable convention name would risk
    // deleting user data. Block until an ownership-aware compensator exists.
    throw new ProductProvisionFailedError(
      "teardown",
      "direct Slack channel teardown requires durable ownership evidence and is not configured",
    );
  }

  private async createOrFindChannel(
    transport: SlackProductTransport,
    name: string,
  ): Promise<{ readonly channel: SlackProductChannel; readonly created: boolean }> {
    try {
      return { channel: await transport.createChannel(name), created: true };
    } catch (error) {
      if (!isNameTaken(error)) throw asProductFailure("provision", error);
      const raced = (await this.listChannels(transport, "provision")).find((channel) => channel.name === name);
      if (raced === undefined) {
        throw new ProductProvisionFailedError(
          "provision",
          `Slack reported name_taken for '${name}' but no matching channel is observable`,
        );
      }
      return { channel: raced, created: false };
    }
  }

  private async ensureMember(
    transport: SlackProductTransport,
    channel: SlackProductChannel,
    stage: "provision" | "bind",
  ): Promise<SlackProductChannel> {
    assertConfirmedChannel(channel, stage);
    if (channel.isMember) return channel;
    let joined: SlackProductChannel;
    try {
      joined = await transport.joinChannel(channel.id);
    } catch (error) {
      throw asProductFailure(stage, error);
    }
    assertConfirmedChannel(joined, stage);
    if (joined.id !== channel.id || !joined.isMember) {
      throw new ProductProvisionFailedError(
        stage,
        "incomplete_slack_evidence: join did not confirm the exact channel membership",
      );
    }
    return joined;
  }

  private async sendBindingMessage(
    transport: SlackProductTransport,
    channel: SlackProductChannel,
    plan: ProductProvisionPlan,
    stage: "provision" | "bind",
  ): Promise<SlackProductMessageReceipt> {
    let receipt: SlackProductMessageReceipt;
    try {
      receipt = await transport.postMessage(
        channel.id,
        `Tanren product Slack binding ${plan.requirementId} confirmed.`,
      );
    } catch (error) {
      throw asProductFailure(stage, error);
    }
    const rawReceipt: unknown = receipt;
    if (rawReceipt === null || typeof rawReceipt !== "object" || Array.isArray(rawReceipt)) {
      throw new ProductProvisionFailedError(stage, "incomplete_slack_evidence: chat.postMessage returned no receipt");
    }
    const receiptRecord = rawReceipt as Record<string, unknown>;
    const receiptChannelId = receiptRecord["channelId"];
    const receiptMessageTs = receiptRecord["messageTs"];
    if (
      typeof receiptChannelId !== "string" ||
      receiptChannelId.trim() === "" ||
      typeof receiptMessageTs !== "string" ||
      receiptMessageTs.trim() === "" ||
      receiptChannelId !== channel.id
    ) {
      throw new ProductProvisionFailedError(
        stage,
        "incomplete_slack_evidence: chat.postMessage did not confirm the exact channel and message receipt",
      );
    }
    return { channelId: receiptChannelId, messageTs: receiptMessageTs };
  }

  private artifactFor(
    grant: OrgGrant,
    plan: ProductProvisionPlan,
    channel: SlackProductChannel,
    created: boolean,
    receipt: SlackProductMessageReceipt | undefined,
    stage: "provision" | "bind",
  ): ProvisionedApplicationArtifact {
    assertConfirmedChannel(channel, stage);
    const source = directBotTokenSource(grant);
    const outputs = plan.bindingOutputs.map((output) => directOutput(output, source, channel.id, stage));
    return finalizeProductArtifact(
      {
        providerKind: SLACK_PRODUCT_MESSAGE_PROVIDER_KIND,
        adapterVersion: PRODUCT_ADAPTER_VERSION,
        externalResourceId: channel.id,
        externalResourceName: channel.name,
        ownership: created ? "created" : "adopted",
        outputs,
        ...(receipt === undefined
          ? {}
          : { receipt: { slackChannelId: receipt.channelId, slackMessageTs: receipt.messageTs } }),
      },
      stage,
    );
  }

  private async transportFor(
    grant: OrgGrant,
    projectCtx: ProjectContext,
    operation: "discover" | "provision" | "bind",
    target: IntegrationOperationTarget,
  ): Promise<SlackProductTransport> {
    const expected: EligibleOperationExpectation = {
      orgId: projectCtx.orgId,
      projectId: projectCtx.projectId,
      providerKind: "slack",
      capability: CAPABILITY_MESSAGING,
      operation,
      target,
    };
    const token = await resolveDirectBotToken(this.secrets, grant, expected, operation);
    return this.makeTransport(token);
  }

  private async listChannels(
    transport: SlackProductTransport,
    stage: "discover" | "provision" | "bind" | "observe",
  ): Promise<readonly SlackProductChannel[]> {
    try {
      const channels = await transport.listChannels();
      channels.forEach((channel) => assertConfirmedChannel(channel, stage));
      return channels;
    } catch (error) {
      throw error instanceof ProductProvisionFailedError ? error : asProductFailure(stage, error);
    }
  }
}

function validateDirectPlan(plan: ProductProvisionPlan, stage: "plan" | "provision" | "bind" | "rotate"): void {
  if (plan.providerKind !== SLACK_PRODUCT_MESSAGE_PROVIDER_KIND) {
    throw new ProductProvisionFailedError(
      stage,
      `direct Slack received plan for '${plan.providerKind}', not its provider kind`,
    );
  }
  if (plan.providerName !== "slack") {
    throw new ProductProvisionFailedError(stage, `direct Slack plan selected '${plan.providerName}', not Slack`);
  }
  if (plan.capability !== CAPABILITY_MESSAGING) {
    throw new ProductProvisionFailedError(stage, `direct Slack plan has unsupported capability '${plan.capability}'`);
  }
  try {
    parseDigest(plan.requirementId);
  } catch {
    throw new ProductProvisionFailedError(stage, "direct Slack plan has no valid requirement digest");
  }
  if (isBlank(plan.desiredResourceName)) {
    throw new ProductProvisionFailedError(stage, "direct Slack plan has a blank channel name");
  }
  assertRequiredPlanEntries(plan.requiredOperations, DIRECT_REQUIRED_OPERATIONS, "operation", stage);
  assertRequiredPlanEntries(plan.requiredScopes, DIRECT_REQUIRED_SCOPES, "scope", stage);
  validateDirectOutputs(plan.bindingOutputs, stage);
}

function validateDirectOutputs(
  outputs: readonly AppBindingOutputV1[],
  stage: "plan" | "provision" | "bind" | "rotate",
): void {
  if (!Array.isArray(outputs)) {
    throw new ProductProvisionFailedError(stage, "direct Slack plan outputs are not an array");
  }
  for (const output of outputs) {
    const raw: unknown = output;
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      typeof (raw as Record<string, unknown>)["kind"] !== "string" ||
      typeof (raw as Record<string, unknown>)["logicalKey"] !== "string" ||
      typeof (raw as Record<string, unknown>)["classification"] !== "string" ||
      typeof (raw as Record<string, unknown>)["required"] !== "boolean"
    ) {
      throw new ProductProvisionFailedError(stage, "direct Slack plan includes a malformed output");
    }
  }
  const token = outputs.filter((output) => output.kind === "product.messaging.bot_token_ref");
  const channel = outputs.filter((output) => output.kind === "product.messaging.channel_id");
  if (outputs.length !== 2 || token.length !== 1 || channel.length !== 1) {
    throw new ProductProvisionFailedError(
      stage,
      "direct Slack requires exactly product.messaging.bot_token_ref + product.messaging.channel_id outputs",
    );
  }
  if (token[0]?.classification !== "secret_ref" || channel[0]?.classification !== "plain") {
    throw new ProductProvisionFailedError(
      stage,
      "direct Slack requires a secret_ref bot token output and a plain channel id output",
    );
  }
}

function assertRequiredPlanEntries(
  values: readonly string[],
  required: readonly string[],
  kind: "operation" | "scope",
  stage: "plan" | "provision" | "bind" | "rotate",
): void {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new ProductProvisionFailedError(stage, `direct Slack plan has malformed required ${kind}s`);
  }
  const actual = new Set(values);
  const missing = required.filter((value) => !actual.has(value));
  if (missing.length > 0) {
    throw new ProductProvisionFailedError(
      stage,
      `direct Slack plan is missing required ${kind}(s): ${missing.join(", ")}`,
    );
  }
}

function directOutput(
  output: AppBindingOutputV1,
  source: ExactSecretCoordinate,
  channelId: string,
  stage: "provision" | "bind",
): ResolvedApplicationOutput {
  switch (output.kind) {
    case "product.messaging.bot_token_ref":
      return { output, secretSource: source };
    case "product.messaging.channel_id":
      return { output, plainValue: channelId };
    default:
      throw new ProductProvisionFailedError(stage, `direct Slack cannot produce '${output.kind}'`);
  }
}

function productChannelName(projectCtx: ProjectContext): string {
  const slug = projectCtx.projectId
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  if (slug === "") {
    throw new ProductProvisionFailedError(
      "plan",
      "project context has no usable project id for a direct Slack channel",
    );
  }
  return `${PRODUCT_CHANNEL_PREFIX}${slug}`.slice(0, SLACK_CHANNEL_NAME_MAX);
}

function directBotTokenSource(grant: OrgGrant): ExactSecretCoordinate {
  const ref = grant.eligibleOperation.credentialRef;
  return {
    ref: ref.includes("/g/") ? ref : generationSecretRef(ref, grant.authGeneration),
    generation: grant.authGeneration,
  };
}

async function resolveDirectBotToken(
  secrets: SecretStore,
  grant: OrgGrant,
  expected: EligibleOperationExpectation,
  stage: "discover" | "provision" | "bind",
): Promise<string> {
  try {
    const { GenerationAddressedIntegrationSecretStore } = await import("../integrationSecretStoreImpl.js");
    const { assertOrgGrantMatchesLease, secretValueForLease } =
      await import("../../repositories/integrationConnectionResolve.js");
    assertOrgGrantMatchesLease(grant);
    const token = await secretValueForLease(
      new GenerationAddressedIntegrationSecretStore(secrets),
      grant.eligibleOperation,
      expected,
    );
    if (isBlank(token)) {
      throw new Error("direct Slack bot token is missing or blank");
    }
    return token;
  } catch (error) {
    throw asProductFailure(stage, error, "direct_slack_bot_token_unresolved");
  }
}

function assertConfirmedChannel(
  channel: SlackProductChannel,
  stage: "discover" | "provision" | "bind" | "observe",
): void {
  if (isBlank(channel.id) || isBlank(channel.name) || typeof channel.isMember !== "boolean") {
    throw new ProductProvisionFailedError(
      stage,
      "incomplete_slack_evidence: channel id/name/member confirmation is missing, blank, or wrong-type",
    );
  }
}

function isNameTaken(error: unknown): boolean {
  return error instanceof Error && error.message.includes("name_taken");
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

function asProductFailure(
  stage: "discover" | "provision" | "bind" | "observe",
  error: unknown,
  prefix = "direct_slack_error",
): ProductProvisionFailedError {
  const reason = error instanceof Error ? error.message : String(error);
  return new ProductProvisionFailedError(stage, `${prefix}: ${reason}`);
}
