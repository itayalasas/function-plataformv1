
-- Projects
CREATE TABLE public.fn_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fn_projects TO authenticated;
GRANT ALL ON public.fn_projects TO service_role;
ALTER TABLE public.fn_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own projects all" ON public.fn_projects
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Functions (current draft)
CREATE TABLE public.fn_functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.fn_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  code text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fn_functions TO authenticated;
GRANT ALL ON public.fn_functions TO service_role;
ALTER TABLE public.fn_functions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own functions all" ON public.fn_functions
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Versions
CREATE TABLE public.fn_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id uuid NOT NULL REFERENCES public.fn_functions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version int NOT NULL,
  code text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fn_versions TO authenticated;
GRANT ALL ON public.fn_versions TO service_role;
ALTER TABLE public.fn_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own versions all" ON public.fn_versions
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Secrets (per project)
CREATE TABLE public.fn_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.fn_projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fn_secrets TO authenticated;
GRANT ALL ON public.fn_secrets TO service_role;
ALTER TABLE public.fn_secrets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own secrets all" ON public.fn_secrets
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Invocation logs
CREATE TABLE public.fn_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id uuid NOT NULL REFERENCES public.fn_functions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  method text NOT NULL,
  status int,
  duration_ms int,
  request jsonb,
  response jsonb,
  logs jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fn_logs TO authenticated;
GRANT ALL ON public.fn_logs TO service_role;
ALTER TABLE public.fn_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own logs all" ON public.fn_logs
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX fn_logs_function_created_idx ON public.fn_logs (function_id, created_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_fn_functions_updated
BEFORE UPDATE ON public.fn_functions
FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
