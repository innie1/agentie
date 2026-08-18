-- Runtime wiring compatibility for installations created from the older
-- schema. This is additive and preserves all existing agents and tasks.

alter table public.agents
  add column if not exists allowed_handoff_agents uuid[] not null default '{}',
  add column if not exists auto_approved_actions text[] not null default '{}',
  add column if not exists allowed_plugins text[] not null default '{}',
  add column if not exists status text not null default 'active';

alter table public.agent_memory
  add column if not exists updated_at timestamptz not null default now();

create index if not exists agents_user_status_idx on public.agents(user_id, status);
create index if not exists agent_memory_agent_updated_idx on public.agent_memory(agent_id, updated_at desc);
