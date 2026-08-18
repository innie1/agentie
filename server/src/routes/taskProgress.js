import express from "express";
import { supabaseAdmin } from "../supabaseClient.js";

const router = express.Router();

async function getTask(req, res) {
  const { data, error } = await supabaseAdmin
    .from("tasks")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .single();
  if (error || !data) {
    res.status(404).json({ error: error?.message || "Task not found" });
    return null;
  }
  return data;
}

// Fetch the latest state of a delegated/background task.
router.get("/:id", async (req, res) => {
  const task = await getTask(req, res);
  if (!task) return;
  res.json({ task, status: task.status, result: task.result || task.result_payload || null });
});

// Server-sent events stream for a task. The client can stay in the original
// conversation while the receiving agent moves pending -> in_progress -> done/failed.
router.get("/:id/stream", async (req, res) => {
  const initial = await getTask(req, res);
  if (!initial) return;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  let lastFingerprint = "";
  let timer = null;

  const send = (task) => {
    const payload = {
      task_id: task.id,
      status: task.status,
      result_type: task.result_type || null,
      result: task.result || task.result_payload || null,
      updated_at: task.updated_at || null,
      agent_id: task.agent_id,
    };
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    res.write(`event: task\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  send(initial);

  const terminal = new Set(["done", "failed", "cancelled"]);
  if (terminal.has(initial.status)) {
    res.end();
    return;
  }

  const poll = async () => {
    if (closed) return;
    const { data: task, error } = await supabaseAdmin
      .from("tasks")
      .select("id,agent_id,status,result,result_type,result_payload,updated_at")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (error || !task) {
      if (!closed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: error?.message || "Task not found" })}\n\n`);
        res.end();
      }
      return;
    }
    send(task);
    if (terminal.has(task.status)) {
      clearInterval(timer);
      res.end();
    }
  };

  timer = setInterval(poll, 1200);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15000);

  req.on("close", () => {
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
  });
});

export default router;
