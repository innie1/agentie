import express from "express";
import axios from "axios";
import crypto from "crypto";
import { supabaseAdmin } from "../supabaseClient.js";
import { encrypt } from "../lib/crypto.js";
import { OAUTH_PROVIDERS } from "../lib/oauthProviders.js";

const router = express.Router();

const DEFAULT_PLUGINS = [
  { id: 'gmail', name: 'Gmail', category: 'Featured', auth_type: 'oauth', description: 'Read, summarize, draft and send emails with your connected Google account.' },
  { id: 'gcal', name: 'Google Calendar', category: 'Featured', auth_type: 'oauth', description: 'Check schedules, manage meeting invites, and sync events seamlessly.' },
  { id: 'slack', name: 'Slack', category: 'Featured', auth_type: 'oauth', description: 'Monitor channels, send thread replies, and dispatch webhooks to your team.' },
  { id: 'github', name: 'GitHub', category: 'Featured', auth_type: 'oauth', description: 'Inspect pull requests, review commits, and query code repositories.' },
  { id: 'notion', name: 'Notion', category: 'Featured', auth_type: 'oauth', description: 'Sync knowledge bases, read workspace pages, and draft formatted docs.' },
  { id: 'agentmail', name: 'AgentMail', category: 'Featured', auth_type: 'api_key', description: 'Give agents their own email inboxes so they can send, receive, search, and reply as themselves.' },
  { id: 'granola', name: 'Granola', category: 'Featured', auth_type: 'oauth', description: 'Access real-time meeting notes, transcripts, and AI action items.' },
  { id: 'outlook', name: 'Microsoft Outlook', category: 'Email & Communication', auth_type: 'oauth', description: 'Connect to Microsoft 365 Exchange mailboxes to read and draft emails.' },
  { id: 'discord', name: 'Discord', category: 'Email & Communication', auth_type: 'api_key', description: 'Post notifications, manage community channels, and interact via bot tokens.' },
  { id: 'telegram', name: 'Telegram', category: 'Email & Communication', auth_type: 'api_key', description: 'Send direct messages, broadcast alerts, and manage Telegram bots.' },
  { id: 'whatsapp', name: 'WhatsApp Business', category: 'Email & Communication', auth_type: 'api_key', description: 'Automate customer support chats and dispatch WhatsApp notifications.' },
  { id: 'zoom', name: 'Zoom', category: 'Email & Communication', auth_type: 'oauth', description: 'Generate instant video meeting links and summarize cloud recordings.' },
  { id: 'twilio', name: 'Twilio SMS', category: 'Email & Communication', auth_type: 'api_key', description: 'Send SMS text messages and telephony alerts to phone numbers.' },
  { id: 'x_twitter', name: 'X / Twitter', category: 'Social Media', auth_type: 'oauth', description: 'Draft and schedule tweets, analyze engagement metrics, and monitor mentions.' },
  { id: 'linkedin', name: 'LinkedIn', category: 'Social Media', auth_type: 'oauth', description: 'Publish professional updates, manage company pages, and expand reach.' },
  { id: 'youtube', name: 'YouTube', category: 'Social Media', auth_type: 'oauth', description: 'Analyze video transcripts, optimize video titles, and track channel analytics.' },
  { id: 'instagram', name: 'Instagram', category: 'Social Media', auth_type: 'oauth', description: 'Generate post captions, schedule carousel updates, and analyze reach.' },
  { id: 'hubspot', name: 'HubSpot CRM', category: 'Social Media', auth_type: 'api_key', description: 'Sync leads, update CRM deal stages, and track outbound marketing campaigns.' },
  { id: 'canva', name: 'Canva', category: 'Productivity & Workspace', auth_type: 'oauth', description: 'Create graphics, edit social media templates, presentations, and export visual assets.' },
  { id: 'figma', name: 'Figma', category: 'Productivity & Workspace', auth_type: 'oauth', description: 'Inspect design frames, export UI assets, and review layout comments.' },
  { id: 'gdrive', name: 'Google Drive', category: 'Productivity & Workspace', auth_type: 'oauth', description: 'Search and read Google Docs, Sheets, PDFs, and team folder assets.' },
  { id: 'linear', name: 'Linear', category: 'Productivity & Workspace', auth_type: 'oauth', description: 'Create issues, track sprint cycles, and update product roadmaps.' },
  { id: 'trello', name: 'Trello', category: 'Productivity & Workspace', auth_type: 'oauth', description: 'Manage kanban boards, drag cards, and organize team task lists.' },
  { id: 'jira', name: 'Jira Software', category: 'Productivity & Workspace', auth_type: 'oauth', description: 'Track agile development epics, user stories, and release versions.' },
  { id: 'airtable', name: 'Airtable', category: 'Productivity & Workspace', auth_type: 'oauth', description: 'Query relational tables, update records, and generate workflow views.' },
  { id: 'postgres', name: 'PostgreSQL Database', category: 'Developer & Data', auth_type: 'api_key', description: 'Execute secure SQL queries, inspect table schemas, and aggregate data.' },
  { id: 'stripe', name: 'Stripe Payments', category: 'Developer & Data', auth_type: 'api_key', description: 'Create invoices, look up customer subscriptions, and check billing history.' },
  { id: 'shopify', name: 'Shopify Store', category: 'Developer & Data', auth_type: 'api_key', description: 'Manage e-commerce inventory, look up order statuses, and create products.' },
  { id: 'aws', name: 'AWS Cloud Services', category: 'Developer & Data', auth_type: 'api_key', description: 'Deploy serverless jobs, manage S3 storage buckets, and monitor CloudWatch.' }
];

