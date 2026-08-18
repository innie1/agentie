import crypto from "node:crypto";
import express from "express";
import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";

const router = express.Router();

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

router.post("/:pluginId", async (req, res) => {
  const expected = process.env.CONNECTOR_WEBHOOK_SECRET;
  if (!expected || !safeEqual(req.get("x-agentie-webhook-secret"), expected)) return res.status(401).json({ error: "Invalid webhook signature" });
  const pluginId = String(req.params.pluginId || "").toLowerCase();
  const externalId = String(req.body?.id || req.body?.event_id || req.get("x-event-id") || "").trim();
  const eventType = String(req.body?.type || req.body?.event_type || "unknown").trim();
  const userId = String(req.body?.user_id || "").trim();
  if (!externalId || !userId) return res.status(400).json({ error: "id and user_id are required" });

  const inserted = await supabaseAdmin.from("connector_events").insert({ user_id: userId, plugin_id: pluginId, external_id: externalId, event_type: eventType, payload: req.body || {} }).select().maybeSingle();
  if (inserted.error?.code === "23505") return res.status(200).json({ ok: true, duplicate: true });
  if (inserted.error) return res.status(500).json({ error: inserted.error.message });

  const { data: routines } = await supabaseAdmin.from("routines").select("*, agents!inner(user_id)").eq("status", "active").eq("agents.user_id", userId);
  const matches = (routines || []).filter((routine) => (Array.isArray(routine.event_triggers) ? routine.event_triggers : []).some((trigger) =>
    trigger?.plugin_id === pluginId && (trigger?.event_type === eventType || trigger?.event_type === "*")
  ));
  const tasks = [];
  for (const routine of matches) {
    const triggerKey = `event:${pluginId}:${externalId}:${routine.id}`;
    const { data: run, error: runError } = await supabaseAdmin.from("routine_runs").insert({ routine_id: routine.id, trigger_type: "event", trigger_key: triggerKey, status: "queued", input: req.body || {} }).select().maybeSingle();
    if (runError || !run) continue;
    const { data: task } = await supabaseAdmin.from("tasks").insert({ user_id: userId, agent_id: routine.agent_id, instruction: routine.name, source: "event", status: "pending", idempotency_key: triggerKey, context: { event: req.body || {}, routine_id: routine.id } }).select().maybeSingle();
    if (!task) continue;
    tasks.push(task.id);
    await supabaseAdmin.from("routine_runs").update({ task_id: task.id }).eq("id", run.id);
    axios.post(`${process.env.WORKER_URL || "https://agentie-production.up.railway.app"}/enqueue`, { taskId: task.id }).catch((error) => console.warn("[webhooks] enqueue failed:", error.message));
  }
  res.status(202).json({ ok: true, triggered_tasks: tasks });
});

export default router;
