-- Agentie AI Workforce control plane
-- Canonical, additive upgrade for durable conversations, brain runs, approvals,
-- memory, routines, multi-agent task graphs, and user-scoped realtime state.

create extension if not exists pgcrypto;
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- Existing installations were created from two historical schemas. Normalize
-- the task contract without dropping user data.
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks drop constraint if exists tasks_source_check;
alter table public.tasks drop constraint if exists tasks_result_type_check;

alter table public.tasks
  add column if not exists conversation_id uuid,
  add column if not exists parent_task_id uuid references public.tasks(id) on delete cascade,
  add column if not exists root_task_id uuid references public.tasks(id) on delete cascade,
  add column if not exists delegated_by_agent_id uuid references public.agents(id) on delete set null,
  add column if not exists idempotency_key text,
  add column if not exists priority integer not null default 0,
  add column if not exists deadline_at timestamptz,
  add column if not exists max_steps integer not null default 12,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists completed_at timestamptz;

alter table public.tasks
  add constraint tasks_status_check check (status in (
    'pending','queued','in_progress','waiting_approval','needs_approval',
    'waiting_input','waiting_children','paused','done','failed','cancelled'
  )),
  add constraint tasks_source_check check (source in (
    'user','manual','scheduled','handoff','parallel','routine','event','api'
  ));

create unique index if not exists tasks_user_idempotency_unique
  on public.tasks(user_id, idempotency_key) where idempotency_key is not null;
create index if not exists tasks_parent_idx on public.tasks(parent_task_id);
create index if not exists tasks_conversation_idx on public.tasks(conversation_id, created_at);
create index if not exists tasks_lease_idx on public.tasks(status, lease_expires_at);

alter table public.agents
  add column if not exists prompt_version integer not null default 1,
  add column if not exists policy jsonb not null default '{}'::jsonb,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Some early deployments predate the skills migration. Keep this upgrade
-- self-contained so the brain can always load core and role-specific skills.
create table if not exists public.skills (
  id text primary key,
  name text not null,
  icon_url text,
  description text,
  tier text not null check (tier in ('core','library')),
  category text,
  instructions text not null,
  suggested_plugins text[] not null default '{}',
  status text not null default 'active' check (status in ('active','beta','disabled')),
  created_at timestamptz not null default now()
);
create table if not exists public.user_skills (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  skill_id text not null references public.skills(id) on delete cascade,
  installed_at timestamptz not null default now(),
  unique(user_id, skill_id)
);
create table if not exists public.agent_skills (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  skill_id text not null references public.skills(id) on delete cascade,
  enabled_at timestamptz not null default now(),
  unique(agent_id, skill_id)
);

insert into public.skills (id,name,description,tier,category,instructions,suggested_plugins) values
('planning','Planning','Plans dependent work before acting.','core','reasoning','For multi-step work, create one short ordered plan, then execute it. Skip formal plans for trivial one-step work.','{}'),
('task_breakdown','Task Breakdown','Turns broad goals into concrete dependent steps.','core','reasoning','Break broad work into concrete outcomes, note dependencies, and complete them in a logical order.','{}'),
('research','Research','Checks required facts instead of guessing.','core','reasoning','Use available sources and connected tools to verify facts required for the task. Clearly distinguish sourced facts from assumptions.','{last30days}'),
('self_review','Self Review','Verifies work before completion.','core','reasoning','Before finishing or requesting a consequential action, compare the result with the original instruction and correct material gaps.','{}'),
('communication','Communication','Matches tone and format to the audience.','core','reasoning','Use clear language and the smallest response format that communicates the result well. Never expose internal chain-of-thought.','{}'),
('delegation','Delegation','Hands work to a better-suited agent with context.','core','reasoning','Delegate only when another active agent is clearly better suited. Include the desired outcome, constraints, and relevant context.','{}'),
('marketing','Marketing','Audience-aware campaigns and copy.','library','growth','Lead with the audience benefit, respect known brand voice, and use one clear next action.','{gmail}'),
('coding','Coding','Disciplined coding, review, and explanation.','library','technical','Prefer small working solutions, verify behavior, and never invent APIs or dependencies.','{github}'),
('finance','Finance','Careful budgets, invoices, and financial summaries.','library','operations','Double-check arithmetic, label estimates, and require approval for payments or invoice sending.','{stripe}'),
('sales','Sales','Personalized outreach and pipeline follow-up.','library','growth','Keep outreach concise, use only known personalization, and end with one clear next step.','{gmail,hubspot}'),
('data_analysis','Data Analysis','Honest numeric and tabular analysis.','library','technical','Lead with the material finding, validate calculations, and state completeness or sample limitations.','{}'),
('document_management','Document Management','Consistent document creation and maintenance.','library','operations','Use the requested format, consistent structure, and preserve existing document style when editing.','{files,notion}')
on conflict (id) do update set name=excluded.name, description=excluded.description, instructions=excluded.instructions, suggested_plugins=excluded.suggested_plugins;

