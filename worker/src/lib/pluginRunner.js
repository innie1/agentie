import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { decrypt, encrypt } from "./crypto.js";
import { runFileTool } from "./fileTools.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function decodeCredentialValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;
  try { return decrypt(value); } catch { return value; }
}

function parseStoredCredentials(row) {
  const stored = row?.credentials;
  if (!stored || typeof stored !== "object") return null;
  const source = stored.values && typeof stored.values === "object" ? stored.values : stored;
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (["type", "token_type", "expires_at"].includes(key)) continue;
    if (value === null || value === undefined) continue;
    out[key] = decodeCredentialValue(value);
  }
  if (stored.access_token) out.access_token = decodeCredentialValue(stored.access_token);
  if (stored.refresh_token) out.refresh_token = decodeCredentialValue(stored.refresh_token);
  if (stored.expires_at) out.expires_at = stored.expires_at;
  if (!out.access_token) out.access_token = out.token || out.api_key || out.apiKey || null;
  return out;
}

async function getCredential(userId, pluginId) {
  const lookupIds = pluginId === "gcal" ? ["gcal", "google_calendar"] : [pluginId];
  const { data, error } = await supabaseAdmin.from("user_plugins").select("id,plugin_id,credentials,status").eq("user_id", userId).in("plugin_id", lookupIds).eq("status", "active").limit(1).maybeSingle();
  if (error || !data || data.status !== "active") return null;
  const cred = parseStoredCredentials(data);
  if (!cred) return null;
  if (cred.expires_at && new Date(cred.expires_at) < new Date(Date.now() + 5 * 60 * 1000) && cred.refresh_token && ["gmail", "gcal", "google_calendar"].includes(pluginId)) {
    const refreshed = await refreshGoogleToken(data, cred); if (refreshed) return refreshed;
  }
  return cred;
}

async function refreshGoogleToken(row, currentCred = null) {
  const refreshToken = currentCred?.refresh_token || parseStoredCredentials(row)?.refresh_token;
  if (!refreshToken) return null;
  try {
    const res = await axios.post("https://oauth2.googleapis.com/token", new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }));
    const newAccessToken = res.data.access_token;
    const newExpiresAt = new Date(Date.now() + res.data.expires_in * 1000).toISOString();
    const previous = row.credentials || {};
    const updated = {
      ...previous,
      access_token: encrypt(newAccessToken),
      refresh_token: previous.refresh_token || encrypt(refreshToken),
      expires_at: newExpiresAt,
      type: previous.type || "oauth"
    };
    await supabaseAdmin.from("user_plugins").update({ credentials: updated, status: "active" }).eq("id", row.id);
    return { access_token: newAccessToken, refresh_token: refreshToken, expires_at: newExpiresAt };
  } catch (err) {
    console.error("[pluginRunner] Google token refresh failed:", err.response?.data || err.message);
    await supabaseAdmin.from("user_plugins").update({ status: "expired" }).eq("id", row.id); return null;
  }
}