router.get("/", async (req, res) => {
  const userId = req.user.id;
  let dbPlugins = [];
  let addedMap = {};
  try {
    const result = await supabaseAdmin.from("plugins").select("*").eq("status", "active");
    dbPlugins = result.data || [];
    const { data: userPlugins } = await supabaseAdmin.from("user_plugins").select("plugin_id,status").eq("user_id", userId);
    addedMap = Object.fromEntries((userPlugins || []).map((p) => [p.plugin_id, p]));
  } catch {}
  const byId = new Map(DEFAULT_PLUGINS.map(p => [p.id, p]));
  for (const p of dbPlugins) byId.set(p.id, { ...byId.get(p.id), ...p });
  res.json({ plugins: [...byId.values()].map(p => ({ ...p, added: !!addedMap[p.id], added_status: addedMap[p.id]?.status ?? null })) });
});

router.post("/:pluginId/start", async (req, res) => {
  const userId = req.user.id;
  const { pluginId } = req.params;
  const { data: plugin, error } = await supabaseAdmin.from("plugins").select("*").eq("id", pluginId).single();
  if (error || !plugin) return res.status(404).json({ error: "Unknown plugin" });
  if (plugin.auth_type !== "oauth") return res.status(400).json({ error: "This plugin uses api_key flow, call /add-api-key instead" });
  const provider = OAUTH_PROVIDERS[pluginId];
  if (!provider?.clientId) return res.status(500).json({ error: `No OAuth app configured for '${pluginId}'. Set its client id/secret in server env vars.` });
  const state = crypto.randomBytes(24).toString("hex");
  const { error: insertErr } = await supabaseAdmin.from("pending_auth").insert({ user_id: userId, plugin_id: pluginId, state });
  if (insertErr) return res.status(500).json({ error: insertErr.message });
  const redirectUri = `${process.env.APP_URL}/api/plugins/callback`;
  const params = new URLSearchParams({ client_id: provider.clientId, redirect_uri: redirectUri, scope: (plugin.oauth_scopes || []).join(" "), response_type: "code", state, access_type: "offline", prompt: "consent" });
  res.json({ authorize_url: `${plugin.oauth_authorize_url}?${params.toString()}` });
});

export async function oauthCallbackHandler(req, res) {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("Missing code or state");
  const { data: pending, error: pErr } = await supabaseAdmin.from("pending_auth").select("*").eq("state", state).gt("expires_at", new Date().toISOString()).single();
  if (pErr || !pending) return res.status(400).send("Invalid or expired auth attempt. Please try Add again.");
  const provider = OAUTH_PROVIDERS[pending.plugin_id];
  const { data: plugin } = await supabaseAdmin.from("plugins").select("*").eq("id", pending.plugin_id).single();
  const redirectUri = `${process.env.APP_URL}/api/plugins/callback`;
  try {
    const tokenReqConfig = { headers: { "Content-Type": "application/x-www-form-urlencoded", ...(provider.tokenHeaders || {}) } };
    if (provider.basicAuth) tokenReqConfig.auth = provider.basicAuth();
    const body = new URLSearchParams(provider.tokenBody(code, redirectUri));
    const tokenRes = await axios.post(plugin.oauth_token_url, body, tokenReqConfig);
    const parsed = provider.parseToken(tokenRes.data);
    if (!parsed.access_token) throw new Error("Provider did not return an access_token");
    const expiresAt = parsed.expires_in ? new Date(Date.now() + parsed.expires_in * 1000).toISOString() : null;
    const credentials = { type: "oauth", access_token: encrypt(parsed.access_token), refresh_token: parsed.refresh_token ? encrypt(parsed.refresh_token) : null, token_type: parsed.token_type || "Bearer", expires_at: expiresAt };
    const { error: saveErr } = await supabaseAdmin.from("user_plugins").upsert({ user_id: pending.user_id, plugin_id: pending.plugin_id, credentials, status: "active" }, { onConflict: "user_id,plugin_id" });
    if (saveErr) throw saveErr;
    await supabaseAdmin.from("pending_auth").delete().eq("id", pending.id);
    res.redirect(`${process.env.APP_URL}/plugins?added=${pending.plugin_id}`);
  } catch (err) {
    console.error("[oauth callback]", err.response?.data || err.message);
    res.redirect(`${process.env.APP_URL}/plugins?error=${pending.plugin_id}`);
  }
}

