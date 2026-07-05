CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  container_app_name text,
  fqdn text,
  admin_token text,
  log_token text,
  last_deployed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  runtime text NOT NULL DEFAULT 'deno',
  UNIQUE (owner_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_app_name text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS fqdn text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS admin_token text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS log_token text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deployed_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime text NOT NULL DEFAULT 'deno';

CREATE TABLE IF NOT EXISTS functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  entrypoint text NOT NULL DEFAULT 'index.ts',
  status text NOT NULL DEFAULT 'draft',
  current_deployment_id uuid,
  container_app_name text,
  fqdn text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_functions_project ON functions(project_id);

CREATE TABLE IF NOT EXISTS function_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id uuid NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  path text NOT NULL,
  kind text NOT NULL DEFAULT 'file',
  content text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (function_id, path)
);

CREATE INDEX IF NOT EXISTS idx_files_fn ON function_files(function_id);

ALTER TABLE function_files ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'file';

CREATE TABLE IF NOT EXISTS secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  name text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS function_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id uuid NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  name text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (function_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tokens_fn ON function_tokens(function_id);

CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id uuid REFERENCES functions(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  version int NOT NULL,
  container_app_name text NOT NULL,
  fqdn text,
  status text NOT NULL DEFAULT 'provisioning',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime text;
ALTER TABLE deployments ALTER COLUMN function_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id);
