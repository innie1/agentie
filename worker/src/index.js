import "dotenv/config";
import express from "express";
import { agentTaskQueue, startWorker } from "./lib/queue.js";
import { runTask } from "./lib/agentLoop.js";
import { supabaseAdmin } from "./supabaseClient.js";

// ── HTTP endpoint the server calls to enqueue a task the moment it's created ──
const app = express();
app.use(express.json());

app.post("/enqueue", async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: "taskId is required" });
  await agentTaskQueue.add("run-task", { taskId }, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  });
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.WORKER_PORT || 4100;
app.listen(PORT, () => console.log(`[worker] enqueue endpoint listening on :${PORT}`));

// ── BullMQ processor — this is what actually runs the agent loop ──
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

// ── Recovery on boot: pick up any task left "pending" from before a crash/redeploy ──
async function recoverPendingTasks() {
  const { data: pending } = await supabaseAdmin.from("tasks").select("id").eq("status", "pending");
  for (const t of pending || []) {
    await agentTaskQueue.add("run-task", { taskId: t.id });
  }
  if (pending?.length) console.log(`[worker] re-enqueued ${pending.length} pending task(s) on boot`);
}
recoverPendingTasks();

console.log("[worker] Agentie worker up. Waiting for tasks...");
