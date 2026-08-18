import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { decrypt, encrypt } from "./crypto.js";

// Every action returns { ok, data, error }. Never throws past this file —
// the agent loop decides what to do with a failure.

async function getCredential(userId, pluginId) {
  const { data, error } = await supabaseAdmin
    .from("user_plugins")
    .select("*")
    .eq("user_id", userId)
    .eq("plugin_id", pluginId)
    .single();

  if (error || !data) return null;
  if (data.status !== "active") return null;

  // refresh Google tokens proactively if close to expiry
  if (data.expires_at && new Date(data.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    const refreshed = await refreshGoogleToken(data);
    if (refreshed) return refreshed;
  }

  return {
    access_token: decrypt(data.access_token),
    refresh_token: decrypt(data.refresh_token),
    api_key: decrypt(data.api_key),
  };
}

async function refreshGoogleToken(row) {
  const refreshToken = decrypt(row.refresh_token);
  if (!refreshToken) return null;
  try {
    const res = await axios.post("https://oauth2.googleapis.com/token", new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }));
    const newAccessToken = res.data.access_token;
    const newExpiresAt = new Date(Date.now() + res.data.expires_in * 1000).toISOString();

    await supabaseAdmin
      .from("user_plugins")
      .update({ access_token: encrypt(newAccessToken), expires_at: newExpiresAt })
      .eq("id", row.id);

    return { access_token: newAccessToken, refresh_token: refreshToken, api_key: null };
  } catch (err) {
    console.error("[pluginRunner] Google token refresh failed:", err.response?.data || err.message);
    await supabaseAdmin.from("user_plugins").update({ status: "expired" }).eq("id", row.id);
    return null;
  }
}

// ── Gmail ──────────────────────────────────────────────
async function gmailAction(cred, action, params) {
  const headers = { Authorization: `Bearer ${cred.access_token}` };

  if (action === "read_emails" || action === "search_emails") {
    const q = params.query || "in:inbox";
    const r = await axios.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
      headers,
      params: { q, maxResults: params.limit || 10 },
    });
    return r.data;
  }

  if (action === "send_email") {
    const raw = makeRawEmail(params.to, params.subject, params.body);
    const r = await axios.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { raw },
      { headers }
    );
    return r.data;
  }

  if (action === "draft_email") {
    const raw = makeRawEmail(params.to, params.subject, params.body);
    const r = await axios.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      { message: { raw } },
      { headers }
    );
    return r.data;
  }

  throw new Error(`Unknown gmail action: ${action}`);
}

function makeRawEmail(to, subject, body) {
  const message = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\n");
  return Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Google Calendar ────────────────────────────────────
async function calendarAction(cred, action, params) {
  const headers = { Authorization: `Bearer ${cred.access_token}` };
  const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

  if (action === "list_events") {
    const r = await axios.get(base, {
      headers,
      params: { timeMin: params.time_min || new Date().toISOString(), maxResults: params.limit || 10, singleEvents: true, orderBy: "startTime" },
    });
    return r.data;
  }
  if (action === "create_event") {
    const r = await axios.post(base, {
      summary: params.title,
      start: { dateTime: params.start_time },
      end: { dateTime: params.end_time },
      description: params.description,
    }, { headers });
    return r.data;
  }
  if (action === "update_event") {
    const r = await axios.patch(`${base}/${params.event_id}`, params.updates, { headers });
    return r.data;
  }
  throw new Error(`Unknown google_calendar action: ${action}`);
}

// ── Slack ──────────────────────────────────────────────
async function slackAction(cred, action, params) {
  const headers = { Authorization: `Bearer ${cred.access_token}` };

  if (action === "read_channel") {
    const r = await axios.get("https://slack.com/api/conversations.history", {
      headers,
      params: { channel: params.channel_id, limit: params.limit || 20 },
    });
    return r.data;
  }
  if (action === "send_message") {
    const r = await axios.post(
      "https://slack.com/api/chat.postMessage",
      { channel: params.channel_id, text: params.text },
      { headers }
    );
    return r.data;
  }
  throw new Error(`Unknown slack action: ${action}`);
}

// ── GitHub ─────────────────────────────────────────────
async function githubAction(cred, action, params) {
  const headers = { Authorization: `Bearer ${cred.access_token}`, Accept: "application/vnd.github+json" };

  if (action === "list_prs") {
    const r = await axios.get(`https://api.github.com/repos/${params.owner}/${params.repo}/pulls`, { headers });
    return r.data;
  }
  if (action === "get_commit") {
    const r = await axios.get(`https://api.github.com/repos/${params.owner}/${params.repo}/commits/${params.sha}`, { headers });
    return r.data;
  }
  if (action === "search_code") {
    const r = await axios.get("https://api.github.com/search/code", { headers, params: { q: params.query } });
    return r.data;
  }
  throw new Error(`Unknown github action: ${action}`);
}

// ── Notion ─────────────────────────────────────────────
async function notionAction(cred, action, params) {
  const headers = { Authorization: `Bearer ${cred.access_token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };

  if (action === "read_page") {
    const r = await axios.get(`https://api.notion.com/v1/pages/${params.page_id}`, { headers });
    return r.data;
  }
  if (action === "search_workspace") {
    const r = await axios.post("https://api.notion.com/v1/search", { query: params.query }, { headers });
    return r.data;
  }
  if (action === "create_page") {
    const r = await axios.post("https://api.notion.com/v1/pages", params.payload, { headers });
    return r.data;
  }
  throw new Error(`Unknown notion action: ${action}`);
}

const HANDLERS = {
  gmail: gmailAction,
  google_calendar: calendarAction,
  slack: slackAction,
  github: githubAction,
  notion: notionAction,
};

// Actions that must never fire without a prior approval step in the agent loop.
export const IRREVERSIBLE_ACTIONS = new Set([
  "send_email",
  "send_message",
  "create_event",
  "update_event",
  "create_page",
]);

export async function runPluginAction({ userId, agentId, taskId, pluginId, action, params }) {
  const handler = HANDLERS[pluginId];
  if (!handler) return { ok: false, error: `No handler wired up for plugin '${pluginId}'` };

  const cred = await getCredential(userId, pluginId);
  if (!cred) {
    return { ok: false, error: `'${pluginId}' isn't connected or its access has expired. Reconnect it on the Plugins page.` };
  }

  try {
    const data = await handler(cred, action, params || {});
    await supabaseAdmin.from("action_log").insert({
      agent_id: agentId, task_id: taskId, action: `${pluginId}.${action}`, params, result: data,
    });
    return { ok: true, data };
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
    await supabaseAdmin.from("action_log").insert({
      agent_id: agentId, task_id: taskId, action: `${pluginId}.${action}`, params, result: { error: errMsg },
    });
    return { ok: false, error: errMsg };
  }
}
