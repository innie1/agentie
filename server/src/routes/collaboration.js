import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import axios from "axios";

const router = express.Router();

async function getAgent(id, userId) {
  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("id,name,role,goal,status,allowed_handoff_agents,auto_approved_actions")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error("Agent not found");
  return data;
}

router.get("/handoffs", async (req, res) => {
  const userId = req.user.id;
  const { data, error } = await supabaseAdmin
    .from("task_handoffs")
    .select("*, from_agent:from_agent_id(id,name), to_agent:to_agent_id(id,name)")
    .in("from_agent_id", (await supabaseAdmin.from("agents").select("id").eq("user_id", userId)).data?.map(a => a.id) || [])
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ handoffs: data || [] });
});

router.post("/handoff", async (req, res) => {
  const userId = req.user.id;
  const { from_agent_id, to_agent_id, instruction, note = "" } = req.body;
  if (!from_agent_id || !to_agent_id || !instruction) {
    return res.status(400).json({ error: "from_agent_id, to_agent_id and instruction are required" });
  }
  if (from_agent_id === to_agent_id) return res.status(400).json({ error: "An agent cannot hand work to itself" });

  try {
    const [fromAgent, toAgent] = await Promise.all([
      getAgent(from_agent_id, userId),
      getAgent(to_agent_id, userId),
    ]);

    const allowed = Array.isArray(fromAgent.allowed_handoff_agents) && fromAgent.allowed_handoff_agents.length > 0
      ? fromAgent.allowed_handoff_agents.includes(toAgent.id)
      : true;
    if (!allowed) return res.status(403).json({ error: `${fromAgent.name} is not permitted to delegate to ${toAgent.name}` });

    const { data: task, error: taskError } = await supabaseAdmin.from("tasks").insert({
      user_id: userId,
      agent_id: toAgent.id,
      instruction,
      status: "pending",
      source: "handoff",
      result_payload: { delegated_by: fromAgent.id, delegated_by_name: fromAgent.name, note },
    }).select().single();
    if (taskError) return res.status(500).json({ error: taskError.message });

    const { data: handoff, error: handoffError } = await supabaseAdmin.from("task_handoffs").insert({
      from_agent_id: fromAgent.id,
      to_agent_id: toAgent.id,
      task_id: task.id,
      note: note || instruction,
      context_summary: note || instruction,
    }).select().single();
    if (handoffError) return res.status(500).json({ error: handoffError.message });

    try {
      const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
      await axios.post(`${workerUrl}/enqueue`, { taskId: task.id });
    } catch (err) {
      console.error("[collaboration] worker enqueue failed:", err.message);
    }

    res.status(201).json({ task, handoff, from_agent: fromAgent, to_agent: toAgent });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/agents", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("agents")
    .select("id,name,role,goal,status,allowed_handoff_agents,auto_approved_actions")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ agents: data || [] });
});

export default router;