alter table public.task_handoffs
  add column if not exists context_summary text;

-- Conversation is distinct from task execution. Ordinary chat writes messages
-- without creating a task; tasks link back to the conversation when work begins.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text,
  kind text not null default 'direct' check (kind in ('direct','group','system')),
  status text not null default 'active' check (status in ('active','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversation_participants (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  participant_type text not null check (participant_type in ('user','agent')),
  participant_id text not null,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, participant_type, participant_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  agent_id uuid references public.agents(id) on delete set null,
  sender_type text not null check (sender_type in ('user','agent','system','tool')),
  content text not null default '',
  content_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.tasks drop constraint if exists tasks_conversation_id_fkey;
alter table public.tasks add constraint tasks_conversation_id_fkey
  foreign key (conversation_id) references public.conversations(id) on delete set null;

create index if not exists conversations_user_updated_idx
  on public.conversations(user_id, updated_at desc);
create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at);

-- A task can have multiple attempts. Every model decision and tool result is a
-- durable step so pause/resume and audits do not depend on a JSON blob alone.
create table if not exists public.task_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  attempt integer not null default 1,
  status text not null default 'running' check (status in (
    'running','waiting_approval','waiting_input','waiting_children',
    'succeeded','failed','cancelled'
  )),
  brain_version text not null default 'agentie-brain-v2',
  model_id text,
  lease_token uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error jsonb,
  metrics jsonb not null default '{}'::jsonb,
  unique(task_id, attempt)
);

create table if not exists public.task_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  run_id uuid not null references public.task_runs(id) on delete cascade,
  step_index integer not null,
  step_type text not null check (step_type in (
    'intent','plan','model','tool','approval','question','handoff','memory','final'
  )),
  status text not null default 'running' check (status in (
    'pending','running','waiting','succeeded','failed','denied','cancelled'
  )),
  tool_name text,
  risk_level text check (risk_level is null or risk_level in ('safe','sensitive','restricted')),
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(run_id, step_index)
);

create index if not exists task_steps_task_idx on public.task_steps(task_id, step_index);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  task_id uuid not null references public.tasks(id) on delete cascade,
  run_id uuid references public.task_runs(id) on delete cascade,
  step_id uuid references public.task_steps(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','approved','denied','expired','cancelled')),
  risk_level text not null default 'sensitive' check (risk_level in ('sensitive','restricted')),
  action jsonb not null,
  action_hash text not null,
  edited_action jsonb,
  reason text,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists approvals_one_pending_step
  on public.approvals(task_id, step_id) where status = 'pending';
create index if not exists approvals_user_status_idx
  on public.approvals(user_id, status, created_at desc);

-- Extend memory without invalidating the existing key/value API.
alter table public.agent_memory
  add column if not exists content text,
  add column if not exists embedding extensions.vector(1536),
  add column if not exists kind text not null default 'fact',
  add column if not exists confidence real not null default 1.0,
  add column if not exists pinned boolean not null default false,
  add column if not exists sensitive boolean not null default false,
  add column if not exists source_task_id uuid references public.tasks(id) on delete set null,
  add column if not exists expires_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

update public.agent_memory
set content = concat(key, ': ', value)
where content is null;

create unique index if not exists agent_memory_agent_key_unique
  on public.agent_memory(agent_id, key);

create index if not exists agent_memory_embedding_hnsw_idx
  on public.agent_memory using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

create or replace function public.match_agent_memory(
  p_agent_id uuid,
  p_embedding extensions.vector(1536),
  p_limit integer default 12
)
returns table (
  id uuid, key text, value text, content text, kind text, pinned boolean,
  confidence real, similarity double precision
)
language sql stable security invoker set search_path = public, extensions
as $$
  select m.id, m.key, m.value, m.content, m.kind, m.pinned,
         m.confidence, 1 - (m.embedding <=> p_embedding) as similarity
  from public.agent_memory m
  where m.agent_id = p_agent_id
    and (m.expires_at is null or m.expires_at > now())
    and (m.embedding is not null or m.pinned)
  order by m.pinned desc, m.embedding <=> p_embedding
  limit greatest(1, least(p_limit, 50));
$$;

revoke all on function public.match_agent_memory(uuid, extensions.vector, integer) from public, anon;
grant execute on function public.match_agent_memory(uuid, extensions.vector, integer) to authenticated, service_role;

-- Durable teach-mode sessions and routine execution history.
alter table public.routines
  add column if not exists description text,
  add column if not exists parameters jsonb not null default '{}'::jsonb,
  add column if not exists event_triggers jsonb not null default '[]'::jsonb,
  add column if not exists timezone text not null default 'UTC',
  add column if not exists version integer not null default 1,
  add column if not exists last_trigger_key text;

create table if not exists public.routine_recording_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  agent_id uuid not null references public.agents(id) on delete cascade,
  status text not null default 'recording' check (status in ('recording','processing','saved','cancelled','expired')),
  steps jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours')
);

