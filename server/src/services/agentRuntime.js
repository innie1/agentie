// ============================================================================
// AGENT BEHAVIOR LOOP & RUNTIME ENGINE (SPEC 2, SPEC 5 & ROUTINES SPEC)
// Loop: Plan -> Act -> Observe -> Check Guardrails -> Resume -> Complete
// ============================================================================

import { db } from '../db.js';
import { CONNECTORS, runAction } from '../connectors/registry.js';
import { getAgentMemories, extractAndSaveMemoriesFromTask } from './memoryService.js';
import { matchRoutineTrigger, adaptStepParams, recordRoutineRun } from './routineService.js';

/**
 * Executes or continues the agent behavior loop for a given task
 */
export async function executeTaskLoop(taskId) {
    const task = db.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);

    const agent = db.agents.find(a => a.id === task.agent_id);
    if (!agent) throw new Error(`Agent '${task.agent_id}' not found.`);

    // 1. Check if agent is active
    if (agent.status === 'paused') {
        task.status = 'paused';
        task.result = 'Execution paused because agent status is paused.';
        return task;
    }

    // 2. Pre-load Memory into context
    const agentMemories = getAgentMemories(agent.id);

    // 3. STEP A: PLAN (Check Routine Match first, fallback to dynamic plan)
    if (!task.steps || task.steps.length === 0) {
        task.status = 'in_progress';

        // Check if instruction matches an existing taught Routine
        const matchedRoutine = matchRoutineTrigger(agent.id, task.instruction);

        if (matchedRoutine) {
            task.source = 'routine';
            task.routine_id = matchedRoutine.id;
            task.steps = matchedRoutine.steps.map((s, idx) => ({
                stepNumber: idx + 1,
                action: `${s.plugin_id}:${s.action}`,
                description: `${s.plugin_id} > ${s.action}`,
                params: adaptStepParams(s, task.context || {}),
                status: 'pending'
            }));
            task.context.matched_routine_name = matchedRoutine.name;
        } else {
            task.steps = planSteps(task.instruction, agent.allowed_plugins || agent.allowed_connectors || [], agent.role);
        }

        task.current_step = 0;
        task.updated_at = new Date().toISOString();
    }

    // 4. BEHAVIOR LOOP: Iterate through planned steps
    while (task.current_step < task.steps.length) {
        const step = task.steps[task.current_step];
        const [connectorId, actionName] = step.action.split(':');

        const allowedList = agent.allowed_plugins || agent.allowed_connectors || [];

        // Check if agent is authorized for this connector/plugin
        if (!allowedList.includes(connectorId)) {
            task.status = 'failed';
            task.result = `Security Guardrail Error: Agent '${agent.name}' is not authorized to use plugin '${connectorId}'.`;
            logAction(agent.id, task.id, step.action, step.params, { error: 'Unauthorized plugin' }, 'failed');
            if (task.routine_id) recordRoutineRun(task.routine_id, 'failed');
            return task;
        }

        const connector = CONNECTORS[connectorId];
        const actionDef = connector?.actions[actionName];

        // 5. STEP D: CHECK GUARDRAILS (Approval Gate for Irreversible Actions)
        const isIrreversible = actionDef?.irreversible === true;
        const isAutoApproved = (agent.auto_approved_actions || []).includes(step.action);

        if (isIrreversible && !isAutoApproved && step.status !== 'approved_by_user') {
            task.status = 'needs_approval';
            task.paused_step_data = {
                stepIndex: task.current_step,
                action: step.action,
                actionDescription: actionDef?.description || step.description,
                params: step.params || {},
                reason: `Irreversible action '${step.action}' requires user approval before execution.`
            };
            task.updated_at = new Date().toISOString();

            logAction(agent.id, task.id, step.action, step.params, { guardrail: 'Paused for approval' }, 'blocked_guardrail');
            if (task.routine_id) recordRoutineRun(task.routine_id, 'needs_approval');
            return task;
        }

        // 6. STEP B & C: ACT & OBSERVE
        step.status = 'in_progress';
        try {
            const actionResult = await runAction(connectorId, actionName, step.params || {});
            step.status = 'completed';
            step.result = actionResult;

            logAction(agent.id, task.id, step.action, step.params, actionResult, 'success');

            task.current_step++;
            task.updated_at = new Date().toISOString();
        } catch (err) {
            step.status = 'failed';
            step.error = err.message;
            task.status = 'failed';
            task.result = `Execution failed on step ${task.current_step + 1}: ${err.message}`;
            logAction(agent.id, task.id, step.action, step.params, { error: err.message }, 'failed');
            if (task.routine_id) recordRoutineRun(task.routine_id, 'failed');
            return task;
        }
    }

    // 7. STEP F: COMPLETE & MEMORY EXTRACTION & ROUTINE SUCCESS LOGGING
    task.status = 'done';
    task.result = generateResultSummary(task.instruction, task.steps);
    task.paused_step_data = null;
    task.updated_at = new Date().toISOString();

    if (task.routine_id) {
        recordRoutineRun(task.routine_id, 'success');
    }

    // Extract notable facts into persistent agent_memory
    extractAndSaveMemoriesFromTask(agent.id, task);

    return task;
}

