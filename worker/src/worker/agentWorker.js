// ============================================================================
// AGENTIE WORKER — BULLMQ CONSUMER PROCESS (SPEC 3, 4, 7)
// Listens on "agent-tasks" queue and executes tasks one by one
// ============================================================================

import { Worker } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { QUEUE_NAME } from '../queue/taskQueue.js';
import { runAgentTaskLoop } from '../services/agentLoop.js';

// Track currently running agent task executions to prevent race conditions on the same agent
const activeAgentJobs = new Set();

export function startAgentWorker() {
    const worker = new Worker(QUEUE_NAME, async (job) => {
        const { taskId, agentId, userId, isResume } = job.data;

        // Ensure concurrency isolation per agent
        if (agentId && activeAgentJobs.has(agentId)) {
            console.warn(`⏳ [Worker] Agent '${agentId}' already has an active running task. Delaying job '${job.id}'...`);
            throw new Error(`Agent '${agentId}' is currently busy executing another task.`);
        }

        if (agentId) activeAgentJobs.add(agentId);

        try {
            console.log(`⚙️ [Worker] Processing Job ${job.id} (Task: ${taskId}, Attempt: ${job.attemptsMade + 1})`);
            const result = await runAgentTaskLoop({ taskId, agentId, userId, isResume });
            return result;
        } finally {
            if (agentId) activeAgentJobs.delete(agentId);
        }
    }, {
        connection: redisConnection,
        concurrency: 5 // Process up to 5 tasks concurrently across different agents
    });

    worker.on('completed', (job, result) => {
        console.log(`✨ [Worker] Job ${job.id} COMPLETED with status: ${result?.status}`);
    });

    worker.on('failed', (job, err) => {
        console.error(`💥 [Worker] Job ${job?.id} FAILED (Attempt ${job?.attemptsMade}): ${err.message}`);
    });

    worker.on('error', (err) => {
        console.warn(`⚠️ [Worker] Worker internal error: ${err.message}`);
    });

    console.log(`👷 [Worker] Agent Worker consumer started on queue '${QUEUE_NAME}' (Concurrency: 5)`);
    return worker;
}