create table if not exists public.routine_runs (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.routines(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  trigger_type text not null default 'manual' check (trigger_type in ('manual','schedule','event','match')),
  trigger_key text,
  status text not null default 'queued' check (status in ('queued','running','waiting_approval','succeeded','failed','cancelled')),
  input jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists routine_runs_trigger_unique
  on public.routine_runs(routine_id, trigger_key) where trigger_key is not null;

-- Append-only runtime event stream. This replaces overloading action_log while
-- preserving action_log for backward compatibility.
create table if not exists public.agent_events (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  agent_id uuid not null references public.agents(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  run_id uuid references public.task_runs(id) on delete cascade,
  event_type text not null,
  summary text not null,
  severity text not null default 'info' check (severity in ('debug','info','warning','error')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_events_task_idx on public.agent_events(task_id, created_at);
create index if not exists agent_events_agent_idx on public.agent_events(agent_id, created_at desc);

-- Event webhook deduplication.
create table if not exists public.connector_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  plugin_id text not null,
  external_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  unique(plugin_id, external_id)
);

-- Strict user ownership. Backend service_role continues to bypass RLS.
alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;
alter table public.task_runs enable row level security;
alter table public.task_steps enable row level security;
alter table public.approvals enable row level security;
alter table public.routine_recording_sessions enable row level security;
alter table public.routine_runs enable row level security;
alter table public.agent_events enable row level security;
alter table public.connector_events enable row level security;
alter table public.skills enable row level security;
alter table public.token_usage enable row level security;
alter table public.user_skills enable row level security;
alter table public.agent_skills enable row level security;
alter table public.action_log enable row level security;
alter table public.task_handoffs enable row level security;
alter table public.pending_auth enable row level security;

drop policy if exists tasks_access_policy on public.tasks;
drop policy if exists agents_access_policy on public.agents;
drop policy if exists user_plugins_access_policy on public.user_plugins;
drop policy if exists routines_access_policy on public.routines;
drop policy if exists agent_memory_access_policy on public.agent_memory;
drop policy if exists token_usage_access_policy on public.token_usage;
drop policy if exists user_skills_access_policy on public.user_skills;
drop policy if exists agent_skills_access_policy on public.agent_skills;
drop policy if exists action_log_access_policy on public.action_log;
drop policy if exists task_handoffs_access_policy on public.task_handoffs;
drop policy if exists pending_auth_access_policy on public.pending_auth;

drop policy if exists "skills readable by all" on public.skills;
drop policy if exists skills_readable_by_authenticated on public.skills;
create policy skills_readable_by_authenticated on public.skills for select to authenticated using (true);

drop policy if exists own_tasks on public.tasks;
drop policy if exists "own tasks" on public.tasks;
create policy own_tasks on public.tasks for all to authenticated
  using (auth.uid()::text = user_id::text) with check (auth.uid()::text = user_id::text);
drop policy if exists own_agents on public.agents;
drop policy if exists "own agents" on public.agents;
create policy own_agents on public.agents for all to authenticated
  using (auth.uid()::text = user_id::text) with check (auth.uid()::text = user_id::text);
drop policy if exists own_user_plugins on public.user_plugins;
drop policy if exists "own user plugins" on public.user_plugins;
create policy own_user_plugins on public.user_plugins for all to authenticated
  using (auth.uid()::text = user_id::text) with check (auth.uid()::text = user_id::text);
drop policy if exists own_routines on public.routines;
drop policy if exists "own routines" on public.routines;
create policy own_routines on public.routines for all to authenticated
  using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = auth.uid()::text))
  with check (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = auth.uid()::text));
drop policy if exists own_agent_memory on public.agent_memory;
drop policy if exists "own agent_memory" on public.agent_memory;
create policy own_agent_memory on public.agent_memory for all to authenticated
  using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = auth.uid()::text))
  with check (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = auth.uid()::text));

