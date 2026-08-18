// ============================================================================
// AGENTIE REST API ROUTES
// Endpoints for Plugins, Agents, Tasks, Routines, Memory, Handoffs, Logs, OpenRouter AI, Token Counters
// ============================================================================

import { Router } from 'express';
import { db } from '../db.js';
import { 
    getPluginsCatalog, 
    getUserPlugins, 
    startOAuthFlow,
    completeOAuthCallback,
    connectApiKeyPlugin,
    removePluginForUser, 
    markPluginExpired,
    isPluginConnected
} from '../services/pluginService.js';
import { 
    startRecordingSession, 
    captureSessionStep, 
    saveRecordingSession, 
    parsePlainScheduleToCron,
    matchRoutineTrigger 
} from '../services/routineService.js';
import { generateSystemPrompt } from '../services/promptGenerator.js';
import { getAgentMemories, saveMemory, deleteMemory } from '../services/memoryService.js';
import { createAgentHandoff, getAgentHandoffs } from '../services/handoffService.js';
import { executeTaskLoop, approveAndResumeTask, rejectTask } from '../services/agentRuntime.js';
import { taskQueue } from '../services/taskQueue.js';
import { generateUniqueAgentName, validateUserAgentName, isNameAvailable } from '../services/namingService.js';
import { cronScheduler } from '../services/cronScheduler.js';
import { 
    callOpenRouter, 
    classifyIntent, 
    refreshModelsCatalog, 
    extractMidTaskCorrection, 
    extractFactFromCompletedTask 
} from '../services/openRouterService.js';

export const apiRouter = Router();

// ============================================================================
// 1. PLUGINS & OAUTH / API KEY AUTHENTICATION (SPEC 1)
// ============================================================================
apiRouter.get('/plugins', (req, res) => {
    res.json({ success: true, plugins: getPluginsCatalog() });
});

apiRouter.get('/user-plugins', (req, res) => {
    res.json({ success: true, user_plugins: getUserPlugins('default_user') });
});

