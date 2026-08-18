// ============================================================================
// AGENTIE CONNECTOR REGISTRY
// Real provider execution. No simulated "success" responses.
// ============================================================================
import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { decrypt } from "../lib/crypto.js";

export const CONNECTORS = {
  gmail: { id: "gmail", name: "Gmail", actions: {
    searchEmails: { name: "searchEmails", irreversible: false, description: "Search emails" },
    readThread: { name: "readThread", irreversible: false, description: "Read an email thread" },
    draftEmail: { name: "draftEmail", irreversible: false, description: "Create an email draft" },
    sendEmail: { name: "sendEmail", irreversible: true, description: "Send an email" }
  }},
  gcal: { id: "gcal", name: "Google Calendar", actions: {
    checkAvailability: { name: "checkAvailability", irreversible: false, description: "Check calendar events" },
    createMeeting: { name: "createMeeting", irreversible: true, description: "Create a calendar event" }
  }},
  slack: { id: "slack", name: "Slack", actions: {
    readChannel: { name: "readChannel", irreversible: false, description: "Read channel history" },
    sendMessage: { name: "sendMessage", irreversible: true, description: "Send a Slack message" }
  }},
  github: { id: "github", name: "GitHub", actions: {
    searchRepos: { name: "searchRepos", irreversible: false, description: "Search repositories" },
    readIssue: { name: "readIssue", irreversible: false, description: "Read an issue or pull request" },
    createIssue: { name: "createIssue", irreversible: false, description: "Create an issue" },
    mergePullRequest: { name: "mergePullRequest", irreversible: true, description: "Merge a pull request" }
  }},
  notion: { id: "notion", name: "Notion", actions: {
    searchPages: { name: "searchPages", irreversible: false, description: "Search Notion" },
    readDoc: { name: "readDoc", irreversible: false, description: "Read a Notion page" },
    createPage: { name: "createPage", irreversible: false, description: "Create a Notion page" },
    deletePage: { name: "deletePage", irreversible: true, description: "Delete a Notion page" }
  }}
};

async function tokenFor(userId, connectorId) {
  if (!userId) throw new Error("userId is required for connector execution");
  const { data, error } = await supabaseAdmin.from("user_plugins")
    .select("access_token, refresh_token, expires_at, status")
    .eq("user_id", userId).eq("plugin_id", connectorId).maybeSingle();
  if (error) throw new Error(`Unable to load ${connectorId} connection: ${error.message}`);
  if (!data || data.status !== "active") throw new Error(`${connectorId} is not connected for this user`);
  if (!data.access_token) throw new Error(`${connectorId} has no access token`);
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    throw new Error(`${connectorId} access token has expired; reconnect the plugin`);
  }
  return decrypt(data.access_token);
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

function gmailRaw({ to, subject, body }) {
  const mime = [`To: ${to}`, `Subject: ${subject || ""}`, "Content-Type: text/plain; charset=utf-8", "", body || ""].join("\\r\\n");
  return Buffer.from(mime).toString("base64url");
}

