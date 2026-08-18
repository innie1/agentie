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

// POST /api/tasks { agent_id, instruction }
// Ordinary conversation is handled here only for backwards compatibility with
// the existing frontend endpoint. It is deliberately NOT inserted into tasks.
router.post("/", async (req, res) => {
  const userId = req.user.id;
  const { agent_id, instruction, history: suppliedHistory = [] } = req.body;
  if (!agent_id || !instruction) return res.status(400).json({ error: "agent_id and instruction are required" });

  // IMPORTANT: chat is resolved before any task row is created. This prevents
  // normal messages from hitting the task queue and prevents fake/local agent
  // IDs from ever reaching the tasks.agent_id UUID column.
  if (isFastChatMessage(instruction)) {
    try {
      const { data: agent, error: agentError } = await supabaseAdmin
        .from("agents")
        .select("id, name, system_prompt, role, goal")
        .eq("id", agent_id)
        .eq("user_id", userId)
        .single();

      if (agentError || !agent) throw new Error(agentError?.message || "Agent not found");

      const history = Array.isArray(suppliedHistory)
        ? suppliedHistory
            .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
            .slice(-12)
        : [];

      const { text, model } = await fastChat({ agent, message: instruction, history });
      return res.status(200).json({
        chat: {
          id: `chat_${Date.now()}`,
          agent_id: agent.id,
          instruction,
          result: text,
          result_type: "fact",
          result_payload: { mode: "chat", model },
          status: "done",
        },
        fast: true,
      });
    } catch (err) {
      console.error("[tasks] fast chat failed:", err.message);
      return res.status(502).json({ error: "Fast chat failed", detail: err.message });
    }
  }

  // Only messages explicitly identified as actions/tasks reach this point.
  // Validate the agent against Supabase before inserting, so a local id such as
  // agent_1787051641837 can never cause a Postgres UUID error.
  const { data: realAgent, error: realAgentError } = await supabaseAdmin
    .from("agents")
    .select("id")
    .eq("id", agent_id)
    .eq("user_id", userId)
    .single();

  if (realAgentError || !realAgent) {
    return res.status(400).json({
      error: "Invalid agent_id",
      detail: "Tasks require the real Supabase agent UUID. Normal conversation does not create tasks.",
    });
  }

  // Build conversation context from previous real tasks only.
  const { data: previousTasks, error: historyError } = await supabaseAdmin
    .from("tasks")
    .select("instruction, result, result_type, result_payload, status, created_at")
    .eq("user_id", userId)
    .eq("agent_id", realAgent.id)
    .order("created_at", { ascending: false })
    .limit(12);

  if (historyError) console.warn("[tasks] task history load failed:", historyError.message);

  const history = (previousTasks || [])
    .reverse()
    .flatMap((t) => {
      const messages = [];
      if (t.instruction) messages.push({ role: "user", content: t.instruction });
      const assistantText = t.result || t.result_payload?.text || t.result_payload?.summary;
      if (assistantText) messages.push({ role: "assistant", content: String(assistantText).slice(0, 4000) });
      return messages;
    })
    .slice(-12);

  const { data: task, error } = await supabaseAdmin
    .from("tasks")
    .insert({
      user_id: userId,
      agent_id: realAgent.id,
      instruction,
      status: "pending",
      context: { conversation: history },
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  try {
    const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
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
    const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
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
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ task });
});

export default router;
