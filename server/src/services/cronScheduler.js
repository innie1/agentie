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

    zonedDate(date, timezone = 'UTC') {
        try {
            const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
                timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
            }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
            const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
            return { getMinutes: () => Number(parts.minute), getHours: () => Number(parts.hour), getDate: () => Number(parts.day), getMonth: () => Number(parts.month) - 1, getDay: () => day };
        } catch { return date; }
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
                if (this.matchesCron(routine.schedule, this.zonedDate(now, routine.timezone || 'UTC'))) {
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
        const triggerKey = `schedule:${new Date().toISOString().slice(0, 16)}:${routine.timezone || 'UTC'}`;
        try {
            const { data: run, error: runError } = await supabaseAdmin.from('routine_runs').insert({
                routine_id: routine.id, trigger_type: 'schedule', trigger_key: triggerKey,
                status: 'queued', input: { scheduled_for: new Date().toISOString(), timezone: routine.timezone || 'UTC' },
            }).select().maybeSingle();
            if (runError || !run) return;
            const { data: task, error } = await supabaseAdmin
                .from('tasks')
                .insert({
                    user_id: userId,
                    agent_id: routine.agent_id,
                    instruction: `Execute routine "${routine.name}": ${routine.parameters?.instruction || routine.description || routine.name}`,
                    status: 'pending',
                    source: 'scheduled',
                    context: { routine_id: routine.id, routine_name: routine.name, timezone: routine.timezone || 'UTC' },
                    idempotency_key: `${routine.id}:${triggerKey}`
                })
                .select()
                .single();

            if (error || !task) return;
            await supabaseAdmin.from('routine_runs').update({ task_id: task.id }).eq('id', run.id);

            // Notify worker queue
            const workerUrl = process.env.WORKER_URL || 'https://agentie-production.up.railway.app';
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
