import express from "express";
import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { fastChat, isFastChatMessage } from "../lib/fastChat.js";

const router = express.Router();

// GET /api/tasks?agent_id=
router.get("/", async (req, res) => {
  let q = supabaseAdmin.from("tasks").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false });
  if (req.query.agent_id) q = q.eq("agent_id", req.query.agent_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: data });
});

// POST /api/tasks  { agent_id, instruction }
router.post("/", async (req, res) => {
  const userId = req.user.id;
  const { agent_id, instruction } = req.body;
  if (!agent_id || !instruction) return res.status(400).json({ error: "agent_id and instruction are required" });

  const { data: task, error } = await supabaseAdmin
    .from("tasks")
    .insert({ user_id: userId, agent_id, instruction, status: "pending" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Simple conversation should not wait for Redis/BullMQ. Keep real tasks asynchronous.
  if (isFastChatMessage(instruction)) {
    try {
      const { data: agent, error: agentError } = await supabaseAdmin
        .from("agents")
        .select("id, name, system_prompt, role, goal")
        .eq("id", agent_id)
        .eq("user_id", userId)
        .single();

      if (agentError || !agent) throw new Error(agentError?.message || "Agent not found");

      const { text, model } = await fastChat({ agent, message: instruction });
      const { data: completed, error: completeError } = await supabaseAdmin
        .from("tasks")
        .update({
          status: "done",
          result: text,
          result_type: "fact",
          result_payload: { mode: "chat", model },
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id)
        .eq("user_id", userId)
        .select()
        .single();

      if (completeError) throw new Error(completeError.message);
      return res.status(201).json({ task: completed, fast: true });
    } catch (err) {
      console.error("[tasks] fast chat failed:", err.message);
      const { data: failedTask } = await supabaseAdmin
        .from("tasks")
        .update({
          status: "failed",
          result_type: "failure",
          result_payload: { error: err.message },
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id)
        .eq("user_id", userId)
        .select()
        .single();
      return res.status(502).json({ error: "Fast chat failed", detail: err.message, task: failedTask || task });
    }
  }

  // Real tasks stay asynchronous and go through Redis/BullMQ.
  try {
    const workerUrl = process.env.WORKER_URL || 'https://agentie-production.up.railway.app';
    await axios.post(`${workerUrl}/enqueue`, { taskId: task.id });
  } catch (err) {
    console.error("[tasks] failed to notify worker, task will sit as pending until a webhook picks it up:", err.message);
  }

  res.status(201).json({ task });
});

// POST /api/tasks/:id/approve
router.post("/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { data: task, error } = await supabaseAdmin
    .from("tasks")
    .update({ status: "pending", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", req.user.id)
    .eq("status", "needs_approval")
    .select()
    .single();
  if (error || !task) return res.status(400).json({ error: error?.message || "Task not awaiting approval" });

  try {
    const workerUrl = process.env.WORKER_URL || 'https://agentie-production.up.railway.app';
    await axios.post(`${workerUrl}/enqueue`, { taskId: task.id, resume: true });
  } catch (err) {
    console.error("[tasks] failed to notify worker on resume:", err.message);
  }

  res.json({ task });
});

// POST /api/tasks/:id/reject
router.post("/:id/reject", async (req, res) => {
  const { data: task, error } = await supabaseAdmin
    .from("tasks")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ task });
});

export default router;
