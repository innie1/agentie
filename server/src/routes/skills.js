import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";

const router = express.Router();

const DEFAULT_SKILLS = [
  { id: 'planning', name: 'Planning', description: 'Breaks a goal into an ordered plan before acting.', tier: 'core', category: 'reasoning', instructions: 'Before taking any action, form a short ordered plan of the steps needed to complete the task. Only proceed step by step once the plan is clear.' },
  { id: 'task_breakdown', name: 'Task Breakdown', description: 'Splits vague or large requests into concrete sub-tasks.', tier: 'core', category: 'reasoning', instructions: 'When an instruction is broad, vague, or multi-part, break it into concrete, individually completable sub-tasks before executing.' },
  { id: 'research', name: 'Research', description: 'Gathers information before acting instead of assuming.', tier: 'core', category: 'reasoning', instructions: 'When you lack a fact needed to complete the task correctly, gather it first using an available connected plugin.' },
  { id: 'self_review', name: 'Self-Review', description: 'Checks its own output before finalizing.', tier: 'core', category: 'reasoning', instructions: 'Before returning a final_answer or taking an irreversible action, briefly review your own output against the original instruction.' },
  { id: 'communication', name: 'Communication', description: 'Adapts tone and format to the audience and context.', tier: 'core', category: 'reasoning', instructions: 'Match tone and detail to who the output is for: keep internal notes brief and direct, keep client messages polished.' },
  { id: 'delegation', name: 'Delegation', description: 'Recognizes when another agent is better suited and hands off cleanly.', tier: 'core', category: 'reasoning', instructions: 'If part of the task clearly belongs to a different agent, use a handoff instead of attempting it yourself.' },
  { id: 'marketing', name: 'Marketing', description: 'Copywriting, campaign ideas, and audience-aware messaging.', tier: 'library', category: 'growth', suggested_plugins: ['gmail'], instructions: 'When writing marketing content, lead with a clear benefit to the reader before features.' },
  { id: 'coding', name: 'Coding', description: 'Writes, reviews, and explains code with engineering discipline.', tier: 'library', category: 'technical', suggested_plugins: ['github'], instructions: 'When writing code, prefer clear, working, minimal solutions over clever ones.' },
  { id: 'finance', name: 'Finance', description: 'Handles budgets, invoices, and financial summaries carefully.', tier: 'library', category: 'ops', suggested_plugins: ['gmail'], instructions: 'Treat all numeric outputs as needing accuracy over speed — double-check arithmetic.' },
  { id: 'sales', name: 'Sales', description: 'Outreach, follow-ups, and pipeline-aware communication.', tier: 'library', category: 'growth', suggested_plugins: ['gmail', 'slack'], instructions: 'When drafting outreach, keep it short, personalized to what is known, and end with one next step.' },
  { id: 'data_analysis', name: 'Data Analysis', description: 'Summarizes and interprets numeric or tabular data honestly.', tier: 'library', category: 'technical', suggested_plugins: [], instructions: 'When presenting data, lead with the most important trend or number, not a full table dump.' },
  { id: 'document_management', name: 'Document Management', description: 'Organizes, formats, and maintains documents consistently.', tier: 'library', category: 'ops', suggested_plugins: ['notion', 'gcal'], instructions: 'When creating or editing documents, keep formatting consistent with existing style.' }
];

// GET /api/skills — full catalog (core + library), with install status for this user
router.get("/", async (req, res) => {
  const userId = req.user.id;
  let skills = [];
  let installedSet = new Set();

  try {
    const { data: dbSkills, error } = await supabaseAdmin.from("skills").select("*").eq("status", "active");
    if (!error && dbSkills && dbSkills.length > 0) {
      skills = dbSkills;
      const { data: installed } = await supabaseAdmin.from("user_skills").select("skill_id").eq("user_id", userId);
      installedSet = new Set((installed || []).map((r) => r.skill_id));
    } else {
      skills = DEFAULT_SKILLS;
    }
  } catch (err) {
    skills = DEFAULT_SKILLS;
  }

  const merged = skills.map((s) => ({
    ...s,
    installed: s.tier === "core" ? true : installedSet.has(s.id),
  }));

  res.json({ skills: merged });
});

