// A scripted in-memory `DeployHttpTransport` (TEST FIXTURE — tests/ only) that
// emulates the subset of the Vercel / Fly REST APIs the deploy provisioners drive,
// so the conformance suite exercises the FULL find-or-create lifecycle (list →
// create → list-reflects-it) with NO real Vercel/Fly calls. It models a provider-
// side app set in a Map keyed by app name (the globally-unique handle both APIs
// use), records the bearer tokens it saw (so a test can prove the token VALUE is
// used as a bearer but never echoed into a response/artifact), and seeds existing
// apps for the brownfield discover/bind path.

import type {
  DeployHttpRequest,
  DeployHttpResponse,
  DeployHttpTransport,
} from "../../../src/engine/provisioners/deployTransport.js";

export type DeployFlavor = "vercel" | "fly";

interface StoredApp {
  id: string;
  name: string;
}

export interface ScriptedDeployTransport extends DeployHttpTransport {
  /** Names of apps currently known to the emulated provider. */
  appNames(): string[];
  /** Every bearer token the transport observed (to assert it is never leaked). */
  bearersSeen: string[];
  /**
   * The env vars the emulated provider received via a set-env request, by appId →
   * { KEY: value }. This is the ONLY place a test can observe the runtime VALUES —
   * proving they reached the deploy transport and nowhere else.
   */
  envByApp(): Record<string, Record<string, string>>;
  /**
   * Every deploy TRIGGER the emulated provider received (the load-bearing "a deploy
   * actually happened" signal): the target app id + the deploy request body, so a
   * test can assert the deployment endpoint was hit + the merged git ref reached it.
   */
  deploysTriggered(): { appId: string; body: Record<string, unknown> }[];
  /**
   * Script the status sequence the emulated provider reports for a deployment id on
   * successive `getDeployment` polls (the verify poll). The LAST entry is repeated
   * once exhausted, so a `[…,"READY"]` sequence stays READY. Lets a test drive
   * verify through BUILDING→READY (poll-to-ready) or to a failure terminal.
   */
  scriptDeploymentStates(deploymentId: string, states: string[]): void;
  /** How many `getDeployment` status polls the transport served for a deployment id. */
  statusPolls(deploymentId: string): number;
  /**
   * The ORDERED kind of each mutating request the transport served (`set_env` |
   * `deploy_trigger` | `create`), so a test can assert ORDERING — e.g. that the runtime
   * env was attached (`set_env`) BEFORE the deploy was triggered (`deploy_trigger`).
   */
  requestLog(): Array<"set_env" | "deploy_trigger" | "create">;
}

/**
 * Build a scripted transport for a provider `flavor`, optionally pre-seeded with
 * existing apps (brownfield). The emulator understands GET-list and POST-create
 * for both Vercel (`/v9/projects`) and Fly (`/v1/apps`); a POST whose app name
 * already exists is REJECTED (409), matching the providers. unique-name rule.
 */
