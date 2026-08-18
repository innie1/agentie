import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { fastChat } from "../lib/fastChat.js";
import axios from "axios";

const router = express.Router();

const MANAGEMENT_ROLES = [
  "chief of staff", "chief", "boss", "ceo", "manager", "general manager",
  "operations manager", "operations lead", "team lead", "project manager",
  "manager agent", "head of operations",
];

function roleHasManagementCapability(role = "") {
  const normalized = String(role).toLowerCase().trim();
  return MANAGEMENT_ROLES.some(r => normalized === r || normalized.includes(r));
}

async function getAgent(agentId, userId) {
  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("id,name,role,goal,system_prompt,allowed_plugins,allowed_handoff_agents,auto_approved_actions,status")
    .eq("id", agentId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error(error?.message || "Agent not found");
  if (data.status !== "active") throw new Error("This agent is paused");
  return data;
}

async function getRoster(userId) {
  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("id,name,role,goal,status,allowed_plugins,allowed_handoff_agents")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

function parsePlan(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return { summary: raw, assignments: [] };
}

// Management is a capability derived from the agent's role/permissions.
// There is deliberately NO special or automatically-created "Chief of Staff" agent.
router.get("/", async (req, res) => {
  try {
    const roster = await getRoster(req.user.id);
    const managers = roster.filter(a => a.status === "active" && roleHasManagementCapability(a.role));
    res.json({ managers, roster });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/plan", async (req, res) => {
  const userId = req.user.id;
  const objective = String(req.body?.objective || "").trim();
  const managerAgentId = String(req.body?.agent_id || "").trim();
  if (!objective || !managerAgentId) return res.status(400).json({ error: "objective and agent_id are required" });

  try {
    const manager = await getAgent(managerAgentId, userId);
    if (!roleHasManagementCapability(manager.role)) {
      return res.status(403).json({ error: `${manager.name} does not have a management/delegation role`, required_capability: "workforce_management" });
    }

    const roster = await getRoster(userId);
    const workers = roster.filter(a => a.id !== manager.id && a.status === "active");
    const prompt = [
      `You are ${manager.name}, an AI employee whose role is ${manager.role}.`,
      "Your role gives you workforce-management capability.",
      "Coordinate the user's AI workforce and propose the best way to accomplish the objective.",
      "Return ONLY valid JSON:",
      '{"summary":"...","assignments":[{"agent_id":"...","reason":"...","instruction":"..."}],"new_agents":[{"name":"...","role":"...","goal":"..."}],"needs_user_approval":true}',
      "Never invent existing agent IDs. Only use IDs from the roster.",
      "Do not execute actions. This endpoint only creates a proposed plan.",
      "If an existing agent can do the work, prefer that agent over proposing a new one.",
      "OBJECTIVE:", objective,
      "WORKFORCE:", JSON.stringify(workers.map(a => ({ id: a.id, name: a.name, role: a.role, goal: a.goal }))),
    ].join("\n");

    const { text, model } = await fastChat({ agent: manager, message: prompt, history: [] });
    const plan = parsePlan(text);
    const validIds = new Set(workers.map(a => a.id));
    plan.assignments = Array.isArray(plan.assignments)
      ? plan.assignments.filter(a => validIds.has(a?.agent_id) && String(a?.instruction || "").trim())
      : [];
    plan.new_agents = Array.isArray(plan.new_agents)
      ? plan.new_agents.filter(a => String(a?.name || "").trim() && String(a?.role || "").trim() && String(a?.goal || "").trim())
      : [];
    plan.needs_user_approval = true;

    res.json({ manager, objective, plan, model });
  } catch (err) {
    console.error("[workforce-management] plan failed:", err.message);
    res.status(502).json({ error: "Workforce planning failed", detail: err.message });
  }
});

router.post("/delegate", async (req, res) => {
  const userId = req.user.id;
  const managerAgentId = String(req.body?.agent_id || "").trim();
  if (req.body?.approved !== true) return res.status(400).json({ error: "Explicit approval is required" });
  if (!managerAgentId) return res.status(400).json({ error: "agent_id is required" });

  const manager = await getAgent(managerAgentId, userId);
  if (!roleHasManagementCapability(manager.role)) return res.status(403).json({ error: "Agent does not have workforce-management capability" });

  const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
  if (!assignments.length) return res.status(400).json({ error: "assignments are required" });

  const roster = await getRoster(userId);
  const active = roster.filter(a => a.status === "active");
  const allowedIds = new Set(active.map(a => a.id));
  const explicitHandoff = new Set(Array.isArray(manager.allowed_handoff_agents) ? manager.allowed_handoff_agents : []);
  const restrictHandoffs = explicitHandoff.size > 0;
  const created = [];
  const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";

  for (const assignment of assignments) {
    if (!allowedIds.has(assignment?.agent_id) || !assignment?.instruction) continue;
    if (assignment.agent_id === manager.id) continue;
    if (restrictHandoffs && !explicitHandoff.has(assignment.agent_id)) continue;

    const { data: task, error } = await supabaseAdmin.from("tasks").insert({
      user_id: userId,
      agent_id: assignment.agent_id,
      instruction: String(assignment.instruction).trim(),
      status: "pending",
      source: "handoff",
      context: { delegated_by_agent_id: manager.id, delegated_by_agent_name: manager.name, approved_at: new Date().toISOString() },
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    await supabaseAdmin.from("task_handoffs").insert({
      from_agent_id: manager.id,
      to_agent_id: assignment.agent_id,
      task_id: task.id,
      note: assignment.reason || null,
    });

    try { await axios.post(`${workerUrl}/enqueue`, { taskId: task.id }); }
    catch (err) { console.error("[workforce-management] enqueue failed:", err.message); }
    created.push(task);
  }

  res.status(201).json({ manager, tasks: created, delegated: created.length });
});

router.post("/create-agent", async (req, res) => {
  if (req.body?.approved !== true) return res.status(400).json({ error: "Explicit approval is required" });
  const userId = req.user.id;
  const managerAgentId = String(req.body?.agent_id || "").trim();
  const name = String(req.body?.name || "").trim();
  const role = String(req.body?.role || "").trim();
  const goal = String(req.body?.goal || "").trim();
  if (!managerAgentId || !name || !role || !goal) return res.status(400).json({ error: "agent_id, name, role and goal are required" });

  const manager = await getAgent(managerAgentId, userId);
  if (!roleHasManagementCapability(manager.role)) return res.status(403).json({ error: "Only agents with workforce-management capability can create agents" });

  const { data: agent, error } = await supabaseAdmin.from("agents").insert({
    user_id: userId,
    name,
    name_source: "auto",
    role,
    goal,
    system_prompt: `You are ${name}, an AI employee with the role ${role}. Your goal is: ${goal}. Ask for approval before consequential external actions.`,
    allowed_plugins: ["files", "last30days"],
    auto_approved_actions: [],
    allowed_handoff_agents: [],
    status: "active",
  }).select().single();
  if (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An agent with that name already exists" });
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({ agent, created_by: manager });
});

export default router;
