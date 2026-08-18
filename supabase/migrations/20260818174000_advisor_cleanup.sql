-- Remaining actionable performance-advisor findings after the control-plane rollout.
drop policy if exists agent_files_authenticated_access on public.agent_files;
create policy agent_files_authenticated_access on public.agent_files for all to authenticated
  using ((select auth.uid())::text = user_id)
  with check ((select auth.uid())::text = user_id);

create index if not exists tasks_delegated_by_agent_idx on public.tasks(delegated_by_agent_id);
create index if not exists tasks_root_idx on public.tasks(root_task_id);
create index if not exists tasks_routine_idx on public.tasks(routine_id);
create index if not exists token_usage_task_idx on public.token_usage(task_id);
