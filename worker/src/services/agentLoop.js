// ============================================================================
// AGENTIE WORKER — PLAN / ACT / OBSERVE RUNTIME LOOP & RESUME LOGIC (SPEC 4 & 5)
// ============================================================================

import { supabase, isSupabaseConfigured } from '../config/supabase.js';
import { callOpenRouterAI } from './openRouter.js';
import { executePluginAction, PLUGIN_ACTIONS } from './plugins.js';

/**
 * Execute the agent task loop with full guardrail gating and resume state
 */
export async function runAgentTaskLoop({ taskId, agentId, userId = 'default_user', isResume = false }) {
    console.log(`🚀 [AgentLoop] Starting execution for Task '${taskId}' (Agent: ${agentId}, Resume: ${isResume})`);

    // 1. Fetch Task from Supabase
    let task = null;
    if (isSupabaseConfigured) {
        const { data, error } = await supabase.from('tasks').select('*').eq('id', taskId).single();
        if (error || !data) {
            throw new Error(`Task '${taskId}' not found in Supabase: ${error?.message}`);
        }
        task = data;
    } else {
        // Mock fallback for local dev
        task = {
            id: taskId,
            agent_id: agentId,
            user_id: userId,
            instruction: 'Analyze recent outreach leads and draft follow-up',
            status: 'pending',
            current_step: 0,
            steps: [],
            result_payload: {}
        };
    }

    // 2. Update status to in_progress (Realtime pushes to frontend immediately)
    await updateTaskInSupabase(taskId, {
        status: 'in_progress',
        updated_at: new Date().toISOString()
    });

    // 3. Fetch Agent Config from Supabase
    let agent = {
        id: agentId,
        name: 'Apollo',
        role: 'Sales Representative',
        goal: 'Find high-intent leads and draft outreach',
        allowed_plugins: ['gmail', 'hubspot', 'notion', 'gcal'],
        auto_approved_actions: ['hubspot:search_contacts', 'notion:read_page'],
        system_prompt: 'You are an autonomous AI specialist.'
    };

    if (isSupabaseConfigured && agentId) {
        const { data: agentData } = await supabase.from('agents').select('*').eq('id', agentId).single();
        if (agentData) agent = agentData;
    }

    // 4. Fetch Agent Long-Term Memories
    let memories = [];
    if (isSupabaseConfigured && agentId) {
        const { data: memData } = await supabase.from('agent_memory').select('*').eq('agent_id', agentId);
        if (memData) memories = memData;
    }

    const memoryContext = memories.length > 0
        ? `\n\nLONG-TERM MEMORY & PREFERENCES:\n${memories.map(m => `- ${m.key}: ${m.value}`).join('\n')}`
        : '';

    // 5. RESUME LOGIC (SPEC 5)
    // Check if task is resuming from a saved loop state in result_payload
    const savedState = task.result_payload?.saved_loop_state;
    let steps = [];
    let currentStepIndex = 0;
    let accumulatedContext = {};

    if (isResume && savedState && savedState.steps?.length > 0) {
        console.log(`🔁 [AgentLoop] Resuming task '${taskId}' from saved step index ${savedState.current_step}`);
        steps = savedState.steps;
        currentStepIndex = savedState.current_step || 0;
        accumulatedContext = savedState.accumulated_context || {};
        
        // Mark the previously paused step as approved
        if (steps[currentStepIndex]) {
            steps[currentStepIndex].status = 'approved_by_user';
        }
    } else {
        // Plan steps from instruction & allowed plugins
        steps = planTaskSteps(task.instruction, agent.allowed_plugins || []);
        currentStepIndex = 0;
    }

    // 6. BEHAVIOR LOOP: Iterate through planned steps
    while (currentStepIndex < steps.length) {
        const step = steps[currentStepIndex];
        const [pluginId, actionName] = step.action.split(':');
        const allowedList = agent.allowed_plugins || [];

        // Check plugin permission
        if (!allowedList.includes(pluginId)) {
            const errorMsg = `Security Guardrail Error: Agent '${agent.name}' is not authorized to use plugin '${pluginId}'.`;
            await updateTaskInSupabase(taskId, {
                status: 'failed',
                result_type: 'failure',
                result_payload: { error: errorMsg, failed_step: step },
                updated_at: new Date().toISOString()
            });
            throw new Error(errorMsg);
        }

        const actionDef = PLUGIN_ACTIONS[step.action];
        const isIrreversible = actionDef?.irreversible === true;
        const isAutoApproved = (agent.auto_approved_actions || []).includes(step.action);

        // CHECK GUARDRAILS: Approval Gate for Irreversible Actions
        if (isIrreversible && !isAutoApproved && step.status !== 'approved_by_user') {
            console.log(`⏸️ [AgentLoop] Task '${taskId}' paused at step ${currentStepIndex + 1} (${step.action}) — needs user approval.`);
            
            const pausePayload = {
                saved_loop_state: {
                    current_step: currentStepIndex,
                    steps,
                    accumulated_context: accumulatedContext
                },
                paused_step: {
                    index: currentStepIndex,
                    action: step.action,
                    description: step.description,
                    params: step.params
                },
                reason: `Action '${step.action}' is irreversible and requires user approval before execution.`
            };

            await updateTaskInSupabase(taskId, {
                status: 'needs_approval',
                result_type: 'irreversible_pending',
                result_payload: pausePayload,
                updated_at: new Date().toISOString()
            });

            // STOP job here cleanly — do not requeue automatically until user approves
            return {
                status: 'needs_approval',
                taskId,
                pausedAtStep: currentStepIndex
            };
        }

        // EXECUTE & OBSERVE
        step.status = 'in_progress';
        try {
            console.log(`⚡ [AgentLoop] Executing step ${currentStepIndex + 1}/${steps.length}: ${step.action}`);
            const actionResult = await executePluginAction(step.action, step.params || {});
            step.status = 'completed';
            step.result = actionResult.data;
            accumulatedContext[step.action] = actionResult.data;

            currentStepIndex++;
        } catch (err) {
            step.status = 'failed';
            step.error = err.message;

            await updateTaskInSupabase(taskId, {
                status: 'failed',
                result_type: 'failure',
                result_payload: {
                    error: err.message,
                    failed_at_step: currentStepIndex + 1,
                    steps
                },
                updated_at: new Date().toISOString()
            });
            throw err;
        }
    }

    // 7. TASK COMPLETE & OPENROUTER SYNTHESIS
    const summaryPrompt = `You are ${agent.name}, specialized as ${agent.role}.${memoryContext}
Task instruction: "${task.instruction}"
Executed step results: ${JSON.stringify(accumulatedContext)}

Provide a concise, professional, structured summary of the task outcome for the user.`;

    let finalSummary = `Completed all ${steps.length} steps for: "${task.instruction}".`;
    try {
        const aiResponse = await callOpenRouterAI({
            messages: [{ role: 'system', content: summaryPrompt }],
            model: 'google/gemini-2.0-flash-001',
            taskId,
            agentId,
            userId
        });
        if (aiResponse.content) {
            finalSummary = aiResponse.content;
        }
    } catch (err) {
        console.warn('[AgentLoop AI Summary Fallback]:', err.message);
    }

    // 8. Update Supabase to 'done' (Realtime pushes to frontend)
    await updateTaskInSupabase(taskId, {
        status: 'done',
        result: finalSummary,
        result_type: 'task_complete',
        result_payload: {
            summary: finalSummary,
            completed_steps: steps,
            accumulated_context: accumulatedContext
        },
        updated_at: new Date().toISOString()
    });

    console.log(`✅ [AgentLoop] Task '${taskId}' completed successfully.`);

    // 9. Post-task memory extraction
    extractFactFromCompletedTask(agent.id, task.instruction, finalSummary, accumulatedContext, userId);

    return {
        status: 'done',
        taskId,
        result: finalSummary
    };
}

