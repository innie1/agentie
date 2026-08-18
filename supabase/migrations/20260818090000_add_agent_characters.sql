-- Agentie Character System
-- Persistent persona data for every agent.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS character JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN agents.character IS
  'Persistent character definition: personality, tone, communication_style, values, behaviors, quirks, and boundaries.';

CREATE INDEX IF NOT EXISTS idx_agents_character ON agents USING GIN (character);

NOTIFY pgrst, 'reload schema';