async function gmail(action, p, token) {
  const headers = auth(token);
  if (action === "searchEmails") {
    const r = await axios.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", { headers, params: { q: p.query || "", maxResults: p.maxResults || 20 } });
    const ids = r.data.messages || [];
    const messages = await Promise.all(ids.slice(0, 20).map(async ({ id }) => {
      const m = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { headers, params: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] } });
      return m.data;
    }));
    return { messages, resultSizeEstimate: r.data.resultSizeEstimate || 0 };
  }
  if (action === "readThread") {
    const r = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(p.threadId)}`, { headers, params: { format: "full" } });
    return r.data;
  }
  if (action === "draftEmail") {
    const r = await axios.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw: gmailRaw(p) } }, { headers: { ...headers, "Content-Type": "application/json" } });
    return r.data;
  }
  if (action === "sendEmail") {
    const r = await axios.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw: gmailRaw(p) }, { headers: { ...headers, "Content-Type": "application/json" } });
    return r.data;
  }
}

async function gcal(action, p, token) {
  const headers = auth(token);
  if (action === "checkAvailability") {
    const r = await axios.get("https://www.googleapis.com/calendar/v3/calendars/primary/events", { headers, params: { timeMin: p.timeMin, timeMax: p.timeMax, singleEvents: true, orderBy: "startTime", maxResults: p.maxResults || 100 } });
    return { events: r.data.items || [] };
  }
  if (action === "createMeeting") {
    const r = await axios.post("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      summary: p.summary, description: p.description, start: p.start, end: p.end,
      attendees: (p.attendees || []).map(email => typeof email === "string" ? { email } : email),
      conferenceData: p.addConference ? { createRequest: { requestId: `agentie-${Date.now()}` } } : undefined
    }, { headers: { ...headers, "Content-Type": "application/json" }, params: p.addConference ? { conferenceDataVersion: 1 } : undefined });
    return r.data;
  }
}

async function slack(action, p, token) {
  const headers = { ...auth(token), "Content-Type": "application/json; charset=utf-8" };
  if (action === "readChannel") {
    const r = await axios.get("https://slack.com/api/conversations.history", { headers, params: { channel: p.channelId, limit: p.limit || 50, cursor: p.cursor } });
    if (!r.data.ok) throw new Error(r.data.error || "Slack history request failed");
    return r.data;
  }
  if (action === "sendMessage") {
    const r = await axios.post("https://slack.com/api/chat.postMessage", { channel: p.channelId, text: p.text, thread_ts: p.threadTs }, { headers });
    if (!r.data.ok) throw new Error(r.data.error || "Slack send failed");
    return r.data;
  }
}

async function github(action, p, token) {
  const headers = { ...auth(token), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (action === "searchRepos") return (await axios.get("https://api.github.com/search/repositories", { headers, params: { q: p.query, per_page: p.perPage || 20 } })).data;
  if (action === "readIssue") return (await axios.get(`https://api.github.com/repos/${p.owner}/${p.repo}/issues/${p.issueNumber}`, { headers })).data;
  if (action === "createIssue") return (await axios.post(`https://api.github.com/repos/${p.owner}/${p.repo}/issues`, { title: p.title, body: p.body, labels: p.labels }, { headers })).data;
  if (action === "mergePullRequest") return (await axios.put(`https://api.github.com/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}/merge`, { commit_title: p.commitTitle, commit_message: p.commitMessage, merge_method: p.mergeMethod || "merge" }, { headers })).data;
}

async function notion(action, p, token) {
  const headers = { ...auth(token), "Content-Type": "application/json", "Notion-Version": "2022-06-28" };
  if (action === "searchPages") return (await axios.post("https://api.notion.com/v1/search", { query: p.query || "", page_size: p.pageSize || 20 }, { headers })).data;
  if (action === "readDoc") return (await axios.get(`https://api.notion.com/v1/pages/${p.pageId}`, { headers })).data;
  if (action === "createPage") return (await axios.post("https://api.notion.com/v1/pages", { parent: p.parent, properties: p.properties, children: p.children }, { headers })).data;
  if (action === "deletePage") return (await axios.patch(`https://api.notion.com/v1/pages/${p.pageId}`, { archived: true }, { headers })).data;
}

export async function runAction(connectorId, actionName, params = {}, context = {}) {
  const connector = CONNECTORS[connectorId];
  if (!connector) throw new Error(`Connector '${connectorId}' not found in registry.`);
  const action = connector.actions[actionName];
  if (!action) throw new Error(`Action '${actionName}' not supported by connector '${connectorId}'.`);
  if (!context.userId) throw new Error("Connector action requires an authenticated user");

  const token = await tokenFor(context.userId, connectorId);
  let data;
  switch (connectorId) {
    case "gmail": data = await gmail(actionName, params, token); break;
    case "gcal": data = await gcal(actionName, params, token); break;
    case "slack": data = await slack(actionName, params, token); break;
    case "github": data = await github(actionName, params, token); break;
    case "notion": data = await notion(actionName, params, token); break;
    default: throw new Error(`Real execution is not wired for '${connectorId}' yet`);
  }
  return { success: true, connector: connectorId, action: actionName, executedAt: new Date().toISOString(), data };
}