/**
 * Helper to update task in Supabase
 */
async function updateTaskInSupabase(taskId, updates) {
    if (!isSupabaseConfigured) return;
    try {
        const { error } = await supabase.from('tasks').update(updates).eq('id', taskId);
        if (error) console.error(`[Supabase Update Error for ${taskId}]:`, error.message);
    } catch (err) {
        console.error(`[Supabase Update Exception]:`, err.message);
    }
}

/**
 * Helper: Plan steps based on instruction and allowed plugins
 */
function planTaskSteps(instruction, allowedPlugins = []) {
    const steps = [];
    const text = (instruction || '').toLowerCase();

    if (text.includes('lead') || text.includes('contact') || text.includes('crm') || text.includes('acme')) {
        if (allowedPlugins.includes('hubspot')) {
            steps.push({
                stepNumber: 1,
                action: 'hubspot:search_contacts',
                description: 'Search CRM contacts directory for decision makers',
                params: { query: 'Acme Corp' },
                status: 'pending'
            });
        }
        if (allowedPlugins.includes('notion')) {
            steps.push({
                stepNumber: steps.length + 1,
                action: 'notion:read_page',
                description: 'Load outbound sales playbook & account context',
                params: { page_title: 'Outreach Playbook' },
                status: 'pending'
            });
        }
        if (allowedPlugins.includes('gmail')) {
            steps.push({
                stepNumber: steps.length + 1,
                action: 'gmail:draft_email',
                description: 'Draft tailored executive outbound email',
                params: { to: 'dana.vance@acme.com', subject: 'Enterprise Platform Discussion' },
                status: 'pending'
            });
        }
    } else if (text.includes('slack') || text.includes('sync') || text.includes('team')) {
        if (allowedPlugins.includes('slack')) {
            steps.push({
                stepNumber: 1,
                action: 'slack:read_channel',
                description: 'Scan updates and announcements in #general',
                params: { channel: '#general' },
                status: 'pending'
            });
        }
        if (allowedPlugins.includes('notion')) {
            steps.push({
                stepNumber: steps.length + 1,
                action: 'notion:create_page',
                description: 'Publish consolidated status notes in Notion workspace',
                params: { title: 'Team Sync Summary' },
                status: 'pending'
            });
        }
    } else {
        const primary = allowedPlugins[0] || 'notion';
        steps.push({
            stepNumber: 1,
            action: `${primary}:read_page`,
            description: `Inspect ${primary} records for task parameters`,
            params: { instruction },
            status: 'pending'
        });
    }

    return steps;
}