// Step 1: Start OAuth authorization flow
apiRouter.post('/plugins/:id/oauth/start', (req, res) => {
    try {
        const { redirect_uri } = req.body;
        const result = startOAuthFlow('default_user', req.params.id, redirect_uri);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Step 2: OAuth provider callback handler (GET or POST)
apiRouter.get('/plugins/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        const result = await completeOAuthCallback({ code, state });
        res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?plugin_connected=${result.plugin.id}`);
    } catch (err) {
        res.status(400).send(`<h3>Authentication Error</h3><p>${err.message}</p>`);
    }
});

apiRouter.post('/plugins/callback', async (req, res) => {
    try {
        const { code, state, redirect_uri } = req.body;
        const result = await completeOAuthCallback({ code, state, redirectUri: redirect_uri });
        res.json({ success: true, user_plugin: result.userPlugin, plugin: result.plugin });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Connect plugin with API Key (verifies before saving)
apiRouter.post('/plugins/:id/connect-key', async (req, res) => {
    try {
        const { api_key } = req.body;
        const result = await connectApiKeyPlugin('default_user', req.params.id, api_key);
        res.status(201).json({ success: true, user_plugin: result.userPlugin, message: 'Connected' });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Disconnect / Remove plugin
apiRouter.delete('/user-plugins/:pluginId', (req, res) => {
    const deleted = removePluginForUser('default_user', req.params.pluginId);
    if (!deleted) return res.status(404).json({ success: false, error: 'Plugin not in user list' });
    res.json({ success: true, removed: deleted });
});

// ============================================================================
// 2. OPENROUTER AI BRAIN & CHAT ENDPOINT (SPEC 2 & 4)
// ============================================================================
apiRouter.post('/chat', async (req, res) => {
    const { agent_id, message, history = [], user_id = 'default_user' } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({ success: false, error: 'Message cannot be empty.' });
    }

    let agent = null;
    if (agent_id) {
        agent = db.agents.find(a => a.id === agent_id);
    }

    try {
        // 1. Check for real-time user correction
        const correction = extractMidTaskCorrection(message);
        if (correction && agent) {
            saveMemory(agent.id, 'user_correction', correction);
            console.log(`💡 [Immediate Correction Saved for ${agent.name}] "${correction}"`);
        }

        // 2. Classify intent before making expensive reasoning calls
        const intent = classifyIntent(message);
        const selectedTier = intent.tier; // 'fast' or 'reasoning'

        // 3. Assemble Memory & Context
        const memories = agent ? getAgentMemories(agent.id) : [];
        const memoryContext = memories.length > 0
            ? `\n\nLONG-TERM MEMORY & KNOWN PREFERENCES:\n${memories.map(m => `- ${m.key}: ${m.value}`).join('\n')}`
            : '';

        const agentRole = agent ? agent.role : 'helpful AI teammate';
        const agentName = agent ? agent.name : 'Agentie';
        const systemPrompt = (agent && agent.system_prompt)
            ? agent.system_prompt + memoryContext
            : `You are ${agentName}, specialized as ${agentRole}. Be direct, professional, proactive, and concise.${memoryContext}`;

        // 4. Construct messages payload
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.slice(-10).map(h => ({
                role: h.sender === 'user' ? 'user' : 'assistant',
                content: h.text || ''
            })),
            { role: 'user', content: message }
        ];

        // 5. Execute OpenRouter Call
        const openRouterResponse = await callOpenRouter({
            messages,
            tier: selectedTier,
            agentId: agent ? agent.id : null,
            userId: user_id,
            temperature: selectedTier === 'fast' ? 0.5 : 0.7
        });

        const replyText = openRouterResponse.content;

        // 6. Post-task memory extraction if reasoning tier completed
        if (selectedTier === 'reasoning' && agent) {
            extractFactFromCompletedTask(agent.id, message, replyText, history, user_id);
        }

        res.json({
            success: true,
            reply: replyText,
            tier: selectedTier,
            model: openRouterResponse.model,
            usage: openRouterResponse.usage
        });
    } catch (err) {
        console.error('Chat error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 3. MODELS CONFIG & CATALOG FRESHNESS (SPEC 2, POINTS 3-4)
// ============================================================================
apiRouter.get('/models', (req, res) => {
    res.json({ success: true, models: db.models_config });
});

apiRouter.post('/models/refresh', async (req, res) => {
    try {
        const models = await refreshModelsCatalog();
        res.json({ success: true, models });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

apiRouter.post('/models/pin', (req, res) => {
    const { tier, model_id, is_pinned = true } = req.body;
    const config = db.models_config.find(m => m.id === tier);
    if (!config) return res.status(404).json({ success: false, error: `Tier '${tier}' not found.` });

    if (model_id) config.model_id = model_id;
    config.is_pinned = !!is_pinned;
    config.updated_at = new Date().toISOString();

    res.json({ success: true, config });
});

// ============================================================================
// 4. TOKEN USAGE & METRICS (SPEC 3)
// ============================================================================
apiRouter.get('/tokens/usage', (req, res) => {
    const { agent_id, user_id = 'default_user' } = req.query;
    let list = db.token_usage.filter(t => t.user_id === user_id);
    if (agent_id) list = list.filter(t => t.agent_id === agent_id);

    const totalPromptTokens = list.reduce((sum, item) => sum + (item.prompt_tokens || 0), 0);
    const totalCompletionTokens = list.reduce((sum, item) => sum + (item.completion_tokens || 0), 0);
    const totalTokens = totalPromptTokens + totalCompletionTokens;
    const totalCostUsd = list.reduce((sum, item) => sum + (item.cost_usd || 0), 0);

    // Rollup by day
    const byDay = {};
    list.forEach(item => {
        const day = item.created_at.split('T')[0];
        if (!byDay[day]) byDay[day] = { date: day, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, calls: 0 };
        byDay[day].prompt_tokens += item.prompt_tokens;
        byDay[day].completion_tokens += item.completion_tokens;
        byDay[day].total_tokens += item.total_tokens;
        byDay[day].cost_usd += item.cost_usd;
        byDay[day].calls++;
    });

    res.json({
        success: true,
        summary: {
            total_calls: list.length,
            total_prompt_tokens: totalPromptTokens,
            total_completion_tokens: totalCompletionTokens,
            total_tokens: totalTokens,
            total_cost_usd: Number(totalCostUsd.toFixed(6))
        },
        daily_rollups: Object.values(byDay),
        raw_logs: list.slice(0, 100)
    });
});

apiRouter.get('/agents/:id/tokens', (req, res) => {
    const list = db.token_usage.filter(t => t.agent_id === req.params.id);
    const totalTokens = list.reduce((sum, item) => sum + (item.total_tokens || 0), 0);
    const totalPrompt = list.reduce((sum, item) => sum + (item.prompt_tokens || 0), 0);
    const totalCompletion = list.reduce((sum, item) => sum + (item.completion_tokens || 0), 0);

    res.json({
        success: true,
        agent_id: req.params.id,
        total_tokens: totalTokens,
        prompt_tokens: totalPrompt,
        completion_tokens: totalCompletion,
        calls_count: list.length
    });
});

// ============================================================================
// 5. ROUTINES & TEACH MODE
// ============================================================================
apiRouter.get('/routines', (req, res) => {
    const { agent_id } = req.query;
    let list = db.routines;
    if (agent_id) list = list.filter(r => r.agent_id === agent_id);
    res.json({ success: true, routines: list });
});

apiRouter.get('/routines/:id', (req, res) => {
    const routine = db.routines.find(r => r.id === req.params.id);
    if (!routine) return res.status(404).json({ success: false, error: 'Routine not found' });
    res.json({ success: true, routine });
});

apiRouter.post('/routines/parse-schedule', (req, res) => {
    const { schedule_input } = req.body;
    const parsed = parsePlainScheduleToCron(schedule_input);
    res.json({ success: true, ...parsed });
});

apiRouter.post('/routines/record/start', (req, res) => {
    const { agent_id } = req.body;
    if (!agent_id) return res.status(400).json({ success: false, error: 'agent_id is required' });
    const session = startRecordingSession(agent_id);
    res.status(201).json({ success: true, session });
});

apiRouter.post('/routines/record/step', (req, res) => {
    const { session_id, plugin_id, action, params, screenshot } = req.body;
    try {
        const step = captureSessionStep(session_id, { plugin_id, action, params, screenshot });
        res.status(201).json({ success: true, step });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

apiRouter.post('/routines/record/save', (req, res) => {
    const { session_id, name, trigger_patterns, schedule_input } = req.body;
    try {
        const routine = saveRecordingSession(session_id, { name, trigger_patterns, schedule_input });
        res.status(201).json({ success: true, routine });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

apiRouter.post('/routines', (req, res) => {
    const { agent_id, name, steps, trigger_pattern, schedule, schedule_human, dynamic_fields } = req.body;
    if (!agent_id || !name) return res.status(400).json({ success: false, error: 'agent_id and name are required' });

    const newRoutine = {
        id: 'rout_' + Date.now(),
        agent_id,
        name,
        steps: steps || [],
        trigger_pattern: trigger_pattern || [`Run ${name.toLowerCase()}`],
        schedule: schedule || null,
        schedule_human: schedule_human || null,
        dynamic_fields: dynamic_fields || {},
        success_count: 0,
        last_run_at: null,
        last_run_status: null,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    db.routines.unshift(newRoutine);
    res.status(201).json({ success: true, routine: newRoutine });
});

apiRouter.put('/routines/:id', (req, res) => {
    const routine = db.routines.find(r => r.id === req.params.id);
    if (!routine) return res.status(404).json({ success: false, error: 'Routine not found' });

    const { name, steps, trigger_pattern, schedule, schedule_human, status } = req.body;
    if (name) routine.name = name;
    if (steps) routine.steps = steps;
    if (trigger_pattern) routine.trigger_pattern = trigger_pattern;
    if (schedule !== undefined) routine.schedule = schedule;
    if (schedule_human !== undefined) routine.schedule_human = schedule_human;
    if (status) routine.status = status;
    routine.updated_at = new Date().toISOString();

    res.json({ success: true, routine });
});

apiRouter.delete('/routines/:id', (req, res) => {
    const index = db.routines.findIndex(r => r.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, error: 'Routine not found' });

    const deleted = db.routines.splice(index, 1)[0];
    res.json({ success: true, routine: deleted });
});

apiRouter.post('/routines/:id/run', async (req, res) => {
    const routine = db.routines.find(r => r.id === req.params.id);
    if (!routine) return res.status(404).json({ success: false, error: 'Routine not found' });

    const newTask = {
        id: 'task_rout_' + Date.now(),
        user_id: 'default_user',
        agent_id: routine.agent_id,
        instruction: routine.name,
        context: { routine_id: routine.id, manual_trigger: true },
        source: 'routine',
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

    res.status(201).json({ success: true, task: newTask, queued: true });
});

// ============================================================================
// 6. AGENTS CRUD
// ============================================================================
apiRouter.get('/agents', (req, res) => {
    res.json({ success: true, agents: db.agents });
});

apiRouter.get('/agents/:id', (req, res) => {
    const agent = db.agents.find(a => a.id === req.params.id);
    if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
    res.json({ success: true, agent });
});

apiRouter.post('/agents/generate-name', (req, res) => {
    const { role, goal, allowed_plugins } = req.body;
    const generated = generateUniqueAgentName({
        userId: 'default_user',
        role: role || '',
        goal: goal || '',
        allowed_plugins: allowed_plugins || []
    });
    res.json({ success: true, ...generated });
});

apiRouter.post('/agents/check-name', (req, res) => {
    const { name, exclude_agent_id } = req.body;
    const result = validateUserAgentName({
        userId: 'default_user',
        name,
        excludeAgentId: exclude_agent_id
    });
    res.json({ success: true, ...result });
});

apiRouter.post('/agents/preview-prompt', (req, res) => {
    const { name, role, goal, allowed_plugins } = req.body;
    const prompt = generateSystemPrompt(name || 'Agent', role || 'Assistant', goal || 'Execute tasks', allowed_plugins || []);
    res.json({ success: true, system_prompt: prompt });
});

apiRouter.post('/agents', (req, res) => {
    const { name, role, goal, system_prompt, allowed_plugins, auto_approved_actions, status } = req.body;
    
    if (!role || !goal) {
        return res.status(400).json({ success: false, error: 'Role and goal are required.' });
    }

    let finalName = name;
    let nameSource = 'user';

    if (!finalName || !finalName.trim()) {
        const autoGen = generateUniqueAgentName({
            userId: 'default_user',
            role,
            goal,
            allowed_plugins: allowed_plugins || []
        });
        finalName = autoGen.name;
        nameSource = 'auto';
    } else {
        const validation = validateUserAgentName({
            userId: 'default_user',
            name: finalName
        });
        if (!validation.valid) {
            return res.status(409).json({ success: false, error_code: 'name_conflict', error: validation.error });
        }
        finalName = validation.name;
    }

    const finalPrompt = system_prompt || generateSystemPrompt(finalName, role, goal, allowed_plugins || []);

    const newAgent = {
        id: 'agent_' + Date.now(),
        user_id: 'default_user',
        name: finalName,
        name_source: nameSource,
        role,
        goal,
        system_prompt: finalPrompt,
        allowed_plugins: allowed_plugins || [],
        auto_approved_actions: auto_approved_actions || [],
        status: status || 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    db.agents.unshift(newAgent);
    res.status(201).json({ success: true, agent: newAgent });
});

apiRouter.put('/agents/:id', (req, res) => {
    const agent = db.agents.find(a => a.id === req.params.id);
    if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });

    const { name, role, goal, system_prompt, allowed_plugins, auto_approved_actions, status } = req.body;
    
    if (name && name.trim() !== agent.name) {
        const validation = validateUserAgentName({
            userId: agent.user_id,
            name,
            excludeAgentId: agent.id
        });
        if (!validation.valid) {
            return res.status(409).json({ success: false, error_code: 'name_conflict', error: validation.error });
        }
        agent.name = validation.name;
        agent.name_source = 'user';
    }

    if (role) agent.role = role;
    if (goal) agent.goal = goal;
    if (system_prompt) agent.system_prompt = system_prompt;
    if (allowed_plugins) agent.allowed_plugins = allowed_plugins;
    if (auto_approved_actions) agent.auto_approved_actions = auto_approved_actions;
    if (status) agent.status = status;
    agent.updated_at = new Date().toISOString();

    res.json({ success: true, agent });
});

apiRouter.delete('/agents/:id', (req, res) => {
    const index = db.agents.findIndex(a => a.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, error: 'Agent not found' });

    const deleted = db.agents.splice(index, 1)[0];
    db.tasks = db.tasks.filter(t => t.agent_id !== req.params.id);
    db.agent_memory = db.agent_memory.filter(m => m.agent_id !== req.params.id);
    db.routines = db.routines.filter(r => r.agent_id !== req.params.id);

    res.json({ success: true, agent: deleted });
});

// ============================================================================
// 7. TASKS & BEHAVIOR LOOP
// ============================================================================
apiRouter.get('/tasks', (req, res) => {
    const { agent_id } = req.query;
    let list = db.tasks;
    if (agent_id) list = list.filter(t => t.agent_id === agent_id);
    res.json({ success: true, tasks: list });
});

apiRouter.get('/tasks/:id', (req, res) => {
    const task = db.tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
    res.json({ success: true, task });
});

apiRouter.post('/tasks', async (req, res) => {
    const { agent_id, instruction, context, sync = false } = req.body;

    if (!agent_id || !instruction) {
        return res.status(400).json({ success: false, error: 'agent_id and instruction are required.' });
    }

    const agent = db.agents.find(a => a.id === agent_id);
    if (!agent) return res.status(404).json({ success: false, error: 'Agent not found.' });

    const newTask = {
        id: 'task_' + Date.now(),
        user_id: agent.user_id,
        agent_id,
        instruction,
        context: context || {},
        source: 'manual',
        routine_id: null,
        status: 'pending',
        current_step: 0,
        steps: [],
        paused_step_data: null,
        result: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    db.tasks.unshift(newTask);

    if (sync) {
        const result = await executeTaskLoop(newTask.id);
        return res.status(201).json({ success: true, task: result });
    }

    taskQueue.enqueue(newTask.id);
    res.status(201).json({ success: true, task: newTask, queued: true });
});

apiRouter.post('/tasks/:id/approve', async (req, res) => {
    try {
        const resumedTask = await approveAndResumeTask(req.params.id);
        res.json({ success: true, task: resumedTask });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

apiRouter.post('/tasks/:id/reject', (req, res) => {
    try {
        const rejected = rejectTask(req.params.id, req.body.reason);
        res.json({ success: true, task: rejected });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 8. AGENT MEMORY
// ============================================================================
apiRouter.get('/agents/:id/memories', (req, res) => {
    const memories = getAgentMemories(req.params.id);
    res.json({ success: true, memories });
});

apiRouter.post('/agents/:id/memories', (req, res) => {
    const { key, value } = req.body;
    if (!key || !value) return res.status(400).json({ success: false, error: 'Key and value are required.' });

    const memory = saveMemory(req.params.id, key, value);
    res.status(201).json({ success: true, memory });
});

apiRouter.delete('/memories/:id', (req, res) => {
    const deleted = deleteMemory(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Memory not found.' });
    res.json({ success: true, memory: deleted });
});

// ============================================================================
// 9. AGENT-TO-AGENT HANDOFFS
// ============================================================================
apiRouter.get('/handoffs', (req, res) => {
    const { agent_id } = req.query;
    if (agent_id) {
        return res.json({ success: true, handoffs: getAgentHandoffs(agent_id) });
    }
    res.json({ success: true, handoffs: db.task_handoffs });
});

apiRouter.post('/handoffs', (req, res) => {
    const { from_agent_id, to_agent_id, note, context_summary, instruction } = req.body;

    if (!from_agent_id || !to_agent_id || !note) {
        return res.status(400).json({ success: false, error: 'from_agent_id, to_agent_id, and note are required.' });
    }

    try {
        const result = createAgentHandoff({
            fromAgentId: from_agent_id,
            toAgentId: to_agent_id,
            note,
            contextSummary: context_summary || note,
            instruction
        });

        taskQueue.enqueue(result.task.id);
        res.status(201).json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================================================
// 10. ACTION AUDIT LOG & TOKEN USAGE
// ============================================================================
apiRouter.get('/action-logs', (req, res) => {
    const { agent_id, task_id } = req.query;
    let logs = db.action_log;
    if (agent_id) logs = logs.filter(l => l.agent_id === agent_id);
    if (task_id) logs = logs.filter(l => l.task_id === task_id);
    res.json({ success: true, logs });
});

apiRouter.get('/tokens/usage', (req, res) => {
    const { agent_id, user_id } = req.query;
    let logs = db.token_usage || [];
    if (agent_id) logs = logs.filter(l => l.agent_id === agent_id);
    if (user_id) logs = logs.filter(l => l.user_id === user_id);

    const total_prompt_tokens = logs.reduce((sum, l) => sum + (l.prompt_tokens || 0), 0);
    const total_completion_tokens = logs.reduce((sum, l) => sum + (l.completion_tokens || 0), 0);
    const total_tokens = logs.reduce((sum, l) => sum + (l.total_tokens || ((l.prompt_tokens || 0) + (l.completion_tokens || 0))), 0);
    const total_cost_usd = logs.reduce((sum, l) => sum + (l.cost_usd || 0), 0);

    const by_model = {};
    logs.forEach(l => {
        const m = l.model_id || 'google/gemini-2.0-flash-001';
        if (!by_model[m]) by_model[m] = { count: 0, tokens: 0 };
        by_model[m].count += 1;
        by_model[m].tokens += (l.total_tokens || 0);
    });

    res.json({
        success: true,
        total_tokens: total_tokens,
        total_prompt_tokens: total_prompt_tokens,
        total_completion_tokens: total_completion_tokens,
        total_cost_usd: Number(total_cost_usd.toFixed(4)),
        total_calls: logs.length,
        by_model,
        recent_logs: logs.slice(0, 20)
    });
});
