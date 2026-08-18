-- Follow-up hardening from Supabase security/performance advisors.

-- These legacy helper functions were SECURITY DEFINER and executable through
-- the public Data API without ownership checks. They are backend-only.
alter function public.rename_agent(uuid, text) set search_path = public, pg_temp;
alter function public.update_agent_character(uuid, jsonb) set search_path = public, pg_temp;
revoke all on function public.rename_agent(uuid, text) from public, anon, authenticated;
revoke all on function public.update_agent_character(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.rename_agent(uuid, text) to service_role;
grant execute on function public.update_agent_character(uuid, jsonb) to service_role;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;

-- Service-only event ingress remains closed to Data API users, explicitly.
drop policy if exists connector_events_no_client_access on public.connector_events;
create policy connector_events_no_client_access on public.connector_events
  for all to authenticated using (false) with check (false);
drop policy if exists models_config_authenticated_read on public.models_config;
create policy models_config_authenticated_read on public.models_config
  for select to authenticated using (true);
grant select on public.models_config to authenticated;

-- Wrap auth.uid() in a scalar subquery so Postgres evaluates it once per query.
drop policy if exists own_tasks on public.tasks;
create policy own_tasks on public.tasks for all to authenticated
  using ((select auth.uid())::text = user_id::text) with check ((select auth.uid())::text = user_id::text);
drop policy if exists own_agents on public.agents;
create policy own_agents on public.agents for all to authenticated
  using ((select auth.uid())::text = user_id::text) with check ((select auth.uid())::text = user_id::text);
drop policy if exists own_user_plugins on public.user_plugins;
create policy own_user_plugins on public.user_plugins for all to authenticated
  using ((select auth.uid())::text = user_id::text) with check ((select auth.uid())::text = user_id::text);
drop policy if exists own_routines on public.routines;
create policy own_routines on public.routines for all to authenticated
  using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = (select auth.uid())::text))
  with check (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = (select auth.uid())::text));
drop policy if exists own_agent_memory on public.agent_memory;
create policy own_agent_memory on public.agent_memory for all to authenticated
  using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = (select auth.uid())::text))
  with check (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = (select auth.uid())::text));
drop policy if exists own_token_usage on public.token_usage;
create policy own_token_usage on public.token_usage for all to authenticated
  using (user_id::text = (select auth.uid())::text) with check (user_id::text = (select auth.uid())::text);
drop policy if exists own_user_skills on public.user_skills;
create policy own_user_skills on public.user_skills for all to authenticated
  using (user_id::text = (select auth.uid())::text) with check (user_id::text = (select auth.uid())::text);
drop policy if exists own_agent_skills on public.agent_skills;
create policy own_agent_skills on public.agent_skills for all to authenticated
  using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = (select auth.uid())::text))
  with check (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = (select auth.uid())::text));
drop policy if exists own_action_log on public.action_log;
create policy own_action_log on public.action_log for select to authenticated
  using (exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = (select auth.uid())::text));
drop policy if exists own_task_handoffs on public.task_handoffs;
create policy own_task_handoffs on public.task_handoffs for select to authenticated
  using (exists (select 1 from public.agents a where a.id = from_agent_id and a.user_id::text = (select auth.uid())::text));
drop policy if exists own_pending_auth on public.pending_auth;
create policy own_pending_auth on public.pending_auth for all to authenticated
  using (user_id::text = (select auth.uid())::text) with check (user_id::text = (select auth.uid())::text);
drop policy if exists own_conversations on public.conversations;
create policy own_conversations on public.conversations for all to authenticated
  using ((select auth.uid())::text = user_id) with check ((select auth.uid())::text = user_id);
drop policy if exists own_conversation_participants on public.conversation_participants;
create policy own_conversation_participants on public.conversation_participants for all to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())::text))
  with check (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())::text));
drop policy if exists own_messages on public.messages;
create policy own_messages on public.messages for all to authenticated
  using ((select auth.uid())::text = user_id) with check ((select auth.uid())::text = user_id);
drop policy if exists own_task_runs on public.task_runs;
create policy own_task_runs on public.task_runs for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and t.user_id::text = (select auth.uid())::text));
drop policy if exists own_task_steps on public.task_steps;
create policy own_task_steps on public.task_steps for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id and t.user_id::text = (select auth.uid())::text));
drop policy if exists own_approvals on public.approvals;
create policy own_approvals on public.approvals for select to authenticated
  using ((select auth.uid())::text = user_id);
drop policy if exists own_recording_sessions on public.routine_recording_sessions;
create policy own_recording_sessions on public.routine_recording_sessions for all to authenticated
  using ((select auth.uid())::text = user_id) with check ((select auth.uid())::text = user_id);
drop policy if exists own_routine_runs on public.routine_runs;
create policy own_routine_runs on public.routine_runs for select to authenticated
  using (exists (select 1 from public.routines r join public.agents a on a.id = r.agent_id where r.id = routine_id and a.user_id::text = (select auth.uid())::text));
drop policy if exists own_agent_events on public.agent_events;
create policy own_agent_events on public.agent_events for select to authenticated
  using (user_id = (select auth.uid())::text or exists (select 1 from public.agents a where a.id = agent_id and a.user_id::text = (select auth.uid())::text));

create index if not exists action_log_agent_idx on public.action_log(agent_id);
create index if not exists action_log_task_idx on public.action_log(task_id);
create index if not exists agent_events_run_idx on public.agent_events(run_id);
create index if not exists agent_memory_source_task_idx on public.agent_memory(source_task_id);
create index if not exists agent_skills_skill_idx on public.agent_skills(skill_id);
create index if not exists approvals_run_idx on public.approvals(run_id);
create index if not exists approvals_step_idx on public.approvals(step_id);
create index if not exists messages_agent_idx on public.messages(agent_id);
create index if not exists messages_task_idx on public.messages(task_id);
create index if not exists pending_auth_plugin_idx on public.pending_auth(plugin_id);
create index if not exists recording_sessions_agent_idx on public.routine_recording_sessions(agent_id);
create index if not exists routine_runs_task_idx on public.routine_runs(task_id);
create index if not exists task_handoffs_from_idx on public.task_handoffs(from_agent_id);
create index if not exists task_handoffs_to_idx on public.task_handoffs(to_agent_id);
create index if not exists task_handoffs_task_idx on public.task_handoffs(task_id);
create index if not exists user_plugins_plugin_idx on public.user_plugins(plugin_id);
create index if not exists user_skills_skill_idx on public.user_skills(skill_id);

notify pgrst, 'reload schema';