/**
 * Extract facts after completed task and save to Supabase agent_memory
 */
async function extractFactFromCompletedTask(agentId, taskInstruction, taskResult, contextData, userId = 'default_user') {
    if (!isSupabaseConfigured || !agentId) return;

    try {
        const prompt = `Identify if there is any critical, specific user preference, company policy, or factual rule worth remembering long-term from this task.
Task: "${taskInstruction}"
Result: "${taskResult}"
Data: ${JSON.stringify(contextData)}

If there is a noteworthy fact, return ONLY a JSON object: {"key": "<short_snake_case_key>", "value": "<concise_fact>"}.
If nothing noteworthy to remember, return {"key": null, "value": null}.`;

        const res = await callOpenRouterAI({
            messages: [{ role: 'user', content: prompt }],
            model: 'google/gemini-2.0-flash-001',
            temperature: 0.1,
            max_tokens: 200,
            agentId,
            userId
        });

        const text = res.content.trim().replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(text);

        if (parsed && parsed.key && parsed.value) {
            await supabase.from('agent_memory').insert({
                agent_id: agentId,
                key: parsed.key,
                value: parsed.value
            });
            console.log(`🧠 [Worker Memory Saved for ${agentId}] ${parsed.key}: ${parsed.value}`);
        }
    } catch (err) {
        console.warn('[Worker Memory Extraction Warning]:', err.message);
    }
}
