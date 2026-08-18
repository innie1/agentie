-- AGENTIE — Skills System
-- Adds on top of 001_init.sql. Does not modify or drop anything existing.

-- ─────────────────────────────────────────────
-- SKILLS CATALOG
-- tier = 'core'    → automatic on every agent, no install, cannot be disabled
-- tier = 'library' → optional, user installs then enables per-agent
-- ─────────────────────────────────────────────
create table if not exists skills (
  id text primary key,              -- e.g. 'planning', 'marketing', 'coding'
  name text not null,
  icon_url text,
  description text,
  tier text not null check (tier in ('core', 'library')),
  category text,                    -- e.g. 'reasoning', 'growth', 'technical', 'ops'
  instructions text not null,       -- the actual behavior text injected into the agent's system prompt
  suggested_plugins text[] default '{}', -- plugins that pair well with this skill (UI hint only)
  status text not null default 'active' check (status in ('active', 'beta', 'disabled')),
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- USER'S INSTALLED LIBRARY SKILLS (account-level — must install before enabling on an agent)
-- ─────────────────────────────────────────────
create table if not exists user_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  skill_id text not null references skills(id) on delete cascade,
  installed_at timestamptz not null default now(),
  unique (user_id, skill_id)
);

-- ─────────────────────────────────────────────
-- PER-AGENT ENABLED SKILLS (library skills only — core skills don't need a row here,
-- they're applied to every agent automatically at the code level)
-- ─────────────────────────────────────────────
create table if not exists agent_skills (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  skill_id text not null references skills(id) on delete cascade,
  enabled_at timestamptz not null default now(),
  unique (agent_id, skill_id)
);

-- ─────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────
alter table skills enable row level security;
alter table user_skills enable row level security;
alter table agent_skills enable row level security;

create policy "skills readable by all" on skills for select using (true);

create policy "own user_skills" on user_skills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own agent_skills" on agent_skills
  for all using (agent_id in (select id from agents where user_id = auth.uid()));

-- ─────────────────────────────────────────────
-- SEED: CORE SKILLS (built in, automatic, every agent has these — no install step)
-- ─────────────────────────────────────────────
insert into skills (id, name, description, tier, category, instructions) values

('planning', 'Planning', 'Breaks a goal into an ordered plan before acting.', 'core', 'reasoning',
 'Before taking any action, form a short ordered plan of the steps needed to complete the task. Only proceed step by step once the plan is clear. If the task is trivial (one step), skip formal planning and just act.'),

('task_breakdown', 'Task Breakdown', 'Splits vague or large requests into concrete sub-tasks.', 'core', 'reasoning',
 'When an instruction is broad, vague, or multi-part, break it into concrete, individually completable sub-tasks before executing. Tackle sub-tasks in a logical order, and note dependencies between them (e.g. "step 3 needs the result of step 1").'),

('research', 'Research', 'Gathers information before acting instead of assuming.', 'core', 'reasoning',
 'When you lack a fact needed to complete the task correctly, gather it first — using an available connected plugin (e.g. reading an email thread, checking a calendar, searching a workspace) — rather than assuming or guessing. Never state something as fact that you have not actually checked.'),

('self_review', 'Self-Review', 'Checks its own output before finalizing.', 'core', 'reasoning',
 'Before returning a final_answer or taking an irreversible action, briefly review your own output against the original instruction: did it actually satisfy what was asked? Check for factual consistency with any tool results gathered earlier in the task. Fix issues yourself before finalizing rather than surfacing a rough draft.'),

('communication', 'Communication', 'Adapts tone and format to the audience and context.', 'core', 'reasoning',
 'Match tone and detail to who the output is for: keep internal notes brief and direct, keep client- or externally-facing messages polished and professional. Prefer plain, clear language over jargon unless the user''s own language shows they want technical depth. Use the response format (plain text, summary card, table, etc.) that fits the result shape, never more elaborate than necessary.'),

('delegation', 'Delegation', 'Recognizes when another agent is better suited and hands off cleanly.', 'core', 'reasoning',
 'If part of the task clearly belongs to a different agent''s role (based on their name/role/goal), use a handoff instead of attempting it yourself, and include a clear context summary so the receiving agent does not need to be re-briefed. Do not hand off work you are fully capable of completing yourself — only hand off when it genuinely fits another agent''s role better.')

on conflict (id) do nothing;

-- ─────────────────────────────────────────────
-- SEED: LIBRARY SKILLS (optional, install then enable per-agent)
-- ─────────────────────────────────────────────
insert into skills (id, name, description, tier, category, instructions, suggested_plugins) values

('marketing', 'Marketing', 'Copywriting, campaign ideas, and audience-aware messaging.', 'library', 'growth',
 'When writing marketing content, lead with a clear benefit to the reader before features. Match tone to the stated brand voice if known; otherwise default to direct and confident, not hype-heavy. Suggest a call-to-action where relevant. When asked for campaign ideas, give a short list of distinct angles rather than one long idea.', array['gmail']),

('coding', 'Coding', 'Writes, reviews, and explains code with engineering discipline.', 'library', 'technical',
 'When writing code, prefer clear, working, minimal solutions over clever ones. Note any assumptions about the environment or missing context instead of guessing silently. When reviewing code, point out correctness issues first, then style. Never fabricate a library, API, or function that may not exist — flag uncertainty instead.', array['github']),

('finance', 'Finance', 'Handles budgets, invoices, and financial summaries carefully.', 'library', 'ops',
 'Treat all numeric outputs as needing accuracy over speed — double-check arithmetic before presenting it. Flag any figure that was estimated rather than sourced from real data. Never take a payment, transfer, or invoice-sending action without going through the approval gate, regardless of amount.', array['gmail']),

('sales', 'Sales', 'Outreach, follow-ups, and pipeline-aware communication.', 'library', 'growth',
 'When drafting outreach, keep it short, personalized to what''s actually known about the recipient, and end with one clear next step. When following up, reference the prior context briefly rather than repeating the full pitch. Track and note where a contact is in the pipeline if that information is available.', array['gmail','slack']),

('data_analysis', 'Data Analysis', 'Summarizes and interprets numeric or tabular data honestly.', 'library', 'technical',
 'When presenting data, lead with the most important trend or number, not a full table dump. Note sample size or data completeness caveats if the dataset is small or partial. Do not extrapolate a trend from insufficient data without flagging that it''s a limited sample.', array[]::text[]),

('document_management', 'Document Management', 'Organizes, formats, and maintains documents consistently.', 'library', 'ops',
 'When creating or editing documents, keep formatting consistent with any existing document style shown in context. Use clear headings for long documents. When asked to find a document, search before assuming it doesn''t exist.', array['notion','google_calendar'])

on conflict (id) do nothing;
