import "dotenv/config";
import express from "express";
import { agentTaskQueue, startWorker } from "./lib/queue.js";
import { runTask } from "./lib/agentLoop.js";
import { openRouterStatus } from "./lib/openrouter.js";
import { supabaseAdmin } from "./supabaseClient.js";

const app = express();
app.use(express.json());

app.post("/enqueue", async (req, res) => {
  const taskId = req.body?.taskId || req.body?.task_id || req.body?.id || req.body?.record?.id;
  if (!taskId) return res.status(400).json({ error: "taskId is required" });
  try {
    await agentTaskQueue.add("run-task", {
      taskId,
      agentId: req.body?.agentId || req.body?.agent_id || req.body?.record?.agent_id,
      userId: req.body?.userId || req.body?.user_id || req.body?.record?.user_id,
    }, {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    });
    res.json({ ok: true, taskId });
  } catch (err) {
    console.error("[worker] enqueue failed:", err.message);
    res.status(503).json({ error: "Queue unavailable" });
  }
});

app.post("/resume", async (req, res) => {
  const taskId = req.body?.taskId || req.body?.task_id || req.body?.id || req.body?.record?.id;
  if (!taskId) return res.status(400).json({ error: "taskId is required" });
  try {
    await agentTaskQueue.add("run-task", { taskId, resume: true }, {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    });
    res.json({ ok: true, taskId, resumed: true });
  } catch (err) {
    console.error("[worker] resume failed:", err.message);
    res.status(503).json({ error: "Queue unavailable" });
  }
});

app.get("/metrics", async (req, res) => {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      agentTaskQueue.getWaitingCount(),
      agentTaskQueue.getActiveCount(),
      agentTaskQueue.getCompletedCount(),
      agentTaskQueue.getFailedCount(),
      agentTaskQueue.getDelayedCount(),
    ]);
    res.json({ ok: true, counts: { waiting, active, completed, failed, delayed } });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

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

// Railway provides PORT for the service proxy. Fall back to the existing
// worker-specific port for local/self-hosted runs.
const PORT = Number(process.env.PORT || process.env.WORKER_PORT || 4100);
app.listen(PORT, "0.0.0.0", () => console.log(`[worker] enqueue endpoint listening on :${PORT}`));

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
