import "dotenv/config";
import express from "express";
import { agentTaskQueue, startWorker } from "./lib/queue.js";
import { runTask } from "./lib/agentLoop.js";
import { openRouterStatus } from "./lib/openrouter.js";
import { supabaseAdmin } from "./supabaseClient.js";

const app = express();
app.use(express.json());

app.post("/enqueue", async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: "taskId is required" });
  try {
    await agentTaskQueue.add("run-task", { taskId }, {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[worker] enqueue failed:", err.message);
    res.status(503).json({ error: "Queue unavailable" });
  }
});

// Keep health checks fast and dependency-light. Railway must be able to reach
// this endpoint even when Supabase/Redis/OpenRouter are temporarily unavailable.
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    openrouter_key_present: !!process.env.OPENROUTER_API_KEY,
    openrouter_last_call: openRouterStatus.lastCallOk,
    openrouter_last_error: openRouterStatus.lastError,
    openrouter_last_checked_at: openRouterStatus.lastCheckedAt,
    redis_url_present: !!process.env.REDIS_URL,
    encryption_key_present: !!process.env.CREDENTIALS_ENCRYPTION_KEY,
  });
});

const PORT = process.env.WORKER_PORT || 4100;
app.listen(PORT, () => console.log(`[worker] enqueue endpoint listening on :${PORT}`));

const bullWorker = startWorker(async ({ taskId }) => {
  console.log(`[worker] picked up task ${taskId}`);
  await runTask(taskId);
  console.log(`[worker] finished task ${taskId}`);
});

bullWorker.on("failed", async (job, err) => {
  console.error(`[worker] job ${job.id} failed after retries:`, err.message);
  if (job?.data?.taskId) {
    await supabaseAdmin.from("tasks").update({
      status: "failed",
      result_type: "failure",
      result_payload: { error: `Job failed after retries: ${err.message}` },
      updated_at: new Date().toISOString(),
    }).eq("id", job.data.taskId);
  }
});

async function recoverPendingTasks() {
  const { data: pending } = await supabaseAdmin.from("tasks").select("id").eq("status", "pending");
  for (const t of pending || []) await agentTaskQueue.add("run-task", { taskId: t.id });
  if (pending?.length) console.log(`[worker] re-enqueued ${pending.length} pending task(s) on boot`);
}
recoverPendingTasks().catch((err) => console.error("[worker] pending-task recovery failed:", err.message));

if (!process.env.OPENROUTER_API_KEY) {
  console.warn("[worker] ⚠️ OPENROUTER_API_KEY is not set — AI tasks will fail until configured.");
}
if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
  console.warn("[worker] ⚠️ CREDENTIALS_ENCRYPTION_KEY is not set — encrypted credentials cannot be used.");
}

console.log("[worker] Agentie worker up. Waiting for tasks...");
