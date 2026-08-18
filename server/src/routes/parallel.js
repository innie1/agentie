import express from "express";
import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.post("/", async (req, res) => {
  const userId = req.user.id;
  const { agent_tasks, history = [] } = req.body || {};
  if (!Array.isArray(agent_tasks) || agent_tasks.length < 2) {
    return res.status(400).json({ error: "agent_tasks must contain at least 2 agent/task items" });
  }
  if (agent_tasks.length > 10) return res.status(400).json({ error: "A parallel request can contain at most 10 agents" });

  const ids = agent_tasks.map(x => x?.agent_id).filter(Boolean);
  if (ids.length !== agent_tasks.length || new Set(ids).size !== ids.length || ids.some(id => !UUID_RE.test(String(id)))) {
    return res.status(400).json({ error: "Every agent_id must be a unique valid UUID" });
  }

  const { data: agents, error: agentError } = await supabaseAdmin
    .from("agents")
    .select("id,name,role,goal,character,tags,allowed_plugins,status")
    .eq("user_id", userId)
    .in("id", ids);
  if (agentError) return res.status(500).json({ error: agentError.message });
  if ((agents || []).length !== ids.length) return res.status(403).json({ error: "One or more agents do not belong to this user" });

  const byId = new Map((agents || []).map(a => [a.id, a]));
  const rows = agent_tasks.map(item => ({
    user_id: userId,
    agent_id: item.agent_id,
    instruction: String(item.instruction || "").trim(),
    status: "pending",
    source: "parallel",
    context: { conversation: Array.isArray(history) ? history.slice(-12) : [], parallel: true },
  }));
  if (rows.some(row => !row.instruction)) return res.status(400).json({ error: "Every parallel task needs an instruction" });

  const { data: tasks, error: taskError } = await supabaseAdmin.from("tasks").insert(rows).select();
  if (taskError) return res.status(500).json({ error: taskError.message });

  const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
  const enqueueResults = await Promise.allSettled((tasks || []).map(task => axios.post(`${workerUrl}/enqueue`, {
    taskId: task.id, agentId: task.agent_id, userId,
  }, { timeout: 10000 })));
  const failedEnqueues = enqueueResults.filter(r => r.status === "rejected").length;

  res.status(201).json({
    parallel: true,
    status: failedEnqueues ? "partially_queued" : "working",
    tasks: (tasks || []).map(task => ({ task, agent: byId.get(task.agent_id) })),
    queued: (tasks || []).length - failedEnqueues,
    failed_enqueues: failedEnqueues,
  });
});

router.get("/:id", async (req, res) => {
  const { data: task, error } = await supabaseAdmin.from("tasks").select("*").eq("id", req.params.id).eq("user_id", req.user.id).single();
  if (error || !task) return res.status(404).json({ error: "Task not found" });
  res.json({ task });
});

export default router;
