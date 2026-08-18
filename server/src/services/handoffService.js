// ============================================================================
// AGENT-TO-AGENT HANDOFF SERVICE (SPEC 4)
// Allows agents to delegate work with context summaries & logs to task_handoffs
// ============================================================================

import { db } from '../db.js';

/**
 * Creates a delegated task from one agent to another and logs the handoff
 */
export function createAgentHandoff({ fromAgentId, toAgentId, note, contextSummary, instruction }) {
    const fromAgent = db.agents.find(a => a.id === fromAgentId);
    const toAgent = db.agents.find(a => a.id === toAgentId);

    if (!fromAgent) throw new Error(`Source agent '${fromAgentId}' not found.`);
    if (!toAgent) throw new Error(`Target agent '${toAgentId}' not found.`);

    // 1. Create a new task assigned to receiving agent with inherited context
    const taskId = 'task_' + Date.now();
    const newTask = {
        id: taskId,
        user_id: fromAgent.user_id,
        agent_id: toAgentId,
        instruction: instruction || `Delegated from ${fromAgent.name}: ${note}`,
        context: {
            handoffFrom: fromAgent.name,
            handoffFromId: fromAgentId,
            contextSummary: contextSummary,
            inheritedAt: new Date().toISOString()
        },
        status: 'pending',
        current_step: 0,
        steps: [],
        paused_step_data: null,
        result: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    db.tasks.unshift(newTask);

    // 2. Log in task_handoffs table
    const handoffEntry = {
        id: 'ho_' + Date.now(),
        from_agent_id: fromAgentId,
        to_agent_id: toAgentId,
        task_id: taskId,
        note: note,
        context_summary: contextSummary,
        created_at: new Date().toISOString()
    };

    db.task_handoffs.unshift(handoffEntry);

    return {
        task: newTask,
        handoff: handoffEntry
    };
}

/**
 * Gets all handoffs for an agent
 */
export function getAgentHandoffs(agentId) {
    return db.task_handoffs.filter(h => h.from_agent_id === agentId || h.to_agent_id === agentId);
}
