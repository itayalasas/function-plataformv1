CREATE TABLE IF NOT EXISTS invocation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  function_id uuid NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  kind text NOT NULL DEFAULT 'manual',
  method text NOT NULL,
  path text NOT NULL,
  target text,
  status int,
  duration_ms int,
  error text,
  request jsonb,
  response jsonb,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logs_fn ON invocation_logs(function_id, created_at DESC);

ALTER TABLE invocation_logs ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE invocation_logs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'manual';
ALTER TABLE invocation_logs ADD COLUMN IF NOT EXISTS target text;
ALTER TABLE invocation_logs ADD COLUMN IF NOT EXISTS request jsonb;
ALTER TABLE invocation_logs ADD COLUMN IF NOT EXISTS response jsonb;
ALTER TABLE invocation_logs ADD COLUMN IF NOT EXISTS meta jsonb;

CREATE INDEX IF NOT EXISTS idx_logs_proj ON invocation_logs(project_id, created_at DESC);
