/**
 * Governance Studio BFF. It consumes only the existing org-scoped governance
 * authority: revisions, tiers, bindings, and exact receipt coordinates.
 */

import type { Context, Hono } from "hono";
import {
  EffectivePolicySubjectKindSchema,
  GovernanceFragmentConfigSchema,
  type GovernanceStudioData,
} from "../../api/governanceStudio.js";
import {
  GovernanceStudioClient,
  type GovernanceStudioRead,
  type ReceiptRead,
} from "../../api/governanceStudioClient.js";
import type { ProjectSummary } from "../../api/types.js";
import { clientDepsFor } from "../../api/clientDeps.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { GovernanceStudioBody, type GovernanceStudioFlash } from "../../components/governance/GovernanceStudioBody.js";

type FormText = { readonly kind: "absent" | "invalid" } | { readonly kind: "text"; readonly value: string };
type OptionalText = { readonly valid: true; readonly value: string | undefined } | { readonly valid: false };
type ReceiptState = ReceiptRead | { readonly kind: "not_requested" | "invalid_query" };
type ReceiptCoordinate =
  | {
      readonly kind: "coordinate";
      readonly subjectKind: "run" | "change" | "activation";
      readonly subjectId: string;
      readonly defaultActiveBinding: boolean;
    }
  | { readonly kind: "not_requested" | "invalid_query" };

function readClient(c: Context, deps: ShellDeps): GovernanceStudioClient {
  return new GovernanceStudioClient({ orchestratorUrl: deps.orchestratorUrl, cookieHeader: c.req.header("cookie") });
}

async function writeClient(c: Context, deps: ShellDeps): Promise<GovernanceStudioClient> {
  return new GovernanceStudioClient(await clientDepsFor(c, deps));
}

function resolveProject(
  projects: readonly ProjectSummary[],
  requestedId: string | undefined,
): ProjectSummary | undefined {
  if (requestedId === undefined || requestedId === "") return projects[0];
  return projects.find((project) => project.projectId === requestedId);
}

function formText(form: Record<string, unknown>, key: string): FormText {
  if (!Object.hasOwn(form, key)) return { kind: "absent" };
  const value = form[key];
  return typeof value === "string" ? { kind: "text", value } : { kind: "invalid" };
}

