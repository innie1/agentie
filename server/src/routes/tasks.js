import express from "express";
import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { fastChat } from "../lib/fastChat.js";
import { recordActivity } from "../lib/activity.js";
import { footballFixtureCard, footballTeamsFrom, liveWeatherCard, weatherLocationFrom } from "../lib/liveCards.js";
import { appendMessage, getOrCreateConversation, recentConversationMessages } from "../services/conversationService.js";
import { classifyMessageIntent } from "../services/intentService.js";
import { actionHash, decideApproval } from "../services/approvalService.js";
import { captureConversationMemory } from "../services/memoryService.js";

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const chatAgentCache = new Map();

const CAPABILITY_GROUPS = [
  { words: ["email", "inbox", "gmail", "mail", "message", "reply", "newsletter", "unsubscribe"], keys: ["email", "mail", "gmail", "communication", "communications"] },
  { words: ["whatsapp", "customer", "customers", "support", "chat", "client"], keys: ["whatsapp", "customer", "support", "communications"] },
  { words: ["calendar", "meeting", "schedule", "appointment", "event", "reminder"], keys: ["calendar", "scheduling", "assistant"] },
  { words: ["code", "coding", "bug", "debug", "program", "github", "repository", "repo", "developer"], keys: ["coding", "code", "developer", "github", "software"] },
  { words: ["research", "researcher", "competitor", "market", "find", "investigate", "analyze"], keys: ["research", "analysis", "market", "researcher"] },
  { words: ["finance", "financial", "money", "budget", "accounting", "invoice", "expense"], keys: ["finance", "financial", "accounting", "money"] },
  { words: ["marketing", "advert", "advertising", "campaign", "social", "content", "seo"], keys: ["marketing", "advertising", "content", "seo"] },
  { words: ["file", "document", "pdf", "spreadsheet", "docx", "excel", "report"], keys: ["documents", "files", "document", "reporting"] },
];

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function agentProfileText(agent) {
  return normalize([
    agent.name,
    agent.role,
    agent.goal,
    agent.character?.description,
    agent.character?.personality,
    ...(Array.isArray(agent.tags) ? agent.tags : []),
    ...(Array.isArray(agent.allowed_plugins) ? agent.allowed_plugins : []),
  ].filter(Boolean).join(" "));
}

function scoreAgent(agent, instruction, currentAgentId) {
  if (!agent || agent.id === currentAgentId) return 0;
  const text = normalize(instruction);
  const profile = agentProfileText(agent);
  let score = 0;
  for (const group of CAPABILITY_GROUPS) {
    const taskHit = group.words.some(word => text.includes(word));
    if (!taskHit) continue;
    if (group.keys.some(key => profile.includes(normalize(key)))) score += 8;
  }
  const taskWords = [...new Set(text.split(" ").filter(w => w.length >= 4))];
  for (const word of taskWords) {
    if (profile.includes(word)) score += 1;
  }
  if (agent.status && ["active", "working", "online"].includes(String(agent.status).toLowerCase())) score += 0.5;
  return score;
}

