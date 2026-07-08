ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS deployment_profile jsonb NOT NULL DEFAULT '{}'::jsonb;