function requiredTrimmed(field: FormText): string | undefined {
  if ("value" in field) {
    const value = field.value.trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

function optionalTrimmed(field: FormText): OptionalText {
  if ("value" in field) {
    const value = field.value.trim();
    return { valid: true, value: value === "" ? undefined : value };
  }
  return field.kind === "invalid" ? { valid: false } : { valid: true, value: undefined };
}

function receiptCoordinate(c: Context, data: GovernanceStudioData): ReceiptCoordinate {
  const kind = c.req.query("receiptKind");
  const subjectId = c.req.query("receiptId");
  if (kind === undefined && subjectId === undefined) {
    const binding = data.activeBinding;
    return binding === undefined
      ? { kind: "not_requested" }
      : { kind: "coordinate", subjectKind: "activation", subjectId: binding.id, defaultActiveBinding: true };
  }
  const parsedKind = EffectivePolicySubjectKindSchema.safeParse(kind);
  const trimmedSubjectId = subjectId?.trim();
  if (!parsedKind.success || trimmedSubjectId === undefined || trimmedSubjectId === "")
    return { kind: "invalid_query" };
  return { kind: "coordinate", subjectKind: parsedKind.data, subjectId: trimmedSubjectId, defaultActiveBinding: false };
}

async function receiptFor(
  c: Context,
  deps: ShellDeps,
  orgId: string,
  projectId: string,
  data: GovernanceStudioData,
): Promise<ReceiptState> {
  const coordinate = receiptCoordinate(c, data);
  if (coordinate.kind !== "coordinate") return coordinate;
  const receipt = await readClient(c, deps).getReceipt(orgId, projectId, coordinate.subjectKind, coordinate.subjectId);
  if (!coordinate.defaultActiveBinding || receipt.kind !== "found") return receipt;
  const binding = data.activeBinding;
  const tier = binding === undefined ? undefined : data.tiersById.get(binding.tierId);
  const revision = data.revisions.find((candidate) => candidate.id === receipt.snapshot.policyRevisionId);
  if (
    binding === undefined ||
    tier === undefined ||
    receipt.snapshot.bindingId !== binding.id ||
    receipt.snapshot.tierId !== tier.id ||
    receipt.snapshot.effectivePolicyHash !== binding.effectivePolicyHash ||
    revision === undefined ||
    revision.policyHash !== receipt.snapshot.effectivePolicyHash
  ) {
    return { kind: "malformed", status: 502 };
  }
  return receipt;
}

async function renderStudio(
  c: Context,
  deps: ShellDeps,
  input: {
    readonly requestedId: string | undefined;
    readonly flash?: GovernanceStudioFlash;
    readonly loaded?: GovernanceStudioRead;
  },
): Promise<Response> {
  const ctx = await loadShellContext(c, deps, { activeNavId: "governance", projectId: input.requestedId });
  const project = resolveProject(ctx.projects, input.requestedId);
  const scopedCtx = project === undefined ? ctx : { ...ctx, project };
  const read =
    project === undefined || ctx.org === undefined
      ? undefined
      : (input.loaded ?? (await readClient(c, deps).readProject(ctx.org.id, project.projectId)));
  const receipt =
    read?.ok === true && ctx.org !== undefined && project !== undefined
      ? await receiptFor(c, deps, ctx.org.id, project.projectId, read.data)
      : { kind: "not_requested" as const };
  return renderShell(
    c,
    scopedCtx,
    { title: "tanren · governance studio" },
    <GovernanceStudioBody
      projects={ctx.projects}
      project={project}
      studio={read?.ok === true ? read.data : undefined}
      readFailure={read?.ok === false ? read.failure : undefined}
      receipt={receipt}
      receiptKind={c.req.query("receiptKind")}
      receiptId={c.req.query("receiptId")}
      flash={input.flash}
      csrfToken={ctx.csrfToken}
    />,
  ) as Promise<Response>;
}

async function loadActionScope(c: Context, deps: ShellDeps, projectId: string) {
  const ctx = await loadShellContext(c, deps, { activeNavId: "governance", projectId });
  const project = resolveProject(ctx.projects, projectId);
  if (ctx.org === undefined || project === undefined || project.projectId !== projectId) return null;
  const read = await readClient(c, deps).readProject(ctx.org.id, projectId);
  return { ctx, orgId: ctx.org.id, project, read };
}

function rejectedMessage(label: string, status: number): GovernanceStudioFlash {
  return status >= 400 && status < 500
    ? {
        kind: "error",
        message: `${label} was rejected by the governance authority (status ${status}); no success is claimed.`,
      }
    : {
        kind: "unknown",
        message: `${label} has an unknown outcome (status ${status}). Refresh and verify before retrying.`,
      };
}

function unscopedMessage(): GovernanceStudioFlash {
  return { kind: "error", message: "The project is not visible in this organization; no governance command was sent." };
}

export function mountGovernanceStudioScreen(app: Hono, deps: ShellDeps): void {
  app.get("/governance", (c) => renderStudio(c, deps, { requestedId: c.req.query("projectId") }));

  app.post("/governance/revisions", async (c) => {
    const form = await c.req.parseBody();
    const projectId = requiredTrimmed(formText(form, "projectId"));
    const configField = formText(form, "fragmentConfig");
    const parentField = optionalTrimmed(formText(form, "parentRevisionId"));
    if (projectId === undefined) return renderStudio(c, deps, { requestedId: undefined, flash: unscopedMessage() });
    const scope = await loadActionScope(c, deps, projectId);
    if (scope === null) return renderStudio(c, deps, { requestedId: projectId, flash: unscopedMessage() });
    if (!scope.read.ok)
      return renderStudio(c, deps, {
        requestedId: projectId,
        loaded: scope.read,
        flash: { kind: "error", message: "Governance lineage is unavailable, so no author command was sent." },
      });
    const configText = requiredTrimmed(configField);
    if (configText === undefined || configText.length > 200_000 || !parentField.valid) {
      return renderStudio(c, deps, {
        requestedId: projectId,
        loaded: scope.read,
        flash: {
          kind: "error",
          message:
            "Enter a nonblank JSON fragment config and a text parent revision, if supplied. No command was sent.",
        },
      });
    }
    let fragmentConfig: unknown;
    try {
      fragmentConfig = JSON.parse(configText);
    } catch {
      return renderStudio(c, deps, {
        requestedId: projectId,
        loaded: scope.read,
        flash: { kind: "error", message: "Fragment config is not valid JSON. No command was sent." },
      });
    }
    const validatedConfig = GovernanceFragmentConfigSchema.safeParse(fragmentConfig);
    if (!validatedConfig.success) {
      return renderStudio(c, deps, {
        requestedId: projectId,
        loaded: scope.read,
        flash: {
          kind: "error",
          message: "Fragment config does not match governance-fragments/v1. No command was sent.",
        },
      });
    }
    if (
      parentField.value !== undefined &&
      !scope.read.data.revisions.some((revision) => revision.id === parentField.value)
    ) {
      return renderStudio(c, deps, {
        requestedId: projectId,
        loaded: scope.read,
        flash: {
          kind: "error",
          message: "The parent revision is not in the current project lineage. No command was sent.",
        },
      });
    }
    const result = await (
      await writeClient(c, deps)
    ).createRevision(scope.orgId, projectId, validatedConfig.data, parentField.value);
    if (!result.ok)
      return renderStudio(c, deps, {
        requestedId: projectId,
        flash: rejectedMessage("Policy authoring", result.status),
      });
    const confirmed = await readClient(c, deps).readProject(scope.orgId, projectId);
    const matched =
      confirmed.ok &&
      confirmed.data.revisions.some(
        (revision) => revision.id === result.value.id && revision.policyHash === result.value.policyHash,
      );
    return renderStudio(c, deps, {
      requestedId: projectId,
      loaded: confirmed,
      flash: matched
        ? {
            kind: "ok",
            message: `Revision #${result.value.revisionNumber} was created and reloaded from the authoritative lineage.`,
          }
        : {
            kind: "unknown",
            message:
              "The authoring command returned a revision, but its durable lineage coordinate could not be confirmed.",
          },
    });
  });

  app.post("/governance/revisions/activate", async (c) => {
    const form = await c.req.parseBody();
    const projectId = requiredTrimmed(formText(form, "projectId"));
    const revisionId = requiredTrimmed(formText(form, "revisionId"));
    if (projectId === undefined || revisionId === undefined)
      return renderStudio(c, deps, {
        requestedId: projectId,
        flash: { kind: "error", message: "A nonblank project and revision are required. No command was sent." },
      });
    const scope = await loadActionScope(c, deps, projectId);
    if (scope === null) return renderStudio(c, deps, { requestedId: projectId, flash: unscopedMessage() });
    if (!scope.read.ok || !scope.read.data.revisions.some((revision) => revision.id === revisionId))
      return renderStudio(c, deps, {
        requestedId: projectId,
        loaded: scope.read,
        flash: {
          kind: "error",
          message: "The revision is not present in a validated project lineage. No activation command was sent.",
        },
      });
    const result = await (await writeClient(c, deps)).activateRevision(scope.orgId, projectId, revisionId);
    if (!result.ok)
      return renderStudio(c, deps, {
        requestedId: projectId,
        flash: rejectedMessage("Revision lifecycle activation", result.status),
      });
    const confirmed = await readClient(c, deps).readProject(scope.orgId, projectId);
    const matched =
      confirmed.ok &&
      confirmed.data.revisions.some(
        (revision) => revision.id === result.value.id && revision.policyHash === result.value.policyHash,
      );
    return renderStudio(c, deps, {
      requestedId: projectId,
      loaded: confirmed,
      flash: matched
        ? {
            kind: "ok",
            message: `Lifecycle activation was confirmed by governance authority for revision ${revisionId}. Binding activation is a separate command.`,
          }
        : {
            kind: "unknown",
            message: "Lifecycle activation returned a response, but the revision coordinate could not be reloaded.",
          },
    });
  });

  app.post("/governance/tiers/bind", async (c) => {
    const form = await c.req.parseBody();
    const projectId = requiredTrimmed(formText(form, "projectId"));
    const tierId = requiredTrimmed(formText(form, "tierId"));
    if (projectId === undefined || tierId === undefined)
      return renderStudio(c, deps, {
        requestedId: projectId,
        flash: { kind: "error", message: "A nonblank project and tier are required. No command was sent." },
      });
    const scope = await loadActionScope(c, deps, projectId);
    if (scope === null) return renderStudio(c, deps, { requestedId: projectId, flash: unscopedMessage() });
    if (!scope.read.ok || !scope.read.data.tiers.some((tier) => tier.id === tierId))
      return renderStudio(c, deps, {
        requestedId: projectId,
        loaded: scope.read,
        flash: {
          kind: "error",
          message: "The tier is not present in a validated project read. No binding command was sent.",
        },
      });
    const result = await (await writeClient(c, deps)).bindTier(scope.orgId, projectId, tierId);
    if (!result.ok)
      return renderStudio(c, deps, { requestedId: projectId, flash: rejectedMessage("Tier binding", result.status) });
    const confirmed = await readClient(c, deps).readProject(scope.orgId, projectId);
    const matched =
      confirmed.ok &&
      confirmed.data.activeBinding?.id === result.value.bindingId &&
      confirmed.data.activeBinding.tierId === tierId;
    return renderStudio(c, deps, {
      requestedId: projectId,
      loaded: confirmed,
      flash: matched
        ? { kind: "ok", message: `The active binding ${result.value.bindingId} was confirmed for tier ${tierId}.` }
        : {
            kind: "unknown",
            message: "Tier binding returned a response, but the exact active binding could not be confirmed.",
          },
    });
  });
}
