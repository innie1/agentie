-- Existing agents get the built-in tools immediately after this migration.
UPDATE agents
SET allowed_plugins = (
  SELECT jsonb_agg(DISTINCT value)
  FROM jsonb_array_elements_text(COALESCE(agents.allowed_plugins, '[]'::jsonb) || '["files","last30days"]'::jsonb) AS value
);

-- Attach Last30Days to every existing agent as an enabled library skill.
INSERT INTO agent_skills (agent_id, skill_id)
SELECT a.id, 'last30days'
FROM agents a
ON CONFLICT (agent_id, skill_id) DO NOTHING;
