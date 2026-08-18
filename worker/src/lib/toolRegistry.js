export const TOOL_MANIFEST_VERSION = "2026-08-18.1";

const action = (description, risk = "safe", required = []) => ({ description, risk, required });

export const TOOL_REGISTRY = Object.freeze({
  files: {
    description: "Create, read, list, and revise user-owned task artifacts.",
    builtIn: true,
    actions: {
      create_file: action("Create a real file artifact", "safe", ["name", "content"]),
      read_file: action("Read a user-owned file", "safe"),
      list_files: action("List user-owned files", "safe"),
      edit_file: action("Create a new version of a user-owned file", "safe", ["content"]),
    },
  },
  last30days: {
    description: "Research current public discussion with citations.",
    builtIn: true,
    actions: { research: action("Research a current topic", "safe") },
  },
  gmail: {
    description: "Read, draft, and send Gmail messages.",
    actions: {
      read_emails: action("Read recent email", "safe"),
      search_emails: action("Search email", "safe"),
      draft_email: action("Create an email draft", "safe", ["to", "subject", "body"]),
      send_email: action("Send an email", "sensitive", ["to", "subject", "body"]),
    },
  },
  gcal: {
    description: "Read and manage Google Calendar.",
    actions: {
      list_events: action("Read calendar events", "safe"),
      create_event: action("Create a calendar event", "sensitive", ["title", "start_time", "end_time"]),
      update_event: action("Change a calendar event", "sensitive", ["event_id", "updates"]),
    },
  },
  slack: {
    description: "Read channels and send Slack messages.",
    actions: {
      read_channel: action("Read channel history", "safe", ["channel_id"]),
      send_message: action("Send a Slack message", "sensitive", ["channel_id", "text"]),
    },
  },
  github: {
    description: "Inspect repositories and perform approved repository actions.",
    actions: {
      list_prs: action("List pull requests", "safe", ["owner", "repo"]),
      get_commit: action("Read a commit", "safe", ["owner", "repo", "sha"]),
      search_code: action("Search repository code", "safe", ["query"]),
      create_issue: action("Create an issue", "sensitive", ["owner", "repo", "title"]),
      merge_pull_request: action("Merge a pull request", "restricted", ["owner", "repo", "pull_number"]),
    },
  },
  notion: {
    description: "Read and create Notion pages.",
    actions: {
      read_page: action("Read a Notion page", "safe", ["page_id"]),
      search_workspace: action("Search Notion", "safe", ["query"]),
      create_page: action("Create a Notion page", "sensitive", ["payload"]),
      delete_page: action("Archive a Notion page", "restricted", ["page_id"]),
    },
  },
  agentmail: {
    description: "Manage an agent-owned email inbox.",
    actions: {
      list_inboxes: action("List inboxes", "safe"),
      create_inbox: action("Create an agent inbox", "safe"),
      list_messages: action("List inbox messages", "safe", ["inbox_id"]),
      get_message: action("Read an inbox message", "safe", ["inbox_id", "message_id"]),
      send_message: action("Send an agent email", "sensitive", ["inbox_id", "to", "subject"]),
      reply_to_message: action("Reply to an agent email", "sensitive", ["inbox_id", "message_id"]),
    },
  },
  telegram: { description: "Send Telegram messages.", actions: { send_telegram_message: action("Send a Telegram message", "sensitive", ["chat_id", "text"]) } },
  discord: { description: "Send Discord messages.", actions: { send_discord_message: action("Send a Discord message", "sensitive", ["channel_id", "text"]) } },
  whatsapp: {
    description: "Read WhatsApp Business profile data and send messages.",
    actions: {
      get_business_profile: action("Read the business profile", "safe"),
      send_whatsapp_message: action("Send a WhatsApp message", "sensitive", ["to", "text"]),
    },
  },
  twilio: { description: "Send SMS.", actions: { send_sms: action("Send an SMS", "sensitive", ["to", "from", "text"]) } },
  hubspot: { description: "Read CRM contacts.", actions: { list_contacts: action("List CRM contacts", "safe") } },
  stripe: {
    description: "Inspect billing and perform tightly controlled billing actions.",
    actions: {
      list_customers: action("List customers", "safe"),
      get_invoice: action("Read an invoice", "safe", ["invoice_id"]),
      create_invoice: action("Create a draft invoice", "sensitive", ["customer_id"]),
      charge_customer: action("Create and confirm a payment", "restricted", ["amount", "currency"]),
    },
  },
  shopify: {
    description: "Read store data and perform approved catalog changes.",
    actions: {
      list_orders: action("List orders", "safe"),
      search_products: action("Search products", "safe"),
      create_product: action("Create a product", "sensitive", ["title"]),
    },
  },
});

export const TOOL_ALIASES = Object.freeze({ google_calendar: "gcal" });

export function normalizePluginId(pluginId) {
  return TOOL_ALIASES[pluginId] || pluginId;
}

export function getToolDefinition(pluginId, actionName) {
  const normalized = normalizePluginId(pluginId);
  const plugin = TOOL_REGISTRY[normalized];
  const definition = plugin?.actions?.[actionName];
  return definition ? { pluginId: normalized, plugin, action: definition } : null;
}

export function validateToolCall(step, allowedPlugins = []) {
  if (!step?.plugin_id || !step?.action || !step?.params || typeof step.params !== "object" || Array.isArray(step.params)) {
    return { ok: false, error: "An action must include plugin_id, action, and an object of params." };
  }
  const definition = getToolDefinition(step.plugin_id, step.action);
  if (!definition) return { ok: false, error: `Unknown tool action '${step.plugin_id}.${step.action}'.` };
  const normalizedAllowed = new Set(allowedPlugins.map(normalizePluginId));
  if (!normalizedAllowed.has(definition.pluginId)) {
    return { ok: false, error: `This agent is not allowed to use '${definition.pluginId}'.` };
  }
  const missing = definition.action.required.filter((key) => {
    if (key === "content" && step.action === "edit_file") return !(step.params.fileId || step.params.name) || typeof step.params.content !== "string";
    return step.params[key] === undefined || step.params[key] === null || step.params[key] === "";
  });
  if (missing.length) return { ok: false, error: `Missing required parameter(s): ${missing.join(", ")}.` };
  return { ok: true, ...definition };
}

export function toolsForAgent(pluginIds = []) {
  const ids = [...new Set(pluginIds.map(normalizePluginId))];
  return ids.flatMap((pluginId) => {
    const plugin = TOOL_REGISTRY[pluginId];
    if (!plugin) return [];
    return Object.entries(plugin.actions).map(([name, definition]) => ({
      name: `${pluginId}.${name}`,
      plugin_id: pluginId,
      action: name,
      description: definition.description,
      risk: definition.risk,
      required: definition.required,
    }));
  });
}