async function gmailAction(cred, action, params) {
  const headers = { Authorization: `Bearer ${cred.access_token}` };
  if (action === "read_emails" || action === "search_emails") { const r = await axios.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", { headers, params: { q: params.query || "in:inbox", maxResults: params.limit || 10 } }); return r.data; }
  if (action === "send_email") { const raw = makeRawEmail(params.to, params.subject, params.body); const r = await axios.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw }, { headers }); return r.data; }
  if (action === "draft_email") { const raw = makeRawEmail(params.to, params.subject, params.body); const r = await axios.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw } }, { headers }); return r.data; }
  throw new Error(`Unknown gmail action: ${action}`);
}
function makeRawEmail(to, subject, body) { return Buffer.from([`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

async function calendarAction(cred, action, params) {
  const headers = { Authorization: `Bearer ${cred.access_token}` }; const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  if (action === "list_events") { const r = await axios.get(base, { headers, params: { timeMin: params.time_min || new Date().toISOString(), maxResults: params.limit || 10, singleEvents: true, orderBy: "startTime" } }); return r.data; }
  if (action === "create_event") { const r = await axios.post(base, { summary: params.title, start: { dateTime: params.start_time }, end: { dateTime: params.end_time }, description: params.description }, { headers }); return r.data; }
  if (action === "update_event") { const r = await axios.patch(`${base}/${params.event_id}`, params.updates, { headers }); return r.data; }
  throw new Error(`Unknown google_calendar action: ${action}`);
}

async function slackAction(cred, action, params) {
  const headers = { Authorization: `Bearer ${cred.access_token}` };
  if (action === "read_channel") { const r = await axios.get("https://slack.com/api/conversations.history", { headers, params: { channel: params.channel_id, limit: params.limit || 20 } }); return r.data; }
  if (action === "send_message") { const r = await axios.post("https://slack.com/api/chat.postMessage", { channel: params.channel_id, text: params.text }, { headers }); return r.data; }
  throw new Error(`Unknown slack action: ${action}`);
}

async function githubAction(cred, action, params) {
  const token = cred.access_token || cred.token || cred.api_key;
  if (!token) throw new Error("GitHub is connected but no usable token was found");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (action === "list_prs") { const r = await axios.get(`https://api.github.com/repos/${params.owner}/${params.repo}/pulls`, { headers }); return r.data; }
  if (action === "get_commit") { const r = await axios.get(`https://api.github.com/repos/${params.owner}/${params.repo}/commits/${params.sha}`, { headers }); return r.data; }
  if (action === "search_code") { const r = await axios.get("https://api.github.com/search/code", { headers, params: { q: params.query } }); return r.data; }
  throw new Error(`Unknown github action: ${action}`);
}

async function notionAction(cred, action, params) {
  const headers = { Authorization: `Bearer ${cred.access_token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
  if (action === "read_page") { const r = await axios.get(`https://api.notion.com/v1/pages/${params.page_id}`, { headers }); return r.data; }
  if (action === "search_workspace") { const r = await axios.post("https://api.notion.com/v1/search", { query: params.query }, { headers }); return r.data; }
  if (action === "create_page") { const r = await axios.post("https://api.notion.com/v1/pages", params.payload, { headers }); return r.data; }
  throw new Error(`Unknown notion action: ${action}`);
}

async function last30daysAction(action, params = {}) {
  if (action !== "research") throw new Error(`Unknown last30days action: ${action}`);
  const topic = String(params.topic || params.query || "").trim(); if (!topic) throw new Error("Last30Days requires a topic");
  const python = process.env.LAST30DAYS_PYTHON || "python3";
  const script = process.env.LAST30DAYS_SCRIPT || "/opt/last30days/skills/last30days/scripts/last30days.py";
  const args = [script, topic, "--emit=compact"];
  const { stdout, stderr } = await execFileAsync(python, args, { timeout: 180000, maxBuffer: 12 * 1024 * 1024, env: process.env });
  if (stderr) console.warn("[last30days]", stderr.slice(0, 4000));
  return { topic, output: stdout.trim() };
}

const HANDLERS = { gmail: gmailAction, gcal: calendarAction, google_calendar: calendarAction, slack: slackAction, github: githubAction, notion: notionAction };

export const IRREVERSIBLE_ACTIONS = new Set(["send_email", "send_message", "create_event", "update_event", "create_page", "edit_file"]);

export async function runPluginAction({ userId, agentId, taskId, pluginId, action, params }) {
  try {
    let data;
    if (pluginId === "files") data = (await runFileTool({ userId, agentId, action, params })).data;
    else if (pluginId === "last30days") data = await last30daysAction(action, params);
    else {
      const handler = HANDLERS[pluginId];
      if (!handler) return { ok: false, error: `No handler wired up for plugin '${pluginId}'` };
      const cred = await getCredential(userId, pluginId);
      if (!cred) return { ok: false, error: `'${pluginId}' isn't connected or its access has expired. Connect it in Plugins first.` };
      data = await handler(cred, action, params || {});
    }
    await supabaseAdmin.from("action_log").insert({ agent_id: agentId, task_id: taskId, action: `${pluginId}.${action}`, params, result: data });
    return { ok: true, data };
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
    await supabaseAdmin.from("action_log").insert({ agent_id: agentId, task_id: taskId, action: `${pluginId}.${action}`, params, result: { error: errMsg } });
    return { ok: false, error: errMsg };
  }
}
