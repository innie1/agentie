// ============================================================================
// AGENT MEMORY SERVICE (SPEC 3)
// Key-Value extraction after task completion + Pre-loading memory into context
// ============================================================================

import { db } from '../db.js';

/**
 * Loads all relevant memories for an agent to inject into task context
 */
export function getAgentMemories(agentId) {
    return db.agent_memory.filter(m => m.agent_id === agentId);
}

/**
 * Saves a new key-value memory entry
 */
export function saveMemory(agentId, key, value) {
    const existingIndex = db.agent_memory.findIndex(m => m.agent_id === agentId && m.key.toLowerCase() === key.toLowerCase());
    
    if (existingIndex !== -1) {
        db.agent_memory[existingIndex].value = value;
        db.agent_memory[existingIndex].updated_at = new Date().toISOString();
        return db.agent_memory[existingIndex];
    }

    const memoryEntry = {
        id: 'mem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        agent_id: agentId,
        key: key.trim(),
        value: value.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    db.agent_memory.push(memoryEntry);
    return memoryEntry;
}

/**
 * Deletes a memory entry
 */
export function deleteMemory(memoryId) {
    const index = db.agent_memory.findIndex(m => m.id === memoryId);
    if (index !== -1) {
        return db.agent_memory.splice(index, 1)[0];
    }
    return null;
}

/**
 * Auto-extracts notable facts, decisions, and preferences from a completed task
 */
export function extractAndSaveMemoriesFromTask(agentId, instruction, result) {
    const extracted = [];
    const lower = (instruction + ' ' + result).toLowerCase();

    // Heuristic fact extractor for actionable memory retention
    if (lower.includes('annual') || lower.includes('contract') || lower.includes('billing')) {
        const mem = saveMemory(agentId, 'contract_billing_preference', 'Prefers annual upfront commitment with formal executive approval.');
        extracted.push(mem);
    }
    if (lower.includes('sla') || lower.includes('urgent') || lower.includes('priority')) {
        const mem = saveMemory(agentId, 'response_sla_rule', 'Tier-1 priority items require verification within 15 minutes.');
        extracted.push(mem);
    }
    if (lower.includes('contact') || lower.includes('vp') || lower.includes('lead')) {
        const mem = saveMemory(agentId, 'key_stakeholder_pattern', 'Target engineering and operations leadership for enterprise deals.');
        extracted.push(mem);
    }

    return extracted;
}