drop policy if exists "own token_usage" on public.token_usage;
drop policy if exists own_token_usage on public.token_usage;
create policy own_token_usage on public.token_usage for all to authenticated
  using (user_id::text = auth.uid()::text) with check (user_id::text = auth.uid()::text);
drop policy if exists "own user_skills" on public.user_skills;
drop policy if exists own_user_skills on public.user_skills;
create policy own_user_skills on public.user_skills for all to authenticated
  using (user_id::text = auth.uid()::text) with check (user_id::text = auth.uid()::text);
drop policy if exists "own agent_skills" on public.agent_skills;
drop policy if exists own_agent_skills on public.agent_skills;
create policy own_agent_skills on public.agent_skills for all to authenticated
  using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = auth.uid()::text))
  with check (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = auth.uid()::text));
drop policy if exists own_action_log on public.action_log;
create policy own_action_log on public.action_log for select to authenticated
  using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = auth.uid()::text));
drop policy if exists own_task_handoffs on public.task_handoffs;
create policy own_task_handoffs on public.task_handoffs for select to authenticated
  using (exists (select 1 from public.agents a where a.id = from_agent_id and a.user_id::text = auth.uid()::text));
drop policy if exists "own pending_auth" on public.pending_auth;
drop policy if exists own_pending_auth on public.pending_auth;
create policy own_pending_auth on public.pending_auth for all to authenticated
  using (user_id::text = auth.uid()::text) with check (user_id::text = auth.uid()::text);

drop policy if exists own_conversations on public.conversations;
create policy own_conversations on public.conversations for all to authenticated
  using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
drop policy if exists own_conversation_participants on public.conversation_participants;
create policy own_conversation_participants on public.conversation_participants for all to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()::text))
  with check (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()::text));
drop policy if exists own_messages on public.messages;
create policy own_messages on public.messages for all to authenticated
  using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
drop policy if exists own_task_runs on public.task_runs;
create policy own_task_runs on public.task_runs for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and t.user_id::text = auth.uid()::text));
drop policy if exists own_task_steps on public.task_steps;
create policy own_task_steps on public.task_steps for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and t.user_id::text = auth.uid()::text));
drop policy if exists own_approvals on public.approvals;
create policy own_approvals on public.approvals for all to authenticated
  using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
drop policy if exists own_recording_sessions on public.routine_recording_sessions;
create policy own_recording_sessions on public.routine_recording_sessions for all to authenticated
  using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
drop policy if exists own_routine_runs on public.routine_runs;
create policy own_routine_runs on public.routine_runs for select to authenticated
  using (exists (
    select 1 from public.routines r join public.agents a on a.id = r.agent_id
    where r.id = routine_id and a.user_id::text = auth.uid()::text
  ));
drop policy if exists own_agent_events on public.agent_events;
create policy own_agent_events on public.agent_events for select to authenticated
  using (user_id = auth.uid()::text or exists (
    select 1 from public.agents a where a.id = agent_id and a.user_id::text = auth.uid()::text
  ));

grant select, insert, update, delete on public.conversations, public.conversation_participants,
  public.messages, public.routine_recording_sessions to authenticated;
revoke all on public.approvals from authenticated;
grant select on public.approvals to authenticated;
grant select on public.task_runs, public.task_steps, public.routine_runs, public.agent_events to authenticated;
grant select on public.skills to authenticated;
grant select, insert, delete on public.user_skills, public.agent_skills to authenticated;
grant all on public.conversations, public.conversation_participants, public.messages,
  public.task_runs, public.task_steps, public.approvals, public.routine_recording_sessions,
  public.routine_runs, public.agent_events, public.connector_events to service_role;

do $$ begin
  alter publication supabase_realtime add table public.conversations;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.approvals;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.agent_events;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