export function scriptedDeployTransport(flavor: DeployFlavor, seedNames: string[] = []): ScriptedDeployTransport {
  const apps = new Map<string, StoredApp>();
  let counter = 0;
  const add = (name: string): StoredApp => {
    counter += 1;
    const app = { id: `${flavor}_app_${counter}`, name };
    apps.set(name, app);
    return app;
  };
  for (const name of seedNames) {
    add(name);
  }

  const bearersSeen: string[] = [];
  // appId → { KEY: value } received via set-env. Mirrors the provider holding the
  // app's environment, so a test can prove the runtime values reached the transport.
  const envByApp: Record<string, Record<string, string>> = {};
  // The deploy triggers the provider received (app id + request body), so a test can
  // prove a real deploy was triggered (not just an empty app created).
  const triggered: { appId: string; body: Record<string, unknown> }[] = [];
  let deployCounter = 0;
  // Scripted status sequences for the verify poll: deploymentId → state list (the
  // last entry repeats once exhausted). `pollsByDeployment` counts polls served.
  const stateScripts = new Map<string, string[]>();
  const pollsByDeployment = new Map<string, number>();
  // Ordered kinds of the mutating requests served, so a test can assert env-before-trigger.
  const reqLog: Array<"set_env" | "deploy_trigger" | "create"> = [];

  const listBody = (): unknown =>
    flavor === "vercel"
      ? { projects: [...apps.values()].map((app) => ({ id: app.id, name: app.name })) }
      : { apps: [...apps.values()].map((app) => ({ id: app.id, name: app.name })) };

  const transport: ScriptedDeployTransport = {
    appNames: () => [...apps.keys()],
    bearersSeen,
    envByApp: () => structuredClone(envByApp),
    deploysTriggered: () => structuredClone(triggered),
    requestLog: () => [...reqLog],
    scriptDeploymentStates: (deploymentId, states) => {
      stateScripts.set(deploymentId, [...states]);
    },
    statusPolls: (deploymentId) => pollsByDeployment.get(deploymentId) ?? 0,
    async request(req: DeployHttpRequest): Promise<DeployHttpResponse> {
      bearersSeen.push(req.headers["authorization"] ?? "");

      if (req.method === "DELETE") {
        // App destroy (task #78 derive-rollback compensation): Vercel
        // `DELETE /v9/projects/{id}`, Fly `DELETE /v1/apps/{name}`. The contract is
        // IDEMPOTENT — a 404 (already-gone) is a successful no-op. We resolve the
        // target either by id (Vercel) or name (Fly), remove it from the in-memory
        // app set, and return 204; an unknown id returns 404.
        const path = req.url.split("?")[0] ?? "";
        if (flavor === "vercel") {
          const match = /\/v9\/projects\/([^/]+)$/u.exec(path);
          if (match === null) {
            return { status: 405, ok: false, json: undefined, text: "method not allowed" };
          }
          const targetId = decodeURIComponent(match[1] ?? "");
          for (const [name, app] of apps) {
            if (app.id === targetId) {
              apps.delete(name);
              return { status: 204, ok: true, json: undefined, text: "" };
            }
          }
          return { status: 404, ok: false, json: undefined, text: "not found" };
        }
        const match = /\/v1\/apps\/([^/]+)$/u.exec(path);
        if (match === null) {
          return { status: 405, ok: false, json: undefined, text: "method not allowed" };
        }
        const targetName = decodeURIComponent(match[1] ?? "");
        if (apps.delete(targetName)) {
          return { status: 202, ok: true, json: undefined, text: "" };
        }
        return { status: 404, ok: false, json: undefined, text: "not found" };
      }

      if (req.method === "GET") {
        // A deployment-status GET (the verify poll): Vercel `/v13/deployments/{id}`,
        // Fly `/v1/apps/{name}/machines/{id}`. Served from the scripted state
        // sequence (default READY when no script) so verify can poll to a terminal.
        const status = parseStatusRead(flavor, req);
        if (status !== undefined) {
          const served = pollsByDeployment.get(status.deploymentId) ?? 0;
          pollsByDeployment.set(status.deploymentId, served + 1);
          const script = stateScripts.get(status.deploymentId) ?? [flavor === "vercel" ? "READY" : "started"];
          const state = script[Math.min(served, script.length - 1)] as string;
          return flavor === "vercel"
            ? okResponse({ readyState: state, url: `${status.appOrDeploymentRef}.vercel.app` })
            : okResponse({ state });
        }
        return okResponse(listBody());
      }
      // Deploy TRIGGER requests: Vercel `/v13/deployments`, Fly
      // `/v1/apps/{name}/machines`. The provider builds + releases the merged ref;
      // captured into `triggered` so a test can prove the deploy actually fired.
      const deploy = parseDeploy(flavor, req);
      if (deploy !== undefined) {
        deployCounter += 1;
        reqLog.push("deploy_trigger");
        triggered.push({ appId: deploy.appId, body: deploy.body });
        const id = `${flavor}_deploy_${deployCounter}`;
        return flavor === "vercel"
          ? okResponse({ id, url: `${deploy.appId}.vercel.app`, readyState: "QUEUED" }, 200)
          : okResponse({ id, state: "started" }, 200);
      }
      // Set-env requests: Vercel `/v10/projects/{id}/env`, Fly
      // `/v1/apps/{name}/secrets`. Captured into envByApp so the test can assert the
      // right KEYS + VALUES reached the transport (and nowhere else).
      const setEnv = parseSetEnv(flavor, req);
      if (setEnv !== undefined) {
        reqLog.push("set_env");
        const bucket = (envByApp[setEnv.appId] ??= {});
        Object.assign(bucket, setEnv.vars);
        return okResponse({}, flavor === "vercel" ? 201 : 200);
      }
      if (req.method === "POST") {
        const name = createName(flavor, req.body);
        // Faithful to Vercel/Fly: a duplicate app name is REJECTED (the names are
        // unique per team/org). So a non-idempotent provisioner that POSTs without a
        // prior list-then-reuse gets a hard 409 — the idempotency conformance spec
        // would then fail, rather than the fake silently masking the duplicate.
        if (apps.has(name)) {
          return { status: 409, ok: false, json: undefined, text: `app name '${name}' already exists` };
        }
        reqLog.push("create");
        const app = add(name);
        // Vercel returns 200 on create; Fly returns 201 — both carry id + name.
        const status = flavor === "vercel" ? 200 : 201;
        return okResponse({ id: app.id, name: app.name }, status);
      }
      return { status: 405, ok: false, json: undefined, text: "method not allowed" };
    },
  };
  return transport;
}

