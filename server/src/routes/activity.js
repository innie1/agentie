import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";
import { activityFromLog } from "../lib/activity.js";

const router = express.Router();

router.get("/", async (req, res) => {
  let query = supabaseAdmin.from("agent_events").select("*").eq("user_id", String(req.user.id)).order("created_at", { ascending: false }).limit(Math.min(Number(req.query.limit) || 100, 500));
  if (req.query.agent_id) query = query.eq("agent_id", req.query.agent_id);
  if (req.query.task_id) query = query.eq("task_id", req.query.task_id);
  const events = await query;
  if (!events.error) return res.json({ events: events.data || [] });

  let fallback = supabaseAdmin.from("action_log").select("*, agents!inner(user_id)").eq("agents.user_id", req.user.id).like("action", "runtime.%").order("created_at", { ascending: false }).limit(100);
  if (req.query.agent_id) fallback = fallback.eq("agent_id", req.query.agent_id);
  if (req.query.task_id) fallback = fallback.eq("task_id", req.query.task_id);
  const { data, error } = await fallback;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: (data || []).map(activityFromLog) });
});

export default router;
