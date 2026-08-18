// ============================================================================
// AGENTIE DATABASE STORE (SUPABASE / POSTGRESQL DATA LAYER)
// ============================================================================

export const db = {
    plugins: [
        { id: 'gmail', name: 'Gmail', auth_type: 'oauth', status: 'active' },
        { id: 'gcal', name: 'Google Calendar', auth_type: 'oauth', status: 'active' },
        { id: 'slack', name: 'Slack', auth_type: 'oauth', status: 'active' },
        { id: 'github', name: 'GitHub', auth_type: 'oauth', status: 'active' },
        { id: 'notion', name: 'Notion', auth_type: 'oauth', status: 'active' },
        { id: 'canva', name: 'Canva', auth_type: 'oauth', status: 'active' },
        { id: 'hubspot', name: 'HubSpot CRM', auth_type: 'api_key', status: 'active' },
        { id: 'stripe', name: 'Stripe Payments', auth_type: 'api_key', status: 'active' },
        { id: 'postgres', name: 'PostgreSQL Database', auth_type: 'api_key', status: 'active' }
    ],

    user_plugins: [
        {
            id: 'up_001',
            user_id: 'default_user',
            plugin_id: 'gmail',
            credentials: { auth_type: 'oauth', token_hash: 'enc_gmail_token_active' },
            status: 'active',
            added_at: new Date(Date.now() - 86400000).toISOString(),
            updated_at: new Date().toISOString()
        },
        {
            id: 'up_002',
            user_id: 'default_user',
            plugin_id: 'notion',
            credentials: { auth_type: 'oauth', token_hash: 'enc_notion_token_active' },
            status: 'active',
            added_at: new Date(Date.now() - 86400000).toISOString(),
            updated_at: new Date().toISOString()
        }
    ],

    agents: [
        {
            id: 'a001-sales-agent',
            user_id: 'default_user',
            name: 'Apollo',
            name_source: 'auto',
            role: 'Sales Outbound Representative',
            goal: 'Find high-intent leads, draft personalized outreach, schedule discovery calls, and log replies in CRM.',
            system_prompt: 'You are an autonomous Sales Outbound Agent named Apollo. Your primary goal is to find high-intent leads, draft personalized outreach, schedule discovery calls, and log replies in CRM. Allowed plugins: [gmail, gcal, hubspot, notion].',
            allowed_plugins: ['gmail', 'gcal', 'hubspot', 'notion'],
            auto_approved_actions: ['gmail:search_emails', 'hubspot:search_contacts', 'notion:read_page'],
            status: 'active',
            created_at: new Date(Date.now() - 3600000).toISOString(),
            updated_at: new Date().toISOString()
        },
        {
            id: 'a002-chief-agent',
            user_id: 'default_user',
            name: 'Atlas',
            name_source: 'auto',
            role: 'Executive Operations & Coordinator',
            goal: 'Synthesize team updates across Slack and Notion, prepare weekly roadmaps, and delegate operational action items.',
            system_prompt: 'You are an autonomous Chief of Staff Agent named Atlas. Your primary goal is to synthesize cross-team updates across Slack and Notion, prepare weekly executive summaries, and delegate operational action items to specialized agents.',
            allowed_plugins: ['slack', 'notion', 'gcal', 'canva'],
            auto_approved_actions: ['slack:read_channel', 'notion:search_workspace'],
            status: 'active',
            created_at: new Date(Date.now() - 7200000).toISOString(),
            updated_at: new Date().toISOString()
        }
    ],

    routines: [],

    tasks: [
        {
            id: 't001',
            user_id: 'default_user',
            agent_id: 'a001-sales-agent',
            instruction: 'Research Acme Corp accounts on HubSpot and draft outbound pitch email.',
            context: { targetCompany: 'Acme Corp', campaign: 'Q3 Enterprise Outreach' },
            source: 'manual',
            routine_id: null,
            status: 'done',
            current_step: 3,
            steps: [
                { stepNumber: 1, action: 'hubspot:search_contacts', description: 'Query CRM for Acme Corp decision makers', status: 'completed' },
                { stepNumber: 2, action: 'notion:read_page', description: 'Load enterprise positioning cheat sheet', status: 'completed' },
                { stepNumber: 3, action: 'gmail:draft_email', description: 'Draft tailored executive outbound email', status: 'completed' }
            ],
            paused_step_data: null,
            result: 'Identified Acme Corp VP of Engineering (Dana Vance). Drafted customized enterprise platform pitch and logged contact profile in CRM.',
            created_at: new Date(Date.now() - 1800000).toISOString(),
            updated_at: new Date().toISOString()
        }
    ],

    agent_memory: [
        {
            id: 'm001',
            agent_id: 'a001-sales-agent',
            key: 'client_contract_preference',
            value: 'Acme Corp prefers annual upfront billing and requires Dana Vance sign-off.',
            created_at: new Date(Date.now() - 1500000).toISOString(),
            updated_at: new Date().toISOString()
        }
    ],

    task_handoffs: [],

    action_log: [
        {
            id: 'l001',
            agent_id: 'a001-sales-agent',
            task_id: 't001',
            plugin_id: 'hubspot',
            action: 'search_contacts',
            params: { query: 'Acme Corp' },
            result: { found: 1, contact: 'Dana Vance' },
            status: 'success',
            timestamp: new Date(Date.now() - 1780000).toISOString()
        }
    ],

    pending_auth: [],

    models_config: [
        {
            id: 'fast',
            tier: 'fast',
            model_id: 'google/gemini-2.0-flash-001',
            provider: 'Google',
            speed_score: 95,
            context_length: 1000000,
            is_pinned: false,
            updated_at: new Date().toISOString()
        },
        {
            id: 'reasoning',
            tier: 'reasoning',
            model_id: 'anthropic/claude-3.5-sonnet',
            provider: 'Anthropic',
            speed_score: 85,
            context_length: 200000,
            is_pinned: false,
            updated_at: new Date().toISOString()
        }
    ],

    token_usage: []
};