function okResponse(json: unknown, status = 200): DeployHttpResponse {
  return { status, ok: true, json, text: "" };
}

function createName(flavor: DeployFlavor, body: unknown): string {
  const record = (body ?? {}) as Record<string, unknown>;
  const name = flavor === "vercel" ? record["name"] : record["app_name"];
  if (typeof name !== "string" || name === "") {
    throw new Error("scripted deploy transport: create request carried no app name");
  }
  return name;
}

/**
 * Recognize a set-env request and extract the target appId + the { KEY: value }
 * payload. Vercel sends ONE var per POST to `/v10/projects/{id}/env`; Fly sends all
 * vars in ONE POST to `/v1/apps/{name}/secrets` as `{ secrets: { KEY: value } }`.
 * Returns undefined when the request is not a set-env (so the create path runs).
 */
function parseSetEnv(
  flavor: DeployFlavor,
  req: DeployHttpRequest,
): { appId: string; vars: Record<string, string> } | undefined {
  if (req.method !== "POST") {
    return undefined;
  }
  const path = req.url.split("?")[0] ?? "";
  const record = (req.body ?? {}) as Record<string, unknown>;
  if (flavor === "vercel") {
    const match = /\/v10\/projects\/([^/]+)\/env$/u.exec(path);
    if (match === null) {
      return undefined;
    }
    const appId = decodeURIComponent(match[1] as string);
    const key = record["key"];
    const value = record["value"];
    if (typeof key !== "string" || typeof value !== "string") {
      throw new TypeError("scripted deploy transport: vercel env request missing key/value");
    }
    return { appId, vars: { [key]: value } };
  }
  const match = /\/v1\/apps\/([^/]+)\/secrets$/u.exec(path);
  if (match === null) {
    return undefined;
  }
  const appId = decodeURIComponent(match[1] as string);
  const secrets = (record["secrets"] ?? {}) as Record<string, unknown>;
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value !== "string") {
      throw new TypeError(`scripted deploy transport: fly secret '${key}' is not a string`);
    }
    vars[key] = value;
  }
  return { appId, vars };
}

/**
 * Recognize a deploy-TRIGGER request and extract the target appId + the request
 * body. Vercel POSTs `/v13/deployments` carrying `project` (the app id) + a
 * `gitSource`; Fly POSTs `/v1/apps/{name}/machines` (the app in the path). Returns
 * undefined for any other POST (so the create-app branch still runs).
 */
