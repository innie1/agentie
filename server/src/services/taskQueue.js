// ============================================================================
// ASYNC BACKGROUND TASK QUEUE WORKER (SPEC 6)
// Non-blocking queue worker processing tasks concurrently per agent
// ============================================================================

import { db } from '../db.js';
import { executeTaskLoop } from './agentRuntime.js';

class TaskQueueWorker {
    constructor() {
        this.isProcessing = false;
        this.queue = [];
        this.activeWorkers = new Map(); // agentId -> boolean
    }

    /**
     * Enqueue a task for asynchronous processing
     */
    enqueue(taskId) {
        if (!this.queue.includes(taskId)) {
            this.queue.push(taskId);
        }
        this.processNext();
    }

    /**
     * Continuous background processor
     */
    async processNext() {
        if (this.queue.length === 0) return;

        const taskId = this.queue.shift();
        const task = db.tasks.find(t => t.id === taskId);
        if (!task) return;

        // Ensure concurrency per agent
        const agentId = task.agent_id;
        if (this.activeWorkers.get(agentId)) {
            // Agent is currently busy, requeue and delay slightly
            this.queue.push(taskId);
            setTimeout(() => this.processNext(), 200);
            return;
        }

        this.activeWorkers.set(agentId, true);

        try {
            await executeTaskLoop(taskId);
        } catch (err) {
            console.error(`[Worker Error] Task ${taskId} failed:`, err);
        } finally {
            this.activeWorkers.delete(agentId);
            // Process remaining items in queue
            if (this.queue.length > 0) {
                setTimeout(() => this.processNext(), 50);
            }
        }
    }
}

export const taskQueue = new TaskQueueWorker();
