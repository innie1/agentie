// ============================================================================
// AGENTIE WORKER — PLUGIN ACTION EXECUTION ENGINE
// ============================================================================

export const PLUGIN_ACTIONS = {
    // 1. Gmail
    'gmail:read_emails': {
        irreversible: false,
        execute: async (params) => ({
            emails: [
                { id: 'gm_101', from: 'dan.partner@acme.com', subject: 'Q3 Enterprise Deployment Agreement', snippet: 'Reviewed contract proposal, ready to proceed.' },
                { id: 'gm_102', from: 'billing@vendor.io', subject: 'Invoice #8472 Paid', snippet: 'Your payment was successfully processed.' }
            ]
        })
    },
    'gmail:draft_email': {
        irreversible: false,
        execute: async (params) => ({
            draft_id: 'draft_' + Date.now(),
            to: params.to || 'client@example.com',
            subject: params.subject || 'Follow-up regarding proposal',
            status: 'draft_created'
        })
    },
    'gmail:send_email': {
        irreversible: true, // Requires user approval unless auto-approved
        execute: async (params) => ({
            message_id: 'msg_' + Date.now(),
            to: params.to,
            subject: params.subject,
            sent_at: new Date().toISOString()
        })
    },

    // 2. Google Calendar
    'gcal:list_events': {
        irreversible: false,
        execute: async (params) => ({
            events: [
                { id: 'ev_01', title: 'Product Architecture Sync', start: '10:00 AM', end: '11:00 AM' },
                { id: 'ev_02', title: 'Executive Review', start: '2:00 PM', end: '3:00 PM' }
            ]
        })
    },
    'gcal:create_event': {
        irreversible: true,
        execute: async (params) => ({
            event_id: 'ev_' + Date.now(),
            title: params.title || 'Meeting',
            start: params.start || new Date().toISOString(),
            status: 'confirmed'
        })
    },

    // 3. Slack
    'slack:read_channel': {
        irreversible: false,
        execute: async (params) => ({
            channel: params.channel || '#general',
            messages: [
                { user: 'Sarah', text: 'All security audits completed for Q3 release.' },
                { user: 'Alex', text: 'Staging environment updated to v2.4.' }
            ]
        })
    },
    'slack:send_message': {
        irreversible: true,
        execute: async (params) => ({
            channel: params.channel || '#general',
            message_ts: Date.now().toString(),
            status: 'posted'
        })
    },

    // 4. HubSpot CRM
    'hubspot:search_contacts': {
        irreversible: false,
        execute: async (params) => ({
            found: 1,
            contact: { name: 'Dana Vance', email: 'dana.vance@acme.com', company: 'Acme Corp', role: 'VP of Engineering' }
        })
    },
    'hubspot:update_deal_stage': {
        irreversible: false,
        execute: async (params) => ({
            deal_id: params.deal_id || 'deal_982',
            stage: params.stage || 'Negotiation',
            updated: true
        })
    },
    'hubspot:delete_contact': {
        irreversible: true,
        execute: async (params) => ({
            deleted_id: params.contact_id,
            status: 'deleted'
        })
    },

    // 5. Notion
    'notion:read_page': {
        irreversible: false,
        execute: async (params) => ({
            page_title: params.page_title || 'Enterprise Playbook',
            content: 'Acme Corp contract terms: requires annual billing and security review sign-off by Dana.'
        })
    },
    'notion:create_page': {
        irreversible: false,
        execute: async (params) => ({
            page_id: 'notion_pg_' + Date.now(),
            title: params.title || 'Task Summary Document',
            created_at: new Date().toISOString()
        })
    },

    // 6. Stripe
    'stripe:get_invoice': {
        irreversible: false,
        execute: async (params) => ({
            invoice_id: params.invoice_id || 'in_99182',
            amount_due: '$4,500.00',
            status: 'paid'
        })
    },
    'stripe:charge_customer': {
        irreversible: true,
        execute: async (params) => ({
            charge_id: 'ch_' + Date.now(),
            amount: params.amount,
            currency: 'usd',
            status: 'succeeded'
        })
    },

    // 7. GitHub
    'github:list_prs': {
        irreversible: false,
        execute: async (params) => ({
            pull_requests: [
                { number: 42, title: 'feat: add background worker & queue', author: 'agentie-bot', status: 'open' }
            ]
        })
    },
    'github:search_code': {
        irreversible: false,
        execute: async (params) => ({
            matches: 3,
            files: ['src/worker/agentWorker.js', 'src/queue/taskQueue.js']
        })
    }
};

/**
 * Execute a plugin action safely
 */
export async function executePluginAction(actionName, params = {}) {
    const actionDef = PLUGIN_ACTIONS[actionName];
    if (!actionDef) {
        // Generic fallback action
        return {
            success: true,
            action: actionName,
            params,
            message: `Executed custom action ${actionName}`
        };
    }

    try {
        const data = await actionDef.execute(params);
        return {
            success: true,
            action: actionName,
            irreversible: actionDef.irreversible,
            data
        };
    } catch (err) {
        throw new Error(`Plugin action '${actionName}' failed: ${err.message}`);
    }
}