/**
 * Recognize a deployment-STATUS read (the verify poll) and extract the deployment id
 * + an app-or-deployment ref used to shape the URL field. Vercel GETs
 * `/v13/deployments/{id}`; Fly GETs `/v1/apps/{name}/machines/{id}`. Returns
 * undefined for the bare list GET (so it falls through to `listBody`).
 */
function parseStatusRead(
  flavor: DeployFlavor,
  req: DeployHttpRequest,
): { deploymentId: string; appOrDeploymentRef: string } | undefined {
  if (req.method !== "GET") {
    return undefined;
  }
  const path = req.url.split("?")[0] ?? "";
  if (flavor === "vercel") {
    const match = /\/v13\/deployments\/([^/]+)$/u.exec(path);
    if (match === null) {
      return undefined;
    }
    const id = decodeURIComponent(match[1] as string);
    return { deploymentId: id, appOrDeploymentRef: id };
  }
  const match = /\/v1\/apps\/([^/]+)\/machines\/([^/]+)$/u.exec(path);
  if (match === null) {
    return undefined;
  }
  return {
    deploymentId: decodeURIComponent(match[2] as string),
    appOrDeploymentRef: decodeURIComponent(match[1] as string),
  };
}

/**
 * Validate a Vercel v13 `gitSource` the way the live API does: the github variant
 * requires `type:"github"`, an `org` (the repo OWNER), a BARE `repo` name (NOT a
 * `owner/name` slug), a `ref`, and the commit `sha`. A malformed gitSource (e.g. the
 * old `{ type:"github", repo:"owner/name", ref:<sha> }`) is REJECTED — this is what
 * makes the fake encode the REAL contract instead of rubber-stamping any shape.
 */
function assertVercelGitSource(gitSource: unknown): void {
  if (typeof gitSource !== "object" || gitSource === null) {
    throw new TypeError("scripted deploy transport: vercel deployment request missing `gitSource`");
  }
  const gs = gitSource as Record<string, unknown>;
  if (gs["type"] !== "github") {
    throw new TypeError(
      `scripted deploy transport: vercel gitSource.type must be 'github', got '${String(gs["type"])}'`,
    );
  }
  for (const field of ["org", "repo", "ref", "sha"] as const) {
    if (typeof gs[field] !== "string" || gs[field] === "") {
      throw new TypeError(`scripted deploy transport: vercel gitSource.${field} must be a non-empty string`);
    }
  }
  if ((gs["repo"] as string).includes("/")) {
    throw new TypeError(
      `scripted deploy transport: vercel gitSource.repo must be a BARE repo name, not a 'owner/name' slug (got '${String(gs["repo"])}')`,
    );
  }
}

function parseDeploy(
  flavor: DeployFlavor,
  req: DeployHttpRequest,
): { appId: string; body: Record<string, unknown> } | undefined {
  if (req.method !== "POST") {
    return undefined;
  }
  const path = req.url.split("?")[0] ?? "";
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (flavor === "vercel") {
    if (!path.endsWith("/v13/deployments")) {
      return undefined;
    }
    const appId = body["project"];
    if (typeof appId !== "string" || appId === "") {
      throw new TypeError("scripted deploy transport: vercel deployment request missing `project`");
    }
    // Faithful to the live v13 API: REJECT a malformed gitSource the way Vercel does
    // (a 400). The github variant is `{ type:"github", org, repo, ref, sha }` — `org`
    // (owner) + a BARE `repo` name are SEPARATE required fields; the old `repo:
    // "owner/name"` (no `org`) shape was silently accepted by this fake, making the
    // suite falsely green. Now a wrong shape surfaces as a hard error here, so the
    // contract test actually guards the body shape.
    assertVercelGitSource(body["gitSource"]);
    return { appId, body };
  }
  const match = /\/v1\/apps\/([^/]+)\/machines$/u.exec(path);
  if (match === null) {
    return undefined;
  }
  return { appId: decodeURIComponent(match[1] as string), body };
}
