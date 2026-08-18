// ============================================================================
// AGENTIE AUTO-NAMING ENGINE
// Thematic Persona Classification, Uniqueness Enforcement & Collision Resolution
// ============================================================================

import { db } from '../db.js';

export const THEMATIC_NAMES = {
    business: ['Atlas', 'Sterling', 'Vanguard', 'Sentinel', 'Beacon', 'Orion', 'Apex', 'Titan', 'Helix', 'Nexus'],
    personal: ['Nova', 'Haven', 'Aura', 'Zephyr', 'Sol', 'Willow', 'Astra', 'Luna', 'Kora', 'Iris'],
    finance: ['Ledger', 'Vault', 'Prosper', 'Mint', 'Fiscal', 'Quant', 'Asset', 'Centurion', 'Yield'],
    creative: ['Muse', 'Lyra', 'Canvas', 'Chroma', 'Pixel', 'Palette', 'Vivid', 'Artisan', 'Prism'],
    sales: ['Apollo', 'Hunter', 'Scout', 'Archer', 'Vector', 'Pioneer', 'Catalyst', 'Strike', 'Ranger'],
    support: ['Solace', 'Harmony', 'Clarity', 'Haven', 'Echo', 'Empathy', 'Serena', 'Anchor'],
    tech: ['Cipher', 'Kernel', 'Kodiak', 'Byte', 'Matrix', 'Forge', 'Daemon', 'Node', 'Syntax']
};

/**
 * Classify domain/field based on role, goal, and plugin assignments
 */
export function classifyField(role = '', goal = '', plugins = []) {
    const text = `${role} ${goal}`.toLowerCase();
    const pluginStr = (plugins || []).join(' ').toLowerCase();

    if (text.includes('finance') || text.includes('money') || text.includes('crypto') || text.includes('invest') || text.includes('budget') || pluginStr.includes('stripe')) {
        return 'finance';
    }
    if (text.includes('creative') || text.includes('design') || text.includes('art') || text.includes('music') || text.includes('video') || text.includes('canva') || pluginStr.includes('canva') || pluginStr.includes('figma')) {
        return 'creative';
    }
    if (text.includes('sales') || text.includes('outbound') || text.includes('lead') || text.includes('prospect') || text.includes('pipeline') || pluginStr.includes('hubspot')) {
        return 'sales';
    }
    if (text.includes('support') || text.includes('helpdesk') || text.includes('customer') || text.includes('ticket') || text.includes('client')) {
        return 'support';
    }
    if (text.includes('dev') || text.includes('code') || text.includes('git') || text.includes('software') || text.includes('database') || text.includes('sql') || pluginStr.includes('github') || pluginStr.includes('postgres')) {
        return 'tech';
    }
    if (text.includes('personal') || text.includes('life') || text.includes('habit') || text.includes('wellness') || text.includes('fitness') || text.includes('family')) {
        return 'personal';
    }

    // Default to business/executive
    return 'business';
}

/**
 * Check if a proposed agent name is available for this user (case-insensitive)
 */
export function isNameAvailable(userId = 'default_user', proposedName, excludeAgentId = null) {
    if (!proposedName || typeof proposedName !== 'string') return false;
    const cleanProposed = proposedName.trim().toLowerCase();

    return !db.agents.some(a => 
        a.user_id === userId && 
        a.id !== excludeAgentId && 
        a.name.trim().toLowerCase() === cleanProposed
    );
}

/**
 * Auto-generate a thematic persona name with collision retry and variant fallback
 */
export function generateUniqueAgentName({ userId = 'default_user', role = '', goal = '', allowed_plugins = [] }) {
    const domain = classifyField(role, goal, allowed_plugins);
    const candidates = THEMATIC_NAMES[domain] || THEMATIC_NAMES.business;

    // Retry loop: Pick randomized candidate from the field
    const shuffled = [...candidates].sort(() => 0.5 - Math.random());

    for (let attempt = 0; attempt < Math.min(shuffled.length, 5); attempt++) {
        const candidate = shuffled[attempt];
        if (isNameAvailable(userId, candidate)) {
            return {
                name: candidate,
                domain,
                name_source: 'auto'
            };
        }
    }

    // Variant Fallback (e.g. "Atlas II", "Atlas Prime")
    const baseName = shuffled[0] || 'Atlas';
    const variants = ['II', 'III', 'IV', 'Prime', 'Pro', 'Max', 'Nova'];

    for (const v of variants) {
        const variantName = `${baseName} ${v}`;
        if (isNameAvailable(userId, variantName)) {
            return {
                name: variantName,
                domain,
                name_source: 'auto'
            };
        }
    }

    // Last resort fallback
    return {
        name: `${baseName} ${Math.floor(10 + Math.random() * 90)}`,
        domain,
        name_source: 'auto'
    };
}

/**
 * Validate a user-specified name against uniqueness rules
 */
export function validateUserAgentName({ userId = 'default_user', name, excludeAgentId = null }) {
    if (!name || !name.trim()) {
        return { valid: false, error: 'Agent name cannot be empty.' };
    }

    const available = isNameAvailable(userId, name.trim(), excludeAgentId);
    if (!available) {
        return {
            valid: false,
            error: `The name "${name.trim()}" is already taken by another agent. Please choose a different name.`
        };
    }

    return { valid: true, name: name.trim(), name_source: 'user' };
}
