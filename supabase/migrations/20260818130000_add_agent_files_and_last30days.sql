-- Agent file workspace + built-in Last30Days tool metadata.
CREATE TABLE IF NOT EXISTS agent_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL DEFAULT 'default_user',
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'text/plain',
  extension TEXT NOT NULL DEFAULT 'txt',
  content_text TEXT,
  content_base64 TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_files_user_id ON agent_files(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_files_agent_id ON agent_files(agent_id);

ALTER TABLE agent_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_files_access_policy" ON agent_files;
CREATE POLICY "agent_files_access_policy" ON agent_files FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON TABLE agent_files TO postgres, anon, authenticated, service_role;

INSERT INTO skills (id, name, description, tier, category, instructions, status)
VALUES (
  'last30days',
  'Last 30 Days Research',
  'Researches what people are actually saying about a topic in the last 30 days across multiple public sources.',
  'library',
  'research',
  'Use the Last30Days tool for current-window multi-source research. Do not improvise its output contract; pass the tool result through faithfully and preserve its citations and evidence. Use it when the user asks what is happening, trending, discussed, recommended, or debated in the last 30 days.',
  'active'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  instructions = EXCLUDED.instructions,
  status = EXCLUDED.status;