async function findBestHandoffAgent({ userId, currentAgentId, instruction, allowedHandoffAgents = [] }) {
  const { data: agents, error } = await supabaseAdmin.from("agents")
    .select("id,name,role,goal,character,tags,allowed_plugins,status,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const explicit = new Set(Array.isArray(allowedHandoffAgents) ? allowedHandoffAgents : []);
  const ranked = (agents || [])
    .filter(agent => explicit.size === 0 || explicit.has(agent.id))
    .map(agent => ({ agent, score: scoreAgent(agent, instruction, currentAgentId) }))
    .filter(item => item.score >= 5)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.agent || null;
}

async function createHandoff({ userId, fromAgent, toAgent, instruction, history = [] }) {
  if (!toAgent || toAgent.id === fromAgent.id) return null;
  const { data: task, error: taskError } = await supabaseAdmin.from("tasks").insert({
    user_id: userId,
    agent_id: toAgent.id,
    instruction,
    status: "pending",
    source: "handoff",
    context: { conversation: history, handoff: { from_agent_id: fromAgent.id, from_agent_name: fromAgent.name, to_agent_id: toAgent.id, to_agent_name: toAgent.name } },
    result_payload: { handoff: true, delegated_by: fromAgent.id, delegated_by_name: fromAgent.name, receiving_agent: toAgent.name },
  }).select().single();
  if (taskError) throw new Error(taskError.message);

  await supabaseAdmin.from("task_handoffs").insert({
    from_agent_id: fromAgent.id, to_agent_id: toAgent.id, task_id: task.id,
    note: instruction, context_summary: instruction,
  });

  try {
    const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
    await axios.post(`${workerUrl}/enqueue`, { taskId: task.id });
  } catch (err) {
    console.error("[tasks] handoff worker enqueue failed:", err.message);
  }
  return task;
}

async function resolveChatAgent({ agentId, userId, instruction }) {
  if (UUID_RE.test(String(agentId || ""))) {
    const cacheKey = `${userId}:${agentId}`;
    const cachedAgent = chatAgentCache.get(cacheKey);
    if (cachedAgent && cachedAgent.expires > Date.now()) return cachedAgent.agent;
    const { data: agent, error } = await supabaseAdmin.from("agents")
      .select("id, name, system_prompt, role, goal, character, tags, allowed_plugins, allowed_handoff_agents, status")
      .eq("id", agentId).eq("user_id", userId).single();
    if (error || !agent) throw new Error(error?.message || "Agent not found");
    chatAgentCache.set(cacheKey, { agent, expires: Date.now() + 30_000 });
    return agent;
  }
  const { data: newest, error: newestError } = await supabaseAdmin.from("agents")
    .select("id, name, system_prompt, role, goal, character, tags, allowed_plugins, allowed_handoff_agents, status, created_at")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (newestError) throw new Error(newestError.message);
  if (newest) return newest;
  const goal = String(instruction || "").trim();
  const { data: created, error: createError } = await supabaseAdmin.from("agents").insert({
    user_id: userId, name: "Agentie Assistant", role: "General Assistant", goal,
    system_prompt: `You are a helpful Agentie assistant. Your current focus is: ${goal}`,
    character: {}, tags: ["Task Management"], allowed_plugins: []
  }).select("id, name, system_prompt, role, goal, character, tags, allowed_plugins, allowed_handoff_agents, status").single();
  if (createError) throw new Error(createError.message);
  return created;
}

router.get("/", async (req, res) => {
  let q = supabaseAdmin.from("tasks").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false });
  if (req.query.agent_id && UUID_RE.test(String(req.query.agent_id))) q = q.eq("agent_id", req.query.agent_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: data });
});

