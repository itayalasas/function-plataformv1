ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS progress_percent integer NOT NULL DEFAULT 0;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS progress_step text;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS progress_message text;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS progress_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;
