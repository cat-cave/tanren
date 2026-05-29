// P2A-0013: dispatch handlers for the new product-API CLI verbs. Keeps the
// growing surface out of `cli/src/main.ts` so that file stays under the
// 500-line architecture cap.

import { behaviorsCreate, behaviorsGet, behaviorsList } from "./behaviors/index.js";
import { credentialsCreate, credentialsDelete, credentialsGet, credentialsList } from "./credentials/index.js";
import { milestonesCreate, milestonesGet, milestonesList } from "./milestones/index.js";
import { orgsConfigSet, orgsGet, orgsList } from "./orgs/index.js";
import { personasCreate, personasGet, personasList } from "./personas/index.js";
import { projectsCreate, projectsGet, projectsLink, projectsList } from "./projects/index.js";
import { specsCreate, specsGet, specsList, specsRun } from "./specs/index.js";

const HANDLERS: Record<string, (rest: string[]) => Promise<void>> = {
  "orgs list": orgsList,
  "orgs get": orgsGet,
  "orgs config-set": orgsConfigSet,
  "projects list": projectsList,
  "projects create": projectsCreate,
  "projects get": projectsGet,
  "projects link": projectsLink,
  "specs list": specsList,
  "specs create": specsCreate,
  "specs get": specsGet,
  "specs run": specsRun,
  "personas list": personasList,
  "personas create": personasCreate,
  "personas get": personasGet,
  "behaviors list": behaviorsList,
  "behaviors create": behaviorsCreate,
  "behaviors get": behaviorsGet,
  "milestones list": milestonesList,
  "milestones create": milestonesCreate,
  "milestones get": milestonesGet,
  "credentials list": credentialsList,
  "credentials create": credentialsCreate,
  "credentials get": credentialsGet,
  "credentials delete": credentialsDelete,
};

export function findProductHandler(
  command: string,
  subcommand: string | undefined,
): ((rest: string[]) => Promise<void>) | undefined {
  if (subcommand === undefined) return undefined;
  return HANDLERS[`${command} ${subcommand}`];
}

export function listProductCommands(): string[] {
  return Object.keys(HANDLERS).sort();
}
