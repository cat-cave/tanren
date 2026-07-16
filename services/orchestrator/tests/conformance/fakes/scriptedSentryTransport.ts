// A scripted, STATEFUL fake of the Sentry provisioning HTTP surface — a TEST
// FIXTURE (tests/ only) that lets the conformance suite drive the REAL
// `SentryProvisioner` with NO live Sentry call. It models exactly the four
// endpoints the provisioner touches:
//   GET  /api/0/organizations/{org}/projects/                     → list projects
//   POST /api/0/teams/{org}/{team}/projects/                      → create project
//   GET  /api/0/projects/{org}/{slug}/keys/                       → list client keys
//   POST /api/0/projects/{org}/{slug}/keys/                       → create client key (DSN)
// It holds the org's projects + per-project keys in memory so find-or-create is
// observable: a second create of the same slug is rejected (mirrors Sentry's real
// 409), which is exactly what proves the provisioner's idempotency (it must FIND
// the existing project, never POST a duplicate). This is the shape the real
// provider's behavior is held to — never a production stub.

import type {
  SentryProvisionHttpClient,
  SentryProvisionHttpRequest,
  SentryProvisionHttpResponse,
} from "../../../src/engine/providers/sentryProvisioner.js";

interface FakeProject {
  slug: string;
  name: string;
  platform: string;
}

export interface ScriptedSentryOptions {
  /** Pre-existing org projects (brownfield discovery + bind targets). */
  existing?: FakeProject[];
  /** Seed an existing client key for each brownfield project (default true). */
  seedKeys?: boolean;
}

/**
 * A stateful in-memory Sentry org. Each `make()` in the conformance harness gets
 * a fresh instance, so specs run isolated. Counters (`projectCreates`) let a test
 * assert no duplicate write happened across a re-provision.
 */
export class ScriptedSentryTransport implements SentryProvisionHttpClient {
  private readonly projects = new Map<string, FakeProject>();
  private readonly keys = new Map<string, string[]>();
  /** How many project-create POSTs landed — asserts idempotency mints no dup. */
  projectCreates = 0;
  /** How many client-key POSTs landed — bind must leave this at zero. */
  clientKeyCreates = 0;

  constructor(options: ScriptedSentryOptions = {}) {
    for (const project of options.existing ?? []) {
      this.projects.set(project.slug, project);
      if (options.seedKeys ?? true) {
        this.keys.set(project.slug, [`https://${project.slug}-public@o0.ingest.sentry.io/1`]);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async request(input: SentryProvisionHttpRequest): Promise<SentryProvisionHttpResponse> {
    const { method, path } = input;
    const orgProjects = /^\/api\/0\/organizations\/[^/]+\/projects\/$/u;
    const teamProjects = /^\/api\/0\/teams\/[^/]+\/([^/]+)\/projects\/$/u;
    const projectKeys = /^\/api\/0\/projects\/[^/]+\/([^/]+)\/keys\/$/u;

    if (method === "GET" && orgProjects.test(path)) {
      return { status: 200, body: [...this.projects.values()] };
    }
    if (method === "POST" && teamProjects.test(path)) {
      return this.createProject(input.body);
    }
    const keysMatch = projectKeys.exec(path);
    if (keysMatch !== undefined && keysMatch !== null) {
      const slug = decodeURIComponent(keysMatch[1]);
      return method === "GET" ? this.listKeys(slug) : this.createKey(slug);
    }
    return { status: 404, body: { detail: `unrouted ${method} ${path}` } };
  }

  private createProject(body: unknown): SentryProvisionHttpResponse {
    const payload = (body ?? {}) as { slug?: unknown; name?: unknown; platform?: unknown };
    const slug = typeof payload.slug === "string" ? payload.slug : "";
    if (slug === "" || this.projects.has(slug)) {
      // A duplicate create is a 409 in real Sentry — the provisioner must never
      // reach here for an existing slug (it finds-then-reuses). Surfacing 409
      // makes any idempotency regression a hard test failure.
      return { status: 409, body: { detail: "project slug already taken" } };
    }
    this.projectCreates += 1;
    const project: FakeProject = {
      slug,
      name: typeof payload.name === "string" ? payload.name : slug,
      platform: typeof payload.platform === "string" ? payload.platform : "other",
    };
    this.projects.set(slug, project);
    return { status: 201, body: project };
  }

  private listKeys(slug: string): SentryProvisionHttpResponse {
    const publicKeys = this.keys.get(slug) ?? [];
    return { status: 200, body: publicKeys.map((dsn) => ({ id: `key-${dsn}`, dsn: { public: dsn } })) };
  }

  private createKey(slug: string): SentryProvisionHttpResponse {
    if (!this.projects.has(slug)) {
      return { status: 404, body: { detail: "no such project" } };
    }
    const existing = this.keys.get(slug) ?? [];
    const dsn = `https://${slug}-public@o0.ingest.sentry.io/${existing.length + 1}`;
    this.clientKeyCreates += 1;
    this.keys.set(slug, [...existing, dsn]);
    return { status: 201, body: { id: `key-${dsn}`, dsn: { public: dsn } } };
  }
}
