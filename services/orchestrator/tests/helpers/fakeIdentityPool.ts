import type pg from "pg";

interface UserRow {
  id: string;
  provider: string;
  provider_subject: string;
  login: string | null;
  email: string | null;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface OrgRow {
  id: string;
  kind: string;
  external_id: string;
  login: string;
  display_name: string;
  created_at: Date;
  updated_at: Date;
}

interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: string;
  joined_at: Date;
}

interface ProjectMemberRow {
  project_id: string;
  user_id: string;
  role: string;
  joined_at: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  expires_at: Date;
  created_at: Date;
  ip: string | null;
  user_agent: string | null;
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scopes: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

export interface FakeIdentityPool {
  users: Map<string, UserRow>;
  orgs: Map<string, OrgRow>;
  orgMembers: Map<string, OrgMemberRow>;
  projects: Map<string, { projectId: string; orgId: string | null }>;
  projectMembers: Map<string, ProjectMemberRow>;
  sessions: Map<string, SessionRow>;
  apiTokens: Map<string, ApiTokenRow>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  asPgPool: () => pg.Pool;
}

export function createFakeIdentityPool(): FakeIdentityPool {
  const state: FakeIdentityPool = {
    users: new Map(),
    orgs: new Map(),
    orgMembers: new Map(),
    projects: new Map(),
    projectMembers: new Map(),
    sessions: new Map(),
    apiTokens: new Map(),
    query: async (sql, params = []) => handleQuery(state, sql, params),
    asPgPool: () => state as unknown as pg.Pool
  };
  return state;
}

async function handleQuery(
  state: FakeIdentityPool,
  sql: string,
  params: unknown[]
): Promise<{ rows: unknown[]; rowCount: number }> {
  const trimmed = sql.trim();

  // users
  if (trimmed.startsWith("SELECT * FROM users WHERE provider = $1 AND provider_subject = $2")) {
    const rows = [...state.users.values()].filter(
      (u) => u.provider === String(params[0]) && u.provider_subject === String(params[1])
    );
    return { rows, rowCount: rows.length };
  }
  if (trimmed.startsWith("UPDATE users SET login")) {
    const user = state.users.get(String(params[3]));
    if (user !== undefined) {
      user.login = (params[0] as string | null) ?? null;
      user.email = (params[1] as string | null) ?? null;
      user.display_name = (params[2] as string | null) ?? null;
      user.updated_at = new Date();
    }
    return { rows: [], rowCount: user === undefined ? 0 : 1 };
  }
  if (trimmed.startsWith("INSERT INTO users")) {
    const row: UserRow = {
      id: String(params[0]),
      provider: String(params[1]),
      provider_subject: String(params[2]),
      login: (params[3] as string | null) ?? null,
      email: (params[4] as string | null) ?? null,
      display_name: (params[5] as string | null) ?? null,
      created_at: new Date(),
      updated_at: new Date()
    };
    state.users.set(row.id, row);
    return { rows: [row], rowCount: 1 };
  }

  // organizations
  if (trimmed.startsWith("SELECT * FROM organizations WHERE kind = $1 AND external_id = $2")) {
    const rows = [...state.orgs.values()].filter(
      (o) => o.kind === String(params[0]) && o.external_id === String(params[1])
    );
    return { rows, rowCount: rows.length };
  }
  if (trimmed.startsWith("UPDATE organizations SET login")) {
    const org = state.orgs.get(String(params[2]));
    if (org !== undefined) {
      org.login = String(params[0]);
      org.display_name = String(params[1]);
      org.updated_at = new Date();
    }
    return { rows: [], rowCount: org === undefined ? 0 : 1 };
  }
  if (trimmed.startsWith("INSERT INTO organizations")) {
    const row: OrgRow = {
      id: String(params[0]),
      kind: String(params[1]),
      external_id: String(params[2]),
      login: String(params[3]),
      display_name: String(params[4]),
      created_at: new Date(),
      updated_at: new Date()
    };
    state.orgs.set(row.id, row);
    return { rows: [row], rowCount: 1 };
  }

  // org_members
  if (trimmed.startsWith("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")) {
    const key = `${String(params[0])}:${String(params[1])}`;
    const row = state.orgMembers.get(key);
    return { rows: row === undefined ? [] : [{ role: row.role }], rowCount: row === undefined ? 0 : 1 };
  }
  if (trimmed.startsWith("SELECT count(*)::text AS count FROM org_members WHERE org_id = $1")) {
    const orgId = String(params[0]);
    const count = [...state.orgMembers.values()].filter((m) => m.org_id === orgId).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }
  if (trimmed.startsWith("INSERT INTO org_members")) {
    const row: OrgMemberRow = {
      org_id: String(params[0]),
      user_id: String(params[1]),
      role: String(params[2]),
      joined_at: new Date()
    };
    state.orgMembers.set(`${row.org_id}:${row.user_id}`, row);
    return { rows: [], rowCount: 1 };
  }

  // project_members
  if (trimmed.startsWith("SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2")) {
    const key = `${String(params[0])}:${String(params[1])}`;
    const row = state.projectMembers.get(key);
    return { rows: row === undefined ? [] : [{ role: row.role }], rowCount: row === undefined ? 0 : 1 };
  }
  if (trimmed.startsWith("INSERT INTO project_members")) {
    const row: ProjectMemberRow = {
      project_id: String(params[0]),
      user_id: String(params[1]),
      role: String(params[2]),
      joined_at: new Date()
    };
    state.projectMembers.set(`${row.project_id}:${row.user_id}`, row);
    return { rows: [], rowCount: 1 };
  }

  // projects
  if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
    const project = state.projects.get(String(params[0]));
    return {
      rows: project === undefined ? [] : [{ org_id: project.orgId }],
      rowCount: project === undefined ? 0 : 1
    };
  }

