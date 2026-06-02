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

  const listBody = (): unknown =>
    flavor === "vercel"
      ? { projects: [...apps.values()].map((app) => ({ id: app.id, name: app.name })) }
      : { apps: [...apps.values()].map((app) => ({ id: app.id, name: app.name })) };

  const transport: ScriptedDeployTransport = {
    appNames: () => [...apps.keys()],
    bearersSeen,
    envByApp: () => structuredClone(envByApp),
    async request(req: DeployHttpRequest): Promise<DeployHttpResponse> {
      bearersSeen.push(req.headers["authorization"] ?? "");

      if (req.method === "GET") {
        return okResponse(listBody());
      }
      // Set-env requests (P-APP-ENV-2): Vercel `/v10/projects/{id}/env`, Fly
      // `/v1/apps/{name}/secrets`. Captured into envByApp so the test can assert the
      // right KEYS + VALUES reached the transport (and nowhere else).
      const setEnv = parseSetEnv(flavor, req);
      if (setEnv !== undefined) {
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
