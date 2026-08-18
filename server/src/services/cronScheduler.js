// ============================================================================
// AGENTIE BACKGROUND SCHEDULER WORKER (SUPABASE PERSISTENCE)
// Trigger scheduled routines on target cron times
// ============================================================================

import axios from 'axios';
import { supabaseAdmin } from '../supabaseClient.js';

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
     * Poll active routines from Supabase and spawn scheduled tasks
     */
    async checkAndTriggerScheduledRoutines() {
        const now = new Date();
        try {
            const { data: activeScheduled, error } = await supabaseAdmin
                .from('routines')
                .select('*, agents!inner(user_id)')
                .eq('status', 'active')
                .not('schedule', 'is', null);

            if (error || !activeScheduled) return;

            for (const routine of activeScheduled) {
                if (this.matchesCron(routine.schedule, now)) {
                    console.log(`[CronScheduler] Triggering scheduled routine '${routine.name}' (${routine.id})`);
                    await this.triggerRoutineTask(routine);
                }
            }
        } catch (err) {
            // Silently handle offline/polling errors
        }
    }

    /**
     * Create a scheduled task in Supabase and notify worker
     */
    async triggerRoutineTask(routine) {
        const userId = routine.agents?.user_id || 'default_user';
        try {
            const { data: task, error } = await supabaseAdmin
                .from('tasks')
                .insert({
                    user_id: userId,
                    agent_id: routine.agent_id,
                    instruction: routine.name,
                    status: 'pending',
                    source: 'scheduled'
                })
                .select()
                .single();

            if (error || !task) return;

            // Notify worker queue
            const workerUrl = process.env.WORKER_URL || 'http://localhost:4100';
            try {
                await axios.post(`${workerUrl}/enqueue`, { taskId: task.id });
            } catch (notifyErr) {
                console.warn('[CronScheduler] worker enqueue notification:', notifyErr.message);
            }
        } catch (err) {
            console.error('[CronScheduler] failed to trigger routine task:', err.message);
        }
    }
}

export const cronScheduler = new CronSchedulerWorker();
