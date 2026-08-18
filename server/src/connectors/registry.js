// ============================================================================
// AGENTIE CONNECTOR REGISTRY
// Catalogs available tools, schemas, and guardrail classification (irreversible)
// ============================================================================

export const CONNECTORS = {
    gmail: {
        id: 'gmail',
        name: 'Gmail',
        actions: {
            searchEmails: { name: 'searchEmails', irreversible: false, description: 'Search emails by query' },
            readThread: { name: 'readThread', irreversible: false, description: 'Read full email thread' },
            draftEmail: { name: 'draftEmail', irreversible: false, description: 'Draft an email in inbox' },
            sendEmail: { name: 'sendEmail', irreversible: true, description: 'Send an email directly to recipient' }
        }
    },
    gcal: {
        id: 'gcal',
        name: 'Google Calendar',
        actions: {
            checkAvailability: { name: 'checkAvailability', irreversible: false, description: 'Check schedule & free slots' },
            createMeeting: { name: 'createMeeting', irreversible: true, description: 'Send calendar invite & book meeting' }
        }
    },
    notion: {
        id: 'notion',
        name: 'Notion',
        actions: {
            searchPages: { name: 'searchPages', irreversible: false, description: 'Search workspace pages & docs' },
            readDoc: { name: 'readDoc', irreversible: false, description: 'Read document content' },
            createPage: { name: 'createPage', irreversible: false, description: 'Create page in workspace' },
            deletePage: { name: 'deletePage', irreversible: true, description: 'Delete page from workspace' }
        }
    },
    canva: {
        id: 'canva',
        name: 'Canva',
        actions: {
            searchTemplates: { name: 'searchTemplates', irreversible: false, description: 'Search graphic templates' },
            generateDesign: { name: 'generateDesign', irreversible: false, description: 'Generate visual design assets' },
            publishAsset: { name: 'publishAsset', irreversible: true, description: 'Publish graphic asset to public channels' }
        }
    },
    slack: {
        id: 'slack',
        name: 'Slack',
        actions: {
            readChannel: { name: 'readChannel', irreversible: false, description: 'Read channel history & threads' },
            sendMessage: { name: 'sendMessage', irreversible: true, description: 'Post message or alert to Slack channel' }
        }
    },
    github: {
        id: 'github',
        name: 'GitHub',
        actions: {
            searchRepos: { name: 'searchRepos', irreversible: false, description: 'Search repositories & code' },
            readIssue: { name: 'readIssue', irreversible: false, description: 'Read issue or PR discussion' },
            createIssue: { name: 'createIssue', irreversible: false, description: 'Open a new issue ticket' },
            mergePullRequest: { name: 'mergePullRequest', irreversible: true, description: 'Merge code pull request to branch' }
        }
    },
    stripe: {
        id: 'stripe',
        name: 'Stripe',
        actions: {
            getInvoice: { name: 'getInvoice', irreversible: false, description: 'Inspect invoice details & status' },
            createInvoice: { name: 'createInvoice', irreversible: false, description: 'Create draft invoice' },
            chargeCustomer: { name: 'chargeCustomer', irreversible: true, description: 'Execute payment transaction / charge money' }
        }
    },
    postgres: {
        id: 'postgres',
        name: 'PostgreSQL',
        actions: {
            readQuery: { name: 'readQuery', irreversible: false, description: 'Run read-only SELECT SQL queries' },
            writeQuery: { name: 'writeQuery', irreversible: true, description: 'Run INSERT/UPDATE/DELETE data modification query' }
        }
    },
    hubspot: {
        id: 'hubspot',
        name: 'HubSpot CRM',
        actions: {
            searchContacts: { name: 'searchContacts', irreversible: false, description: 'Search leads & contacts' },
            updateDealStage: { name: 'updateDealStage', irreversible: false, description: 'Update CRM deal pipeline stage' },
            deleteContact: { name: 'deleteContact', irreversible: true, description: 'Delete contact record from CRM' }
        }
    }
};

/**
 * Executes a connector action
 */
export async function runAction(connectorId, actionName, params = {}) {
    const connector = CONNECTORS[connectorId];
    if (!connector) {
        throw new Error(`Connector '${connectorId}' not found in registry.`);
    }

    const action = connector.actions[actionName];
    if (!action) {
        throw new Error(`Action '${actionName}' not supported by connector '${connectorId}'.`);
    }

    // Simulated reliable execution payload with structured telemetry
    return {
        success: true,
        connector: connectorId,
        action: actionName,
        params,
        executedAt: new Date().toISOString(),
        data: {
            summary: `Executed ${connector.name} > ${action.description}`,
            details: params
        }
    };
}