router.post("/", async (req, res) => {
  const userId = req.user.id;
  const { agent_id, instruction, conversation_id, history: suppliedHistory = [] } = req.body;
  if (!agent_id || !instruction) return res.status(400).json({ error: "agent_id and instruction are required" });

  let chatAgent;
  let conversation = null;
  try {
    chatAgent = await resolveChatAgent({ agentId: agent_id, userId, instruction });
    conversation = await getOrCreateConversation({ userId, agentId: chatAgent.id, conversationId: conversation_id, title: chatAgent.name });
    await appendMessage({ userId, conversationId: conversation?.id, agentId: chatAgent.id, senderType: "user", content: instruction });
  } catch (error) {
    return res.status(400).json({ error: "Unable to open this agent conversation", detail: error.message });
  }

  const intent = classifyMessageIntent(instruction);
  const storedHistory = await recentConversationMessages(conversation?.id, 14);
  const history = storedHistory.length > 1
    ? storedHistory.slice(0, -1)
    : (Array.isArray(suppliedHistory) ? suppliedHistory.filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string").slice(-12) : []);

  const normalizedInstruction = String(instruction).toLowerCase().trim();
  const timeWords = ["what time is it", "what is the time", "current time", "time now", "what's the time", "whats the time", "what s the time", "tell me time", "tell me the time", "show me the time", "give me the time", "what is the date", "today's date", "what day is it", "live time"];
  const isTimeRequest = ["time", "the time", "date", "the date", "clock"].includes(normalizedInstruction.replace(/[?.!]$/, "")) || timeWords.some(word => normalizedInstruction.includes(word));
  const isWeatherRequest = ["weather", "forecast", "temperature", "is it raining", "how hot", "rain today"].some(word => normalizedInstruction.includes(word));
  const fixtureTeams = footballTeamsFrom(instruction);
  const isFixtureRequest = !!fixtureTeams && ["game", "match", "play", "playing", "fixture", "kickoff", "kick off", "vs", "versus", "against"].some(word => normalizedInstruction.includes(word));
  if (isTimeRequest || isWeatherRequest || isFixtureRequest) {
    try {
      const agent = chatAgent;
      let card;
      if (isTimeRequest) {
        card = { result_type: "live_time_card", result_payload: { title: "Live Local Time", timezone: "browser-local", iso: new Date().toISOString() }, text: "Here is the live time." };
      } else if (isWeatherRequest) {
        card = await liveWeatherCard(weatherLocationFrom(instruction));
      } else {
        card = await footballFixtureCard(fixtureTeams, normalizedInstruction.includes("today") || normalizedInstruction.includes("tonight"));
      }
      await appendMessage({ userId, conversationId: conversation?.id, agentId: agent.id, senderType: "agent", content: card.text, contentJson: { result_type: card.result_type, result_payload: card.result_payload } });
      return res.status(200).json({ chat: { id: `chat_${Date.now()}`, conversation_id: conversation?.id || null, agent_id: agent.id, agent, instruction, result: card.text, result_type: card.result_type, result_payload: card.result_payload, status: "done" }, fast: true, live: true, intent });
    } catch (err) {
      console.warn("[tasks] live card lookup failed; falling back to fast chat:", err.message);
    }
  }

  if (intent.type !== "confirmed_task") {
    try {
      const agent = chatAgent;
      const guidance = intent.type === "suggested_action"
        ? `The user expressed a goal but did not authorize execution. Acknowledge it briefly, then offer these editable choices without claiming to create anything: ${(intent.suggestions || []).join(", ")}. Ask the user to choose or type a different preference.`
        : "";
      const { text, model } = await fastChat({ agent, message: instruction, history, guidance });
      await appendMessage({ userId, conversationId: conversation?.id, agentId: agent.id, senderType: "agent", content: text, contentJson: { mode: "chat", model, intent } });
      captureConversationMemory({ agentId: agent.id, userText: instruction, assistantText: text })
        .catch(error => console.warn("[tasks] conversation memory capture skipped:", error.message));
      return res.status(200).json({ chat: { id: `chat_${Date.now()}`, conversation_id: conversation?.id || null, agent_id: agent.id, agent, instruction, result: text, result_type: "fact", result_payload: { mode: "chat", model, intent, suggestions: intent.suggestions || [] }, status: "done" }, fast: true, intent });
    } catch (err) {
      console.error("[tasks] fast chat failed:", err.message);
      return res.status(502).json({ error: "Fast chat failed", detail: err.message });
    }
  }

  const realAgent = chatAgent;

  const { data: previousTasks, error: historyError } = await supabaseAdmin.from("tasks")
    .select("instruction, result, result_type, result_payload, status, created_at")
    .eq("user_id", userId).eq("agent_id", realAgent.id).order("created_at", { ascending: false }).limit(12);
  if (historyError) console.warn("[tasks] task history load failed:", historyError.message);

  const taskHistory = history.length ? history : (previousTasks || []).reverse().flatMap(t => {
    const messages = [];
    if (t.instruction) messages.push({ role: "user", content: t.instruction });
    const assistantText = t.result || t.result_payload?.text || t.result_payload?.summary;
    if (assistantText) messages.push({ role: "assistant", content: String(assistantText).slice(0, 4000) });
    return messages;
  }).slice(-12);

  try {
    const fullAgent = await resolveChatAgent({ agentId: realAgent.id, userId, instruction });
    const receivingAgent = await findBestHandoffAgent({
      userId,
      currentAgentId: fullAgent.id,
      instruction,
      allowedHandoffAgents: fullAgent.allowed_handoff_agents,
    });
    if (receivingAgent) {
      const task = await createHandoff({ userId, fromAgent: fullAgent, toAgent: receivingAgent, instruction, history: taskHistory });
      if (conversation?.id) await supabaseAdmin.from("tasks").update({ conversation_id: conversation.id }).eq("id", task.id);
      return res.status(201).json({ task, handoff: { task_id: task.id, from_agent: fullAgent, to_agent: receivingAgent, status: "working" } });
    }
  } catch (err) {
    console.warn("[tasks] automatic routing skipped:", err.message);
  }

  const { data: task, error } = await supabaseAdmin.from("tasks").insert({
    user_id: userId, agent_id: realAgent.id, instruction, status: "pending", source: "user",
    conversation_id: conversation?.id || null, context: { conversation: taskHistory, intent }
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  try {
    const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
    await axios.post(`${workerUrl}/enqueue`, { taskId: task.id });
  } catch (err) {
    console.error("[tasks] failed to notify worker:", err.message);
  }
  res.status(201).json({ task, conversation_id: conversation?.id || null, intent });
});

router.get("/approvals", async (req, res) => {
  let query = supabaseAdmin.from("approvals").select("*, tasks!inner(agent_id,instruction)")
    .eq("user_id", String(req.user.id)).order("created_at", { ascending: false }).limit(100);
  if (req.query.status) query = query.eq("status", req.query.status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ approvals: data || [] });
});

router.post("/:id/approve", async (req, res) => {
  const { data: waitingTask, error: readError } = await supabaseAdmin.from("tasks")
    .select("*").eq("id", req.params.id).eq("user_id", req.user.id).eq("status", "needs_approval").single();
  if (readError || !waitingTask) return res.status(400).json({ error: readError?.message || "Task not awaiting approval" });
  if (waitingTask.result_type === "missing_info") return res.status(400).json({ error: "This task is waiting for information, not approval." });
  const pending = waitingTask.result_payload || {};
  if (!pending.plugin_id || !pending.action || !pending.params) return res.status(400).json({ error: "The pending action is incomplete and cannot be approved." });
  let approvedAction = req.body?.edited_action || { plugin_id: pending.plugin_id, action: pending.action, params: pending.params, description: pending.description || null };
  let approvedHash = actionHash(approvedAction);
  if (pending.approval_id) {
    const { data: approval } = await supabaseAdmin.from("approvals").select("*").eq("id", pending.approval_id).eq("user_id", String(req.user.id)).maybeSingle();
    if (!approval) return res.status(400).json({ error: "Approval record not found" });
    try {
      const decided = await decideApproval({ approval, userId: req.user.id, decision: "approved", editedAction: req.body?.edited_action || null, reason: req.body?.reason || null });
      approvedAction = decided.action;
      approvedHash = decided.hash;
    } catch (error) { return res.status(400).json({ error: error.message }); }
  }
  const result_payload = {
    ...pending,
    paused_state: {
      ...(pending.paused_state || {}),
      approved_action: approvedAction,
      approved_action_hash: approvedHash,
    },
  };
  const { data: task, error } = await supabaseAdmin.from("tasks")
    .update({ status: "pending", result_payload, updated_at: new Date().toISOString() })
    .eq("id", waitingTask.id).select().single();
  if (error || !task) return res.status(400).json({ error: error?.message || "Task not awaiting approval" });
  await recordActivity({ agentId: task.agent_id, taskId: task.id, type: "approval_granted", summary: "User approved the requested action", severity: "warning" });
  try {
    const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
    await axios.post(`${workerUrl}/enqueue`, { taskId: task.id, resume: true });
  } catch (err) { console.error("[tasks] failed to notify worker on resume:", err.message); }
  res.json({ task });
});

router.post("/:id/reject", async (req, res) => {
  const { data: waitingTask } = await supabaseAdmin.from("tasks").select("*").eq("id", req.params.id).eq("user_id", req.user.id).eq("status", "needs_approval").maybeSingle();
  if (!waitingTask) return res.status(400).json({ error: "Task is not awaiting approval" });
  const pending = waitingTask.result_payload || {};
  if (pending.approval_id) {
    const { data: approval } = await supabaseAdmin.from("approvals").select("*").eq("id", pending.approval_id).eq("user_id", String(req.user.id)).maybeSingle();
    if (approval) {
      try { await decideApproval({ approval, userId: req.user.id, decision: "denied", reason: req.body?.reason || "User declined" }); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }
  }
  const resultPayload = { ...pending, paused_state: { ...(pending.paused_state || {}), denied_action: { plugin_id: pending.plugin_id, action: pending.action }, denial_reason: req.body?.reason || "User declined" } };
  const { data: task, error } = await supabaseAdmin.from("tasks").update({ status: "pending", result_payload: resultPayload, updated_at: new Date().toISOString() }).eq("id", waitingTask.id).select().single();
  if (error || !task) return res.status(400).json({ error: error?.message || "Task could not be resumed" });
  if (task) await recordActivity({ agentId: task.agent_id, taskId: task.id, type: "approval_rejected", summary: "User rejected the requested action", severity: "warning" });
  try { await axios.post(`${process.env.WORKER_URL || "https://agentie-production.up.railway.app"}/enqueue`, { taskId: task.id, resume: true }); }
  catch (error) { console.error("[tasks] failed to notify worker after rejection:", error.message); }
  res.json({ task });
});

// Resume a task that deliberately asked for a material missing detail.
router.post("/:id/respond", async (req, res) => {
  const answer = String(req.body?.answer || "").trim();
  if (!answer) return res.status(400).json({ error: "answer is required" });
  const { data: waitingTask, error: readError } = await supabaseAdmin.from("tasks")
    .select("*").eq("id", req.params.id).eq("user_id", req.user.id).eq("status", "needs_approval").eq("result_type", "missing_info").single();
  if (readError || !waitingTask) return res.status(400).json({ error: readError?.message || "Task is not waiting for information" });
  const paused = waitingTask.result_payload?.paused_state || {};
  const conversation = Array.isArray(paused.conversation) ? paused.conversation : [];
  const result_payload = { ...(waitingTask.result_payload || {}), paused_state: { ...paused, conversation: [...conversation, { role: "user", content: `[User answer]: ${answer}` }] } };
  const { data: task, error } = await supabaseAdmin.from("tasks").update({ status: "pending", result_payload, updated_at: new Date().toISOString() }).eq("id", waitingTask.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await recordActivity({ agentId: task.agent_id, taskId: task.id, type: "input_received", summary: "User supplied requested information" });
  try {
    const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
    await axios.post(`${workerUrl}/enqueue`, { taskId: task.id, resume: true });
  } catch (err) { console.error("[tasks] failed to notify worker on response:", err.message); }
  res.json({ task });
});

router.post("/:id/cancel", async (req, res) => {
  const { data: task, error } = await supabaseAdmin.from("tasks")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", req.params.id).eq("user_id", req.user.id)
    .in("status", ["pending", "in_progress", "needs_approval"])
    .select().single();
  if (error || !task) return res.status(400).json({ error: error?.message || "Task cannot be cancelled" });
  await Promise.all([
    supabaseAdmin.from("tasks").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("parent_task_id", task.id).in("status", ["pending", "queued", "in_progress", "needs_approval", "waiting_input"]),
    supabaseAdmin.from("approvals").update({ status: "cancelled", decided_at: new Date().toISOString() }).eq("task_id", task.id).eq("status", "pending"),
  ]);
  await recordActivity({ agentId: task.agent_id, taskId: task.id, type: "task_cancelled", summary: "User cancelled the task", severity: "warning" });
  res.json({ task });
});

export default router;
