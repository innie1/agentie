import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    return Math.min(times * 2000, 15000);
  }
});

connection.on("error", (err) => {
  console.log(`ℹ️ [Worker Queue] Redis: ${err.code || err.message}`);
});

export const agentTaskQueue = new Queue("agent-tasks", { connection });

export function startWorker(processFn) {
  // concurrency: 5 lets up to 5 different tasks run at once across all agents/users.
  return new Worker(
    "agent-tasks",
    async (job) => {
      await processFn(job.data);
    },
    { connection, concurrency: 5 }
  );
}
