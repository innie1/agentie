import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { fastChat } from "../lib/fastChat.js";

const router = express.Router();

async function getOrCreateChief(userId) {
  const { data: existing, error } = await supabaseAdmin
    .from("agents")
    .select("*")
    .eq("user_id", userId)
    .ilike("role", "%chief of staff%")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (existing) return existing;

  const { data: created, error: createError } = await supabaseAdmin.from("agents").insert({
    user_id: userId,
    name: "Chief of Staff",
    name_source: "auto",
    role: "Chief of Staff",
    goal: "Coordinate the user's AI workforce, turn goals into plans, delegate work to the right agents, and report results clearly.",
    system_prompt: "You are the user's Chief of Staff. Coordinate the AI workforce, propose delegation plans, ask for approval before consequential actions, and never silently send, buy, delete, publish, or create external accounts.",
    allowed_plugins: ["files", "last30days"],
    auto_approved_actions: [],
    allowed_handoff_agents: [],
    status: "active",
  }).select().single();
  if (createError) throw new Error(createError.message);
  return created;
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
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return { summary: raw, assignments: [] };
}

router.get("/", async (req, res) => {
  try {
    const chief = await getOrCreateChief(req.user.id);
    const roster = await getRoster(req.user.id);
    res.json({ chief, roster });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Planning is deliberately non-destructive: it proposes work and waits for approval.
router.post("/plan", async (req, res) => {
  const userId = req.user.id;
  const objective = String(req.body?.objective || "").trim();
  if (!objective) return res.status(400).json({ error: "objective is required" });

  try {
    const chief = await getOrCreateChief(userId);
    const roster = await getRoster(userId);
    const workers = roster.filter(a => a.id !== chief.id && a.status === "active");

    const prompt = [
      "You are a Chief of Staff coordinating an AI company.",
      "Return ONLY valid JSON with this shape:",
      '{"summary":"...","assignments":[{"agent_id":"...","reason":"...","instruction":"..."}],"needs_user_approval":true}',
      "Never invent agent IDs. Only use IDs from the roster.",
      "Do not execute actions. This endpoint only creates a proposed plan.",
      "OBJECTIVE:", objective,
      "ROSTER:", JSON.stringify(workers.map(a => ({ id: a.id, name: a.name, role: a.role, goal: a.goal }))),
    ].join("\n");

    const { text, model } = await fastChat({ agent: chief, message: prompt, history: [] });
    const plan = parsePlan(text);
    const validIds = new Set(workers.map(a => a.id));
    plan.assignments = Array.isArray(plan.assignments)
      ? plan.assignments.filter(a => validIds.has(a?.agent_id) && a?.instruction)
      : [];
    plan.needs_user_approval = true;

    res.json({ chief, objective, plan, model });
  } catch (err) {
    console.error("[chief-of-staff] plan failed:", err.message);
    res.status(502).json({ error: "Chief of Staff planning failed", detail: err.message });
  }
});

// Execute an approved plan. Each assignment becomes a normal task and is queued for its agent.
router.post("/delegate", async (req, res) => {
  const userId = req.user.id;
  if (req.body?.approved !== true) return res.status(400).json({ error: "Explicit approval is required" });
  const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
  if (!assignments.length) return res.status(400).json({ error: "assignments are required" });

  const roster = await getRoster(userId);
  const allowedIds = new Set(roster.filter(a => a.status === "active").map(a => a.id));
  const created = [];
  const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";

  for (const assignment of assignments) {
    if (!allowedIds.has(assignment?.agent_id) || !assignment?.instruction) continue;
    const { data: task, error } = await supabaseAdmin.from("tasks").insert({
      user_id: userId,
      agent_id: assignment.agent_id,
      instruction: String(assignment.instruction).trim(),
      status: "pending",
      source: "handoff",
      context: { delegated_by: "chief_of_staff", approved_at: new Date().toISOString() },
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    try {
      const axios = (await import("axios")).default;
      await axios.post(`${workerUrl}/enqueue`, { taskId: task.id });
    } catch (err) {
      console.error("[chief-of-staff] enqueue failed:", err.message);
    }
    created.push(task);
  }

  res.status(201).json({ tasks: created, delegated: created.length });
});

// Creating an employee/agent through Chief of Staff is always an explicit user-approved action.
router.post("/create-agent", async (req, res) => {
  if (req.body?.approved !== true) return res.status(400).json({ error: "Explicit approval is required" });
  const userId = req.user.id;
  const name = String(req.body?.name || "").trim();
  const role = String(req.body?.role || "").trim();
  const goal = String(req.body?.goal || "").trim();
  if (!name || !role || !goal) return res.status(400).json({ error: "name, role and goal are required" });

  const { data: agent, error } = await supabaseAdmin.from("agents").insert({
    user_id: userId,
    name,
    name_source: "user",
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
  res.status(201).json({ agent });
});

export default router;