  // sessions
  if (trimmed.startsWith("INSERT INTO sessions")) {
    const row: SessionRow = {
      id: String(params[0]),
      user_id: String(params[1]),
      csrf_token: String(params[2]),
      expires_at: params[3] as Date,
      created_at: new Date(),
      ip: (params[4] as string | null) ?? null,
      user_agent: (params[5] as string | null) ?? null
    };
    state.sessions.set(row.id, row);
    return { rows: [], rowCount: 1 };
  }
  if (trimmed.startsWith("SELECT * FROM sessions WHERE id = $1")) {
    const row = state.sessions.get(String(params[0]));
    return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
  }
  if (trimmed.startsWith("DELETE FROM sessions WHERE id = $1")) {
    state.sessions.delete(String(params[0]));
    return { rows: [], rowCount: 1 };
  }

  // api_tokens
  if (trimmed.startsWith("INSERT INTO api_tokens")) {
    const row: ApiTokenRow = {
      id: String(params[0]),
      user_id: String(params[1]),
      name: String(params[2]),
      token_hash: String(params[3]),
      scopes: params[4] as string[],
      expires_at: (params[5] as Date | null) ?? null,
      last_used_at: null,
      created_at: new Date()
    };
    state.apiTokens.set(row.id, row);
    return { rows: [], rowCount: 1 };
  }
  if (trimmed.startsWith("SELECT * FROM api_tokens WHERE token_hash = $1")) {
    const rows = [...state.apiTokens.values()].filter((t) => t.token_hash === String(params[0]));
    return { rows, rowCount: rows.length };
  }
  if (trimmed.startsWith("UPDATE api_tokens SET last_used_at = now() WHERE id = $1")) {
    const token = state.apiTokens.get(String(params[0]));
    if (token !== undefined) {
      token.last_used_at = new Date();
    }
    return { rows: [], rowCount: token === undefined ? 0 : 1 };
  }

  return { rows: [], rowCount: 0 };
}
