ALTER TABLE public.agents
ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.agents
SET tags = '[]'::jsonb
WHERE tags IS NULL;

CREATE INDEX IF NOT EXISTS idx_agents_tags
ON public.agents USING GIN (tags);
