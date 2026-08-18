-- ============================================================================
-- AGENTIE DATABASE SCHEMA (SUPABASE / POSTGRESQL)
-- Supports: Plugins, User Plugins, Agents (Auto-Naming & Unique), Tasks, Routines, Memory, Handoffs, Logs
-- ============================================================================

-- 1. PLUGINS (Catalog)
CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon_url TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    auth_type TEXT NOT NULL CHECK (auth_type IN ('oauth', 'api_key')),
    scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'beta')),
    actions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. USER_PLUGINS (User Added Plugins & Encrypted Credentials)
CREATE TABLE IF NOT EXISTS user_plugins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL DEFAULT 'default_user',
    plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    credentials JSONB NOT NULL, -- Encrypted access_token / refresh_token / api_key
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, plugin_id)
);

-- 3. AGENTS TABLE (WITH AUTO-NAMING & UNIQUE CASE-INSENSITIVE NAME CONSTRAINT)
CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL DEFAULT 'default_user',
    name TEXT NOT NULL,
    name_source TEXT NOT NULL DEFAULT 'auto' CHECK (name_source IN ('auto', 'user')),
    role TEXT NOT NULL,
    goal TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    allowed_plugins JSONB NOT NULL DEFAULT '[]'::jsonb,
    auto_approved_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique constraint: No two agents under same user can share a name (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_lower_name ON agents (user_id, lower(name));

-- 4. ROUTINES TABLE (TEACH MODE & SCHEDULED TRIGGERS)
CREATE TABLE IF NOT EXISTS routines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    steps JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of { plugin_id, action, params, dynamic_keys }
    trigger_pattern JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of natural language trigger phrases
    schedule TEXT DEFAULT NULL, -- Cron expression (e.g. '0 13 * * *')
    schedule_human TEXT DEFAULT NULL, -- e.g. 'Every day at 1:00 PM'
    dynamic_fields JSONB NOT NULL DEFAULT '{}'::jsonb, -- Parameter interpolation rules
    success_count INT NOT NULL DEFAULT 0,
    last_run_at TIMESTAMPTZ DEFAULT NULL,
    last_run_status TEXT DEFAULT NULL, -- 'success', 'failed', 'needs_approval'
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. TASKS TABLE
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL DEFAULT 'default_user',
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    instruction TEXT NOT NULL,
    context JSONB DEFAULT '{}'::jsonb,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scheduled', 'handoff', 'routine')),
    routine_id UUID REFERENCES routines(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'needs_approval', 'paused', 'done', 'failed')),
    current_step INT DEFAULT 0,
    steps JSONB DEFAULT '[]'::jsonb,
    paused_step_data JSONB DEFAULT NULL,
    result TEXT DEFAULT NULL,
    result_type TEXT DEFAULT 'fact', -- 'fact', 'task_complete', 'irreversible_pending', 'activity_trace', 'failure'
    result_payload JSONB DEFAULT '{}'::jsonb, -- Stores saved loop state, structured action logs, summaries
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. AGENT MEMORY (Persistent Key-Value Store)
CREATE TABLE IF NOT EXISTS agent_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. TASK HANDOFFS (Agent-to-Agent Delegation Tracking)
CREATE TABLE IF NOT EXISTS task_handoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    to_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    note TEXT NOT NULL,
    context_summary TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. ACTION AUDIT LOG (Full Traceability & Guardrails)
CREATE TABLE IF NOT EXISTS action_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    plugin_id TEXT REFERENCES plugins(id),
    action TEXT NOT NULL,
    params JSONB DEFAULT '{}'::jsonb,
    result JSONB DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed', 'blocked_guardrail', 'approved')),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. PENDING_AUTH (OAuth state tracking & security)
CREATE TABLE IF NOT EXISTS pending_auth (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL DEFAULT 'default_user',
    plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    state TEXT NOT NULL UNIQUE,
    code_verifier TEXT DEFAULT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10. MODELS_CONFIG (Dynamic OpenRouter model tiering & freshness catalog)
CREATE TABLE IF NOT EXISTS models_config (
    id TEXT PRIMARY KEY, -- 'fast', 'reasoning', 'classifier' or custom tier key
    tier TEXT NOT NULL, -- 'fast' | 'reasoning'
    model_id TEXT NOT NULL, -- e.g. 'google/gemini-2.0-flash-001'
    provider TEXT DEFAULT NULL,
    speed_score NUMERIC DEFAULT NULL,
    context_length INT DEFAULT NULL,
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 11. TOKEN_USAGE (Raw audit log for all OpenRouter model inference calls)
CREATE TABLE IF NOT EXISTS token_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL DEFAULT 'default_user',
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    model_id TEXT NOT NULL,
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    total_tokens INT NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10, 6) DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_user_plugins_user_id ON user_plugins(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_routines_agent_id ON routines(agent_id);
CREATE INDEX IF NOT EXISTS idx_routines_status_schedule ON routines(status, schedule);
CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent_id ON agent_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_action_log_plugin_id ON action_log(plugin_id);
CREATE INDEX IF NOT EXISTS idx_pending_auth_state ON pending_auth(state);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent_id ON token_usage(agent_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_user_created ON token_usage(user_id, created_at);

-- ============================================================================
-- 12. SUPABASE REALTIME & DATABASE WEBHOOK SETUP FOR RAILWAY WORKER
-- ============================================================================

-- A. Enable Supabase Realtime for instant UI status push
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_memory;

-- B. Webhook Trigger Setup (Alternative to Supabase Dashboard Webhooks)
-- Trigger: Whenever a new task is inserted with status = 'pending' -> POST to Railway Worker /enqueue
/*
create extension if not exists "pg_net";

create or replace function notify_railway_worker_task_pending()
returns trigger as $$
begin
  if new.status = 'pending' then
    perform net.http_post(
      url := 'https://your-railway-worker-app.railway.app/enqueue',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := json_build_object('record', row_to_json(new))::jsonb
    );
  end if;
  return new;
end;
$$ language plpgsql;

create or replace trigger trg_notify_worker_task_pending
after insert or update of status on tasks
for each row
execute function notify_railway_worker_task_pending();
*/
