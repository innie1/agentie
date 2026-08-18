-- AGENTIE — Core schema
-- Run this in Supabase SQL editor or via `supabase db push`

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────
-- PLUGIN CATALOG (seeded once, admin-managed)
-- ─────────────────────────────────────────────
create table if not exists plugins (
  id text primary key,                 -- e.g. 'gmail', 'google_calendar', 'slack', 'github', 'notion'
  name text not null,
  icon_url text,
  description text,
  category text,
  auth_type text not null check (auth_type in ('oauth', 'api_key')),
  oauth_authorize_url text,
  oauth_token_url text,
  oauth_scopes text[],
  status text not null default 'active' check (status in ('active', 'beta', 'disabled')),
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- USER'S ADDED PLUGINS (real credentials live here)
-- ─────────────────────────────────────────────
create table if not exists user_plugins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plugin_id text not null references plugins(id) on delete cascade,
  access_token text,            -- encrypted before insert (see server/src/lib/crypto.js)
  refresh_token text,           -- encrypted before insert
  api_key text,                 -- encrypted before insert (for api_key-type plugins)
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  added_at timestamptz not null default now(),
  unique (user_id, plugin_id)
);

-- ─────────────────────────────────────────────
-- PENDING OAUTH HANDSHAKES (short-lived state tokens)
-- ─────────────────────────────────────────────
create table if not exists pending_auth (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plugin_id text not null references plugins(id) on delete cascade,
  state text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);

-- ─────────────────────────────────────────────
-- AGENTS
-- ─────────────────────────────────────────────
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  name_source text not null default 'user' check (name_source in ('auto', 'user')),
  role text,
  goal text,
  system_prompt text,
  allowed_plugins text[] not null default '{}',
  auto_approved_actions text[] not null default '{}',
  allowed_handoff_agents uuid[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create unique index if not exists agents_user_name_ci
  on agents (user_id, lower(name));

-- ─────────────────────────────────────────────
-- TASKS (the queue's source of truth)
-- ─────────────────────────────────────────────
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  instruction text not null,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'needs_approval', 'done', 'failed', 'cancelled')),
  result_type text check (result_type in
    ('fact','task_complete','multi_item','irreversible_pending','numeric_comparative',
     'activity_trace','missing_info','delegated','failure')),
  result_payload jsonb default '{}'::jsonb,   -- also stores paused loop state for resume
  source text not null default 'user' check (source in ('user', 'scheduled', 'handoff')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_status_idx on tasks (status);
create index if not exists tasks_agent_idx on tasks (agent_id);

-- ─────────────────────────────────────────────
-- ROUTINES
-- ─────────────────────────────────────────────
create table if not exists routines (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  name text not null,
  steps jsonb not null default '[]'::jsonb,
  trigger_pattern text[],
  schedule text,                 -- cron string, nullable
  dynamic_fields jsonb default '{}'::jsonb,
  success_count int not null default 0,
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_run_at timestamptz,
  last_run_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- AGENT MEMORY (facts learned across conversations)
-- ─────────────────────────────────────────────
create table if not exists agent_memory (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  key text not null,
  value text not null,
  source_task_id uuid references tasks(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (agent_id, key)
);

-- ─────────────────────────────────────────────
-- ACTION LOG (audit trail of every plugin/model call)
-- ─────────────────────────────────────────────
create table if not exists action_log (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  action text not null,          -- e.g. 'gmail.send_email', 'model.call'
  params jsonb,
  result jsonb,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- TASK HANDOFFS
-- ─────────────────────────────────────────────
create table if not exists task_handoffs (
  id uuid primary key default gen_random_uuid(),
  from_agent_id uuid not null references agents(id) on delete cascade,
  to_agent_id uuid not null references agents(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- MODEL CONFIG (which OpenRouter/Gemini model per tier)
-- ─────────────────────────────────────────────
create table if not exists models_config (
  role text primary key check (role in ('fast', 'reasoning')),
  model_id text not null,
  updated_at timestamptz not null default now()
);

insert into models_config (role, model_id) values
  ('fast', 'google/gemini-2.0-flash-001'),
  ('reasoning', 'google/gemini-2.0-flash-001')
on conflict (role) do nothing;
-- NOTE: update these via the admin settings / models_config table once you've
-- checked OpenRouter's live catalog — do not treat these as permanently correct.

-- ─────────────────────────────────────────────
-- TOKEN USAGE
-- ─────────────────────────────────────────────
create table if not exists token_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  model_id text not null,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  total_tokens int not null default 0,
  cost_usd numeric(10,6),
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────
alter table user_plugins enable row level security;
alter table agents enable row level security;
alter table tasks enable row level security;
alter table routines enable row level security;
alter table agent_memory enable row level security;
alter table token_usage enable row level security;
alter table pending_auth enable row level security;

create policy "own user_plugins" on user_plugins
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own agents" on agents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own tasks" on tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own routines" on routines
  for all using (agent_id in (select id from agents where user_id = auth.uid()));

create policy "own agent_memory" on agent_memory
  for all using (agent_id in (select id from agents where user_id = auth.uid()));

create policy "own token_usage" on token_usage
  for all using (auth.uid() = user_id);

create policy "own pending_auth" on pending_auth
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- plugins catalog is public read
alter table plugins enable row level security;
create policy "plugins readable by all" on plugins for select using (true);

-- ─────────────────────────────────────────────
-- SEED PLUGIN CATALOG (edit client_id/secret via server env vars, not here)
-- ─────────────────────────────────────────────
insert into plugins (id, name, icon_url, description, category, auth_type, oauth_authorize_url, oauth_token_url, oauth_scopes)
values
  ('gmail', 'Gmail', '/icons/gmail.svg', 'Read, summarize, draft and send emails with your connected Google account.', 'email', 'oauth',
    'https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token',
    array['https://www.googleapis.com/auth/gmail.modify']),
  ('google_calendar', 'Google Calendar', '/icons/gcal.svg', 'Check schedules, manage meeting invites, and sync events.', 'calendar', 'oauth',
    'https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token',
    array['https://www.googleapis.com/auth/calendar']),
  ('slack', 'Slack', '/icons/slack.svg', 'Monitor channels, send thread replies, and dispatch webhooks to your team.', 'messaging', 'oauth',
    'https://slack.com/oauth/v2/authorize', 'https://slack.com/api/oauth.v2.access',
    array['channels:read','chat:write']),
  ('github', 'GitHub', '/icons/github.svg', 'Inspect pull requests, review commits, and query code repositories.', 'dev', 'oauth',
    'https://github.com/login/oauth/authorize', 'https://github.com/login/oauth/access_token',
    array['repo','read:user']),
  ('notion', 'Notion', '/icons/notion.svg', 'Sync knowledge bases, read workspace pages, and draft formatted docs.', 'docs', 'oauth',
    'https://api.notion.com/v1/oauth/authorize', 'https://api.notion.com/v1/oauth/token',
    array[]::text[])
on conflict (id) do nothing;