// POST /api/skills/:skillId/install — account-level install (library skills only)
router.post("/:skillId/install", async (req, res) => {
  const userId = req.user.id;
  const { skillId } = req.params;

  const { data: skill, error } = await supabaseAdmin.from("skills").select("*").eq("id", skillId).single();
  if (error || !skill) return res.status(404).json({ error: "Unknown skill" });
  if (skill.tier === "core") return res.status(400).json({ error: "Core skills are already active on every agent, nothing to install." });

  const { error: insertErr } = await supabaseAdmin
    .from("user_skills")
    .upsert({ user_id: userId, skill_id: skillId }, { onConflict: "user_id,skill_id" });
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  res.json({ ok: true });
});

// DELETE /api/skills/:skillId/install — uninstall account-wide (also disables it on every agent)
router.delete("/:skillId/install", async (req, res) => {
  const userId = req.user.id;
  const { skillId } = req.params;

  await supabaseAdmin.from("user_skills").delete().eq("user_id", userId).eq("skill_id", skillId);

  // cascade: disable on any agent it was enabled on
  const { data: agents } = await supabaseAdmin.from("agents").select("id").eq("user_id", userId);
  const agentIds = (agents || []).map((a) => a.id);
  if (agentIds.length) {
    await supabaseAdmin.from("agent_skills").delete().eq("skill_id", skillId).in("agent_id", agentIds);
  }

  res.json({ ok: true });
});

// GET /api/agents/:agentId/skills — which skills are enabled on this specific agent
router.get("/agent/:agentId", async (req, res) => {
  const { agentId } = req.params;
  const { data: agent } = await supabaseAdmin.from("agents").select("id").eq("id", agentId).eq("user_id", req.user.id).single();
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const { data: coreSkills } = await supabaseAdmin.from("skills").select("*").eq("tier", "core");
  const { data: enabledRows } = await supabaseAdmin.from("agent_skills").select("skill_id").eq("agent_id", agentId);
  const enabledIds = (enabledRows || []).map((r) => r.skill_id);

  let libraryEnabled = [];
  if (enabledIds.length) {
    const { data } = await supabaseAdmin.from("skills").select("*").in("id", enabledIds);
    libraryEnabled = data || [];
  }

  res.json({ core: coreSkills || [], library_enabled: libraryEnabled });
});

// POST /api/agents/:agentId/skills/:skillId/enable — must be installed account-wide first
router.post("/agent/:agentId/:skillId/enable", async (req, res) => {
  const userId = req.user.id;
  const { agentId, skillId } = req.params;

  const { data: agent } = await supabaseAdmin.from("agents").select("id").eq("id", agentId).eq("user_id", userId).single();
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const { data: skill } = await supabaseAdmin.from("skills").select("*").eq("id", skillId).single();
  if (!skill) return res.status(404).json({ error: "Unknown skill" });
  if (skill.tier === "core") return res.status(400).json({ error: "Core skills are already active on every agent." });

  const { data: installed } = await supabaseAdmin.from("user_skills").select("id").eq("user_id", userId).eq("skill_id", skillId).single();
  if (!installed) return res.status(400).json({ error: "Install this skill from the Skills Library before enabling it on an agent." });

  const { error } = await supabaseAdmin
    .from("agent_skills")
    .upsert({ agent_id: agentId, skill_id: skillId }, { onConflict: "agent_id,skill_id" });
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true });
});

// DELETE /api/agents/:agentId/skills/:skillId/enable — disable on this one agent only
router.delete("/agent/:agentId/:skillId/enable", async (req, res) => {
  const { agentId, skillId } = req.params;
  const { data: agent } = await supabaseAdmin.from("agents").select("id").eq("id", agentId).eq("user_id", req.user.id).single();
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  await supabaseAdmin.from("agent_skills").delete().eq("agent_id", agentId).eq("skill_id", skillId);
  res.json({ ok: true });
});

export default router;
