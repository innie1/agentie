// Keep this manifest semantically aligned with the worker's toolRegistry. A
// parity test fails if action names or risk classifications drift.
export const TOOL_MANIFEST_VERSION = "2026-08-18.1";

const entries = {
  files: { builtIn: true, actions: { create_file: ["safe", ["name", "content"]], read_file: ["safe", []], list_files: ["safe", []], edit_file: ["safe", ["content"]] } },
  last30days: { builtIn: true, actions: { research: ["safe", []] } },
  gmail: { actions: { read_emails: ["safe", []], search_emails: ["safe", []], draft_email: ["safe", ["to", "subject", "body"]], send_email: ["sensitive", ["to", "subject", "body"]] } },
  gcal: { actions: { list_events: ["safe", []], create_event: ["sensitive", ["title", "start_time", "end_time"]], update_event: ["sensitive", ["event_id", "updates"]] } },
  slack: { actions: { read_channel: ["safe", ["channel_id"]], send_message: ["sensitive", ["channel_id", "text"]] } },
  github: { actions: { list_prs: ["safe", ["owner", "repo"]], get_commit: ["safe", ["owner", "repo", "sha"]], search_code: ["safe", ["query"]], create_issue: ["sensitive", ["owner", "repo", "title"]], merge_pull_request: ["restricted", ["owner", "repo", "pull_number"]] } },
  notion: { actions: { read_page: ["safe", ["page_id"]], search_workspace: ["safe", ["query"]], create_page: ["sensitive", ["payload"]], delete_page: ["restricted", ["page_id"]] } },
  agentmail: { actions: { list_inboxes: ["safe", []], create_inbox: ["safe", []], list_messages: ["safe", ["inbox_id"]], get_message: ["safe", ["inbox_id", "message_id"]], send_message: ["sensitive", ["inbox_id", "to", "subject"]], reply_to_message: ["sensitive", ["inbox_id", "message_id"]] } },
  telegram: { actions: { send_telegram_message: ["sensitive", ["chat_id", "text"]] } },
  discord: { actions: { send_discord_message: ["sensitive", ["channel_id", "text"]] } },
  whatsapp: { actions: { get_business_profile: ["safe", []], send_whatsapp_message: ["sensitive", ["to", "text"]] } },
  twilio: { actions: { send_sms: ["sensitive", ["to", "from", "text"]] } },
  hubspot: { actions: { list_contacts: ["safe", []] } },
  stripe: { actions: { list_customers: ["safe", []], get_invoice: ["safe", ["invoice_id"]], create_invoice: ["sensitive", ["customer_id"]], charge_customer: ["restricted", ["amount", "currency"]] } },
  shopify: { actions: { list_orders: ["safe", []], search_products: ["safe", []], create_product: ["sensitive", ["title"]] } },
};

export const TOOL_REGISTRY = Object.freeze(Object.fromEntries(Object.entries(entries).map(([pluginId, plugin]) => [pluginId, {
  builtIn: !!plugin.builtIn,
  actions: Object.fromEntries(Object.entries(plugin.actions).map(([name, [risk, required]]) => [name, { risk, required, description: `${name.replaceAll("_", " ")} using ${pluginId}` }]))
}])));
export const TOOL_ALIASES = Object.freeze({ google_calendar: "gcal" });
export const normalizePluginId = (pluginId) => TOOL_ALIASES[pluginId] || pluginId;

export function getToolDefinition(pluginId, actionName) {
  const normalized = normalizePluginId(pluginId);
  const plugin = TOOL_REGISTRY[normalized];
  const definition = plugin?.actions?.[actionName];
  return definition ? { pluginId: normalized, plugin, action: definition } : null;
}

export function validateToolCall(step, allowedPlugins = []) {
  if (!step?.plugin_id || !step?.action || !step?.params || typeof step.params !== "object" || Array.isArray(step.params)) return { ok: false, error: "Invalid tool call." };
  const definition = getToolDefinition(step.plugin_id, step.action);
  if (!definition) return { ok: false, error: `Unknown tool action '${step.plugin_id}.${step.action}'.` };
  if (!new Set(allowedPlugins.map(normalizePluginId)).has(definition.pluginId)) return { ok: false, error: `Tool '${definition.pluginId}' is not allowed.` };
  const missing = definition.action.required.filter((key) => {
    if (key === "content" && step.action === "edit_file") return !(step.params.fileId || step.params.name) || typeof step.params.content !== "string";
    return step.params[key] === undefined || step.params[key] === null || step.params[key] === "";
  });
  return missing.length ? { ok: false, error: `Missing required parameter(s): ${missing.join(", ")}.` } : { ok: true, ...definition };
}

export function toolsForAgent(pluginIds = []) {
  return [...new Set(pluginIds.map(normalizePluginId))].flatMap((pluginId) => Object.entries(TOOL_REGISTRY[pluginId]?.actions || {}).map(([name, definition]) => ({ name: `${pluginId}.${name}`, plugin_id: pluginId, action: name, ...definition })));
}
