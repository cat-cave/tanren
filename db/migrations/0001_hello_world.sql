CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  runner_image TEXT NOT NULL DEFAULT 'ghcr.io/cat-cave/tanren-runner:v0',
  allocator TEXT NOT NULL DEFAULT 'local-docker',
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id TEXT
);

CREATE TABLE IF NOT EXISTS specs (
  spec_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(spec_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  trigger TEXT NOT NULL,
  branch TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  outcome TEXT,
  pr_url TEXT,
  tenant_id TEXT,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_task_id TEXT REFERENCES tasks(task_id),
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  outcome TEXT,
  failure_kind TEXT,
  agent_kind TEXT NOT NULL,
  cli TEXT NOT NULL,
  model TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  tenant_id TEXT,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS cost_records (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  cli TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(14,6) NOT NULL,
  pricing_mode TEXT NOT NULL CHECK (pricing_mode IN ('per_token','opportunity_cost','subscription_window')),
  cost_source TEXT NOT NULL CHECK (cost_source IN ('provider_direct','ccusage','codexbar','opportunity_computed')),
  cost_source_raw JSONB NOT NULL DEFAULT '{}',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id TEXT,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id TEXT,
  task_id TEXT,
  spec_id TEXT,
  project_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  tenant_id TEXT,
  user_id TEXT
);

CREATE INDEX IF NOT EXISTS events_run_id_ts ON events(run_id, ts);
CREATE INDEX IF NOT EXISTS events_event_type ON events(event_type);

CREATE TABLE IF NOT EXISTS runners (
  runner_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(run_id),
  project_id TEXT REFERENCES projects(project_id),
  allocator TEXT NOT NULL,
  status TEXT NOT NULL,
  ssh_host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL,
  host_key_fingerprint TEXT NOT NULL,
  image_sha TEXT NOT NULL,
  container_id TEXT,
  hcloud_server_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  tenant_id TEXT
);

CREATE TABLE IF NOT EXISTS rate_limit_observations (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_id TEXT REFERENCES tasks(task_id),
  call_site TEXT NOT NULL,
  provider TEXT NOT NULL,
  observation TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  retry_after_s INTEGER,
  tenant_id TEXT,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  tenant_id TEXT,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS job_queue (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT,
  task_kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  tenant_id TEXT,
  user_id TEXT
);

CREATE INDEX IF NOT EXISTS job_queue_pending ON job_queue(task_kind, enqueued_at) WHERE status = 'pending';
