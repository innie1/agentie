// ============================================================================
// AGENTIE AI BRAIN — OPENROUTER INTEGRATION & TIERED ROUTING ENGINE (SPEC 2 & 3)
// ============================================================================

import { db } from '../db.js';
import { getAgentMemories, saveMemory } from './memoryService.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

/**
 * Fetch live model catalog from OpenRouter and update model freshness
 */
export async function refreshModelsCatalog() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.warn('⚠️ [OpenRouter] OPENROUTER_API_KEY is not set. Skipping live model catalog refresh.');
        return db.models_config;
    }

    try {
        const res = await fetch(`${OPENROUTER_API_URL}/models`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!res.ok) {
            console.error(`[OpenRouter] Failed to fetch models catalog: ${res.status} ${res.statusText}`);
            return db.models_config;
        }

        const data = await res.json();
        const models = data.data || [];

        // Find candidate fast models (prioritizing high speed, low latency, recent)
        const fastCandidates = models.filter(m => 
            (m.id.includes('flash') || m.id.includes('mini') || m.id.includes('3b') || m.id.includes('haiku')) &&
            !m.id.includes('preview')
        );

        // Find candidate reasoning models (strong reasoning, high capability)
        const reasoningCandidates = models.filter(m => 
            (m.id.includes('claude-3-5-sonnet') || m.id.includes('gpt-4o') || m.id.includes('gemini-2.0-flash') || m.id.includes('deepseek-chat')) &&
            !m.id.includes('free')
        );

        // Update fast tier if not pinned
        const fastConfig = db.models_config.find(m => m.id === 'fast');
        if (fastConfig && !fastConfig.is_pinned && fastCandidates.length > 0) {
            const bestFast = fastCandidates[0];
            fastConfig.model_id = bestFast.id;
            fastConfig.provider = bestFast.name || 'Auto';
            fastConfig.context_length = bestFast.context_length || 128000;
            fastConfig.updated_at = new Date().toISOString();
        }

        // Update reasoning tier if not pinned
        const reasoningConfig = db.models_config.find(m => m.id === 'reasoning');
        if (reasoningConfig && !reasoningConfig.is_pinned && reasoningCandidates.length > 0) {
            const bestReasoning = reasoningCandidates[0];
            reasoningConfig.model_id = bestReasoning.id;
            reasoningConfig.provider = bestReasoning.name || 'Auto';
            reasoningConfig.context_length = bestReasoning.context_length || 200000;
            reasoningConfig.updated_at = new Date().toISOString();
        }

        console.log(`✅ [OpenRouter] Model catalog refreshed. Fast: ${fastConfig?.model_id}, Reasoning: ${reasoningConfig?.model_id}`);
        return db.models_config;
    } catch (err) {
        console.error('[OpenRouter] Model catalog error:', err.message);
        return db.models_config;
    }
}

/**
 * Log token usage for OpenRouter call
 */
export function logTokenUsage({ userId = 'default_user', agentId = null, taskId = null, modelId, usage = {}, pricing = null }) {
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || (promptTokens + completionTokens);

    // Approximate cost in USD if pricing metadata is provided or estimate based on typical rates
    let costUsd = 0;
    if (pricing && pricing.prompt && pricing.completion) {
        costUsd = (promptTokens * Number(pricing.prompt)) + (completionTokens * Number(pricing.completion));
    }

    const entry = {
        id: 'tok_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        user_id: userId,
        agent_id: agentId,
        task_id: taskId,
        model_id: modelId,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        cost_usd: Number(costUsd.toFixed(6)),
        created_at: new Date().toISOString()
    };

    db.token_usage.unshift(entry);
    return entry;
}

/**
 * Base OpenRouter API call
 */
