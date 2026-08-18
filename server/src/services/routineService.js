// ============================================================================
// AGENTIE ROUTINE SERVICE
// Teach Mode (Recording), Trigger Matching, Dynamic Adaptation & Replay Learning
// ============================================================================

import { db } from '../db.js';

// In-memory active recording sessions
const activeRecordings = new Map();

/**
 * Convert Plain English Schedule Expression to Standard Cron
 * e.g. "every day at 1pm" -> "0 13 * * *"
 * e.g. "every Monday at 9am" -> "0 9 * * 1"
 */
export function parsePlainScheduleToCron(input) {
    if (!input || typeof input !== 'string') return { cron: null, human: null };
    const str = input.toLowerCase().trim();

    // Direct cron detection
    if (/^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/.test(str)) {
        return { cron: str, human: str };
    }

    let hour = 13; // default 1pm
    let minute = 0;

    // Extract time like "1pm", "1:30pm", "9am", "13:00"
    const timeMatch = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        const ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : null;

        if (ampm === 'pm' && h < 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;

        hour = h;
        minute = m;
    }

    const humanTime = `${hour % 12 === 0 ? 12 : hour % 12}:${minute.toString().padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;

    if (str.includes('hour') || str.includes('every 2 hours')) {
        return { cron: '0 */2 * * *', human: 'Every 2 Hours (24/7)' };
    }
    if (str.includes('monday')) {
        return { cron: `${minute} ${hour} * * 1`, human: `Weekly on Monday at ${humanTime}` };
    }
    if (str.includes('friday')) {
        return { cron: `${minute} ${hour} * * 5`, human: `Weekly on Friday at ${humanTime}` };
    }
    if (str.includes('weekday') || str.includes('mon-fri')) {
        return { cron: `${minute} ${hour} * * 1-5`, human: `Weekdays (Mon-Fri) at ${humanTime}` };
    }
    if (str.includes('weekly')) {
        return { cron: `${minute} ${hour} * * 1`, human: `Weekly on Monday at ${humanTime}` };
    }
    
    // Default daily
    return { cron: `${minute} ${hour} * * *`, human: `Every day at ${humanTime}` };
}

/**
 * Start a Teach Mode recording session for an agent
 */
export function startRecordingSession(agentId) {
    const sessionId = 'rec_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const session = {
        id: sessionId,
        agent_id: agentId,
        started_at: new Date().toISOString(),
        steps: []
    };
    activeRecordings.set(sessionId, session);
    return session;
}

/**
 * Capture a plugin action during active Teach Mode recording
 */
export function captureSessionStep(sessionId, { plugin_id, action, params = {}, screenshot = null }) {
    const session = activeRecordings.get(sessionId);
    if (!session) throw new Error(`Active recording session '${sessionId}' not found.`);

    const stepIndex = session.steps.length + 1;
    const dynamicKeys = [];

    // Auto-detect dynamic parameter fields (e.g. date strings, today query words)
    for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string') {
            if (v.toLowerCase().includes('today') || v.toLowerCase().includes('now') || v.toLowerCase().includes('current')) {
                dynamicKeys.push(k);
            }
        }
    }

    const step = {
        step_number: stepIndex,
        plugin_id,
        action,
        params,
        dynamic_keys: dynamicKeys,
        screenshot,
        timestamp: new Date().toISOString()
    };

    session.steps.push(step);
    return step;
}

/**
 * Save the recorded steps as a permanent Routine
 */
export function saveRecordingSession(sessionId, { name, trigger_patterns = [], schedule_input = null }) {
    const session = activeRecordings.get(sessionId);
    if (!session) throw new Error(`Recording session '${sessionId}' not found.`);

    if (session.steps.length === 0) {
        throw new Error('Cannot save empty routine. Record at least one action step.');
    }

    // Auto-suggest trigger pattern if none provided
    const triggers = trigger_patterns.length > 0 ? trigger_patterns : [
        `Run ${name.toLowerCase()}`,
        `Execute ${name.toLowerCase()}`,
        name.toLowerCase()
    ];

    const { cron, human } = schedule_input ? parsePlainScheduleToCron(schedule_input) : { cron: null, human: null };

    const newRoutine = {
        id: 'rout_' + Date.now(),
        agent_id: session.agent_id,
        name: name || 'Custom Routine',
        steps: session.steps,
        trigger_pattern: triggers,
        schedule: cron,
        schedule_human: human,
        dynamic_fields: {},
        success_count: 0,
        last_run_at: null,
        last_run_status: null,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    db.routines.unshift(newRoutine);
    activeRecordings.delete(sessionId);
    return newRoutine;
}

/**
 * Semantic & Pattern Matching for incoming task instructions
 * Checks if instruction triggers an existing routine
 */
export function matchRoutineTrigger(agentId, instruction) {
    if (!instruction) return null;
    const cleanInst = instruction.toLowerCase().trim();

    // Get active routines for this agent
    const agentRoutines = db.routines.filter(r => r.agent_id === agentId && r.status === 'active');

    for (const routine of agentRoutines) {
        // 1. Direct name match
        if (cleanInst === routine.name.toLowerCase() || cleanInst.includes(routine.name.toLowerCase())) {
            return routine;
        }

        // 2. Pattern list check
        if (Array.isArray(routine.trigger_pattern)) {
            for (const pattern of routine.trigger_pattern) {
                const cleanPattern = pattern.toLowerCase().trim();
                if (cleanInst.includes(cleanPattern) || cleanPattern.includes(cleanInst)) {
                    return routine;
                }
            }
        }
    }

    return null;
}

/**
 * Adapt dynamic parameters before replay
 * e.g. {{today_summary}} or {{date}}
 */
export function adaptStepParams(step, context = {}) {
    const params = { ...step.params };
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    for (const key of Object.keys(params)) {
        if (typeof params[key] === 'string') {
            params[key] = params[key]
                .replace(/\{\{today_date\}\}/g, todayStr)
                .replace(/\{\{current_time\}\}/g, now.toLocaleTimeString())
                .replace(/\{\{target_company\}\}/g, context.targetCompany || 'Target Account')
                .replace(/\{\{today_summary\}\}/g, context.summary || 'Summary for ' + todayStr);
        }
    }
    return params;
}

/**
 * Record a routine run outcome & update self-improving stats
 */
export function recordRoutineRun(routineId, status = 'success', stepPatch = null) {
    const routine = db.routines.find(r => r.id === routineId);
    if (!routine) return null;

    routine.last_run_at = new Date().toISOString();
    routine.last_run_status = status;
    routine.updated_at = new Date().toISOString();

    if (status === 'success') {
        routine.success_count = (routine.success_count || 0) + 1;
    }

    // Apply self-improving correction patch if user adjusted parameters
    if (stepPatch && Array.isArray(stepPatch)) {
        routine.steps = stepPatch;
    }

    return routine;
}