router.post("/:pluginId/add-api-key", async (req, res) => {
  const userId = req.user.id;
  const { pluginId } = req.params;
  const { api_key, credentials } = req.body || {};
  const supplied = credentials && typeof credentials === "object" ? credentials : (api_key ? { api_key } : null);
  if (!supplied) return res.status(400).json({ error: "credentials are required" });
  const dbResult = await supabaseAdmin.from("plugins").select("*").eq("id", pluginId).maybeSingle();
  const plugin = dbResult.data || DEFAULT_PLUGINS.find(p => p.id === pluginId);
  if (!plugin) return res.status(404).json({ error: "Unknown plugin" });
  if (plugin.auth_type !== "api_key") return res.status(400).json({ error: "This plugin uses OAuth, not an API key" });
  const valid = await testApiKey(pluginId, supplied);
  if (!valid.ok) return res.status(400).json({ error: valid.error || "Credential validation failed" });
  const encrypted = Object.fromEntries(Object.entries(supplied).map(([k, v]) => [k, encrypt(String(v))]));
  const { error: saveErr } = await supabaseAdmin.from("user_plugins").upsert({ user_id: userId, plugin_id: pluginId, credentials: { type: "api_key", values: encrypted }, status: "active" }, { onConflict: "user_id,plugin_id" });
  if (saveErr) return res.status(500).json({ error: saveErr.message });
  res.json({ ok: true });
});

router.delete("/:pluginId", async (req, res) => {
  const { error } = await supabaseAdmin.from("user_plugins").delete().eq("user_id", req.user.id).eq("plugin_id", req.params.pluginId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

async function testApiKey(pluginId, c) {
  try {
    switch (pluginId) {
      case "agentmail": {
        if (!c.api_key) return { ok: false, error: "AgentMail API key is required" };
        const r = await axios.get("https://api.agentmail.to/v0/inboxes", { headers: { Authorization: `Bearer ${c.api_key}` }, params: { limit: 1 } });
        return { ok: r.status === 200 };
      }
      case "stripe": {
        if (!c.api_key) return { ok: false, error: "Stripe secret key is required" };
        const r = await axios.get("https://api.stripe.com/v1/account", { auth: { username: c.api_key, password: "" } });
        return { ok: r.status === 200 };
      }
      case "shopify": {
        if (!c.shop_domain || !c.admin_access_token) return { ok: false, error: "Shop domain and Admin API access token are required" };
        const domain = String(c.shop_domain).replace(/^https?:\/\//, "").replace(/\/$/, "");
        const r = await axios.get(`https://${domain}/admin/api/2025-10/shop.json`, { headers: { "X-Shopify-Access-Token": c.admin_access_token } });
        return { ok: r.status === 200 };
      }
      case "whatsapp": {
        if (!c.access_token || !c.phone_number_id) return { ok: false, error: "WhatsApp access token and phone number ID are required" };
        const r = await axios.get(`https://graph.facebook.com/v23.0/${encodeURIComponent(c.phone_number_id)}`, { headers: { Authorization: `Bearer ${c.access_token}` } });
        return { ok: r.status === 200 };
      }
      case "telegram": {
        if (!c.bot_token) return { ok: false, error: "Telegram bot token is required" };
        const r = await axios.get(`https://api.telegram.org/bot${c.bot_token}/getMe`);
        return { ok: r.data?.ok === true };
      }
      case "discord": {
        if (!c.bot_token) return { ok: false, error: "Discord bot token is required" };
        const r = await axios.get("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${c.bot_token}` } });
        return { ok: r.status === 200 };
      }
      case "twilio": {
        if (!c.account_sid || !c.auth_token) return { ok: false, error: "Twilio Account SID and Auth Token are required" };
        const r = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.account_sid)}.json`, { auth: { username: c.account_sid, password: c.auth_token } });
        return { ok: r.status === 200 };
      }
      case "hubspot": {
        if (!c.access_token) return { ok: false, error: "HubSpot private app access token is required" };
        const r = await axios.get("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", { headers: { Authorization: `Bearer ${c.access_token}` } });
        return { ok: r.status === 200 };
      }
      default:
        return { ok: false, error: `No credential-validation logic is wired for '${pluginId}' yet.` };
    }
  } catch (err) {
    const providerError = err.response?.data?.error?.message || err.response?.data?.message || err.response?.data?.errors?.[0]?.message;
    return { ok: false, error: providerError || err.message || "Provider rejected the credentials" };
  }
}

export default router;