// ============================================================================
// AGENTIE WORKER — BULLMQ TASK QUEUE (PRODUCER)
// Queue: "agent-tasks"
// ============================================================================

import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';

export const QUEUE_NAME = 'agent-tasks';

export const taskQueue = new Queue(QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3, // 1 initial + 2 retries
        backoff: {
            type: 'exponential',
            delay: 2000 // 2s, 4s, 8s...
        },
        removeOnComplete: {
            age: 86400, // Keep 24 hours
            count: 1000
        },
        removeOnFail: {
            age: 604800, // Keep 7 days
            count: 5000
        }
    }
});

/**
 * Add a task to the agent-tasks queue
 */
export async function enqueueTask({ taskId, agentId, userId = 'default_user', isResume = false }) {
    if (!taskId) throw new Error('taskId is required to enqueue a task.');

    const jobId = `task_${taskId}_${Date.now()}`;
    const job = await taskQueue.add('process-agent-task', {
        taskId,
        agentId,
        userId,
        isResume,
        enqueuedAt: new Date().toISOString()
    }, {
        jobId
    });

    console.log(`📥 [Queue] Enqueued task '${taskId}' for agent '${agentId}' (Job ID: ${job.id}, Resume: ${isResume})`);
    return job;
}

/**
 * Get queue health metrics
 */
export async function getQueueMetrics() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
        taskQueue.getWaitingCount(),
        taskQueue.getActiveCount(),
        taskQueue.getCompletedCount(),
        taskQueue.getFailedCount(),
        taskQueue.getDelayedCount()
    ]);

    return {
        queue: QUEUE_NAME,
        waiting,
        active,
        completed,
        failed,
        delayed
    };
}
