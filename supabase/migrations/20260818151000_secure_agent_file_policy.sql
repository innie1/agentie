-- Secure direct Supabase access to agent files. The Agentie server uses service_role
-- and remains able to perform all file operations while client access is user-scoped.
ALTER TABLE agent_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_files_access_policy" ON agent_files;
DROP POLICY IF EXISTS "agent_files_authenticated_access" ON agent_files;

CREATE POLICY "agent_files_authenticated_access"
ON agent_files
FOR ALL
TO authenticated
USING (auth.uid()::text = user_id)
WITH CHECK (auth.uid()::text = user_id);

REVOKE ALL ON TABLE agent_files FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_files TO authenticated;
GRANT ALL ON TABLE agent_files TO service_role;
