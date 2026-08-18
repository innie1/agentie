// ============================================================================
// AGENTIE WORKER — OPENROUTER AI BRAIN CALLER & TOKEN LOGGER
// ============================================================================

import { supabase, isSupabaseConfigured } from '../config/supabase.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Call OpenRouter with system context and task prompts
 */
export async function callOpenRouterAI({
    messages,
    model = 'google/gemini-2.0-flash-001',
    temperature = 0.7,
    max_tokens = 1500,
    taskId = null,
    agentId = null,
    userId = 'default_user'
}) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is not defined in worker environment.');
    }

    const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://agentie.ai',
            'X-Title': 'Agentie Railway Worker'
        },
        body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const replyContent = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {
        prompt_tokens: Math.ceil(messages.map(m => m.content).join(' ').length / 4),
        completion_tokens: Math.ceil(replyContent.length / 4),
        total_tokens: 0
    };

    // Log to Supabase token_usage table asynchronously
    if (isSupabaseConfigured) {
        supabase.from('token_usage').insert({
            user_id: userId,
            agent_id: agentId,
            task_id: taskId,
            model_id: model,
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
            cost_usd: data.usage?.cost || 0
        }).then(({ error }) => {
            if (error) console.warn('[Worker Token Usage Log Error]:', error.message);
        });
    }

    return {
        content: replyContent,
        model,
        usage,
        raw: data
    };
}