export async function callOpenRouter({
    messages,
    tier = 'fast',
    modelOverride = null,
    temperature = 0.7,
    max_tokens = 1500,
    agentId = null,
    userId = 'default_user',
    taskId = null
}) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is not configured in backend .env.');
    }

    let targetModel = modelOverride;
    if (!targetModel) {
        const config = db.models_config.find(m => m.id === tier) || db.models_config[0];
        targetModel = config ? config.model_id : 'google/gemini-2.0-flash-001';
    }

    const payload = {
        model: targetModel,
        messages,
        temperature,
        max_tokens
    };

    const res = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://agentie.ai',
            'X-Title': 'Agentie AI Teammates'
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenRouter API call failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const choice = data.choices && data.choices[0];
    const replyContent = choice ? choice.message.content : '';

    // Log raw usage row into token_usage table
    const usage = data.usage || {
        prompt_tokens: Math.ceil(messages.map(m => m.content).join(' ').length / 4),
        completion_tokens: Math.ceil(replyContent.length / 4),
        total_tokens: 0
    };

    logTokenUsage({
        userId,
        agentId,
        taskId,
        modelId: targetModel,
        usage
    });

    return {
        content: replyContent,
        model: targetModel,
        usage: data.usage || usage,
        raw: data
    };
}

/**
 * Message intent classifier
 * Classify if message is simple acknowledgement/small-talk vs full task/reasoning request
 */
export function classifyIntent(text = '') {
    const clean = text.trim().toLowerCase();

    // Small talk / greetings / confirmations / acknowledgments
    const greetings = ['hi', 'hello', 'hey', 'good morning', 'good evening', 'howdy', 'sup', 'yo'];
    const acks = ['ok', 'okay', 'thanks', 'thank you', 'cool', 'sounds good', 'great', 'awesome', 'got it', 'understood', 'yes', 'no', 'sure'];
    const simpleQueries = ['who are you', 'what is your name', 'help', 'what can you do'];

    if (clean.length < 35) {
        if (greetings.some(g => clean === g || clean.startsWith(g + ' ') || clean.endsWith(' ' + g))) {
            return { tier: 'fast', isSmallTalk: true };
        }
        if (acks.some(a => clean === a || clean.startsWith(a + ' '))) {
            return { tier: 'fast', isSmallTalk: true };
        }
        if (simpleQueries.some(q => clean === q || clean.includes(q))) {
            return { tier: 'fast', isSmallTalk: true };
        }
    }

    return { tier: 'reasoning', isSmallTalk: false };
}

/**
 * Detect mid-conversation user correction ("no, always use X", "actually, use Y")
 */
export function extractMidTaskCorrection(text = '') {
    const lower = text.toLowerCase();
    const correctionKeywords = ['no, always', 'no always', 'actually, use', 'remember to', 'from now on', 'make sure to always', 'don\'t forget that'];
    
    for (const kw of correctionKeywords) {
        if (lower.includes(kw)) {
            return text.trim();
        }
    }
    return null;
}

/**
 * Run post-task memory extraction
 * Lightweight LLM call asking: "What fact worth remembering came out of this?"
 */
export async function extractFactFromCompletedTask(agentId, taskInstruction, taskResult, conversationSnippets = [], userId = 'default_user') {
    try {
        const prompt = `You are a memory extraction component for an AI teammate.
Task instruction: "${taskInstruction}"
Result: "${taskResult}"
Recent conversation: ${JSON.stringify(conversationSnippets.slice(-4))}

Identify if there is any critical, specific user preference, company policy, or factual rule worth remembering long-term (e.g. "Acme Corp requires Dana approval", "Always use Vercel staging URL").
If there is a noteworthy fact, return a JSON object with {"key": "<short_snake_case_key>", "value": "<concise_fact>"}.
If there is NO persistent fact to remember (just routine task execution), return {"key": null, "value": null}.
Return ONLY valid JSON.`;

        const response = await callOpenRouter({
            messages: [{ role: 'user', content: prompt }],
            tier: 'fast',
            temperature: 0.1,
            max_tokens: 200,
            agentId,
            userId
        });

        const text = response.content.trim().replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(text);

        if (parsed && parsed.key && parsed.value) {
            saveMemory(agentId, parsed.key, parsed.value);
            console.log(`🧠 [Memory Extracted for ${agentId}] ${parsed.key}: ${parsed.value}`);
            return parsed;
        }
    } catch (err) {
        // Non-blocking extraction
        console.warn('[Memory Extraction] Skipped or failed:', err.message);
    }
    return null;
}