/**
 * Approve a paused task and resume the loop from the paused step
 */
export async function approveAndResumeTask(taskId) {
    const task = db.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);

    if (task.status !== 'needs_approval') {
        throw new Error(`Task '${taskId}' is in status '${task.status}' and cannot be resumed from approval.`);
    }

    const pausedStep = task.steps[task.current_step];
    if (pausedStep) {
        pausedStep.status = 'approved_by_user';
    }

    task.status = 'in_progress';
    task.paused_step_data = null;
    task.updated_at = new Date().toISOString();

    return await executeTaskLoop(taskId);
}

/**
 * Reject a paused task
 */
export function rejectTask(taskId, reason = 'Rejected by user') {
    const task = db.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);

    task.status = 'failed';
    task.result = `Execution rejected by user: ${reason}`;
    task.paused_step_data = null;
    task.updated_at = new Date().toISOString();

    if (task.routine_id) {
        recordRoutineRun(task.routine_id, 'failed');
    }

    return task;
}

/**
 * Helper: Plan steps from instruction and allowed connectors
 */
function planSteps(instruction, allowedConnectors = [], agentRole = '') {
    const steps = [];
    const text = instruction.toLowerCase();

    if (text.includes('lead') || text.includes('contact') || text.includes('crm') || text.includes('acme')) {
        if (allowedConnectors.includes('hubspot')) {
            steps.push({
                stepNumber: 1,
                action: 'hubspot:search_contacts',
                description: 'Search CRM contacts directory for target accounts',
                params: { query: 'Acme Corp' },
                status: 'pending'
            });
        }
        if (allowedConnectors.includes('notion')) {
            steps.push({
                stepNumber: steps.length + 1,
                action: 'notion:read_page',
                description: 'Load outbound sales playbook & account context',
                params: { page_title: 'Outreach Playbook' },
                status: 'pending'
            });
        }
        if (allowedConnectors.includes('gmail')) {
            steps.push({
                stepNumber: steps.length + 1,
                action: 'gmail:draft_email',
                description: 'Draft personalized executive outreach email',
                params: { to: 'dana.vance@acme.com', subject: 'Platform Partnership Discussion' },
                status: 'pending'
            });
        }
    } else if (text.includes('sync') || text.includes('team') || text.includes('slack')) {
        if (allowedConnectors.includes('slack')) {
            steps.push({
                stepNumber: 1,
                action: 'slack:read_channel',
                description: 'Scan updates and announcements in #general channel',
                params: { channel: '#general' },
                status: 'pending'
            });
        }
        if (allowedConnectors.includes('notion')) {
            steps.push({
                stepNumber: steps.length + 1,
                action: 'notion:create_page',
                description: 'Publish consolidated status document in Notion workspace',
                params: { title: 'Executive Sync Notes' },
                status: 'pending'
            });
        }
    } else {
        const primaryConnector = allowedConnectors[0] || 'notion';
        steps.push({
            stepNumber: 1,
            action: `${primaryConnector}:read_page`,
            description: `Inspect ${primaryConnector} records for task parameters`,
            params: { instruction },
            status: 'pending'
        });
    }

    return steps;
}

/**
 * Helper: Generate summary upon completion
 */
function generateResultSummary(instruction, steps = []) {
    const completedCount = steps.filter(s => s.status === 'completed' || s.status === 'approved_by_user').length;
    return `Completed ${completedCount}/${steps.length} steps for: "${instruction}". All actions executed and verified against allowed connectors and guardrails.`;
}

/**
 * Helper: Log action to action_log table
 */
function logAction(agentId, taskId, action, params, result, status) {
    db.action_log.unshift({
        id: 'act_' + Date.now(),
        agent_id: agentId,
        task_id: taskId,
        action,
        params,
        result,
        status,
        timestamp: new Date().toISOString()
    });
}
