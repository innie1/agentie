// ============================================================================
// AGENTIE BACKGROUND SCHEDULER WORKER
// Trigger scheduled routines on target cron times
// ============================================================================

import { db } from '../db.js';
import { taskQueue } from './taskQueue.js';

class CronSchedulerWorker {
    constructor() {
        this.interval = null;
        this.isRunning = false;
    }

    start(pollIntervalMs = 60000) {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log('[CronScheduler] Background Scheduler Worker initialized (polling every 60s).');

        this.interval = setInterval(() => {
            this.checkAndTriggerScheduledRoutines();
        }, pollIntervalMs);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.isRunning = false;
        console.log('[CronScheduler] Background Scheduler Worker stopped.');
    }

    /**
     * Check if a cron expression matches the current time
     * Format: minute hour day-of-month month day-of-week
     */
    matchesCron(cronStr, date = new Date()) {
        if (!cronStr) return false;
        const parts = cronStr.trim().split(/\s+/);
        if (parts.length !== 5) return false;

        const [min, hr, dom, mon, dow] = parts;

        const curMin = date.getMinutes();
        const curHr = date.getHours();
        const curDom = date.getDate();
        const curMon = date.getMonth() + 1; // 1-12
        const curDow = date.getDay(); // 0-6 (Sun-Sat)

        const matchField = (field, val) => {
            if (field === '*') return true;
            if (field.startsWith('*/')) {
                const step = parseInt(field.split('/')[1], 10);
                return val % step === 0;
            }
            if (field.includes(',')) {
                return field.split(',').map(Number).includes(val);
            }
            if (field.includes('-')) {
                const [start, end] = field.split('-').map(Number);
                return val >= start && val <= end;
            }
            return parseInt(field, 10) === val;
        };

        return matchField(min, curMin) &&
               matchField(hr, curHr) &&
               matchField(dom, curDom) &&
               matchField(mon, curMon) &&
               matchField(dow, curDow);
    }

    /**
     * Poll active routines and spawn scheduled tasks
     */
    checkAndTriggerScheduledRoutines() {
        const now = new Date();
        const activeScheduled = db.routines.filter(r => r.status === 'active' && r.schedule);

        for (const routine of activeScheduled) {
            if (this.matchesCron(routine.schedule, now)) {
                console.log(`[CronScheduler] Triggering scheduled routine '${routine.name}' (${routine.id}) for agent '${routine.agent_id}'`);
                this.triggerRoutineTask(routine);
            }
        }
    }

    /**
     * Create a scheduled task and enqueue
     */
    triggerRoutineTask(routine) {
        const newTask = {
            id: 'task_sched_' + Date.now(),
            user_id: 'default_user',
            agent_id: routine.agent_id,
            instruction: routine.name,
            context: {
                routine_id: routine.id,
                source: 'scheduled',
                schedule_human: routine.schedule_human,
                triggered_at: new Date().toISOString()
            },
            source: 'scheduled',
            routine_id: routine.id,
            status: 'pending',
            current_step: 0,
            steps: routine.steps.map((s, idx) => ({
                stepNumber: idx + 1,
                action: `${s.plugin_id}:${s.action}`,
                description: `${s.plugin_id} > ${s.action}`,
                params: s.params,
                status: 'pending'
            })),
            paused_step_data: null,
            result: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        db.tasks.unshift(newTask);
        taskQueue.enqueue(newTask.id);
    }
}

export const cronScheduler = new CronSchedulerWorker();
