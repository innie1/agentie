import express from "express";
import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { fastChat, isFastChatMessage } from "../lib/fastChat.js";

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function findBestHandoffAgent({ userId, currentAgentId, instruction }) {
  const { data: agents, error } = await supabaseAdmin.from("agents")
    .select("id,name,role,goal,character,tags,allowed_plugins,status,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const ranked = (agents || [])
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
    const { data: agent, error } = await supabaseAdmin.from("agents")
      .select("id, name, system_prompt, role, goal, character, tags, allowed_plugins, status")
      .eq("id", agentId).eq("user_id", userId).single();
    if (error || !agent) throw new Error(error?.message || "Agent not found");
    return agent;
  }
  const { data: newest, error: newestError } = await supabaseAdmin.from("agents")
    .select("id, name, system_prompt, role, goal, character, tags, allowed_plugins, status, created_at")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (newestError) throw new Error(newestError.message);
  if (newest) return newest;
  const goal = String(instruction || "").trim();
  const { data: created, error: createError } = await supabaseAdmin.from("agents").insert({
    user_id: userId, name: "Agentie Assistant", role: "General Assistant", goal,
    system_prompt: `You are a helpful Agentie assistant. Your current focus is: ${goal}`,
    character: {}, tags: ["General Assistant", "Assistant"], allowed_plugins: []
  }).select("id, name, system_prompt, role, goal, character, tags, allowed_plugins, status").single();
  if (createError) throw new Error(createError.message);
  return created;
}

async function resolveTaskAgent({ agentId, userId }) {
  if (UUID_RE.test(String(agentId || ""))) {
    const { data: agent, error } = await supabaseAdmin.from("agents")
      .select("id, name").eq("id", agentId).eq("user_id", userId).single();
    if (error || !agent) throw new Error("Saved agent not found");
    return agent;
  }
  const { data: newest, error } = await supabaseAdmin.from("agents")
    .select("id, name, created_at").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!newest) throw new Error("No saved agent exists for this user");
  return newest;
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
  const { agent_id, instruction, history: suppliedHistory = [] } = req.body;
  if (!agent_id || !instruction) return res.status(400).json({ error: "agent_id and instruction are required" });

  if (isFastChatMessage(instruction)) {
    try {
      const agent = await resolveChatAgent({ agentId: agent_id, userId, instruction });
      const history = Array.isArray(suppliedHistory)
        ? suppliedHistory.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-12)
        : [];

      const receivingAgent = await findBestHandoffAgent({ userId, currentAgentId: agent.id, instruction });
      if (receivingAgent) {
        const task = await createHandoff({ userId, fromAgent: agent, toAgent: receivingAgent, instruction, history });
        return res.status(200).json({
          chat: {
            id: `chat_${Date.now()}`,
            agent_id: agent.id,
            agent,
            instruction,
            result: `${agent.name} handed this to ${receivingAgent.name}, who is now working on it.`,
            result_type: "handoff",
            result_payload: { mode: "handoff", handoff: true, from_agent: agent, to_agent: receivingAgent, task_id: task.id, status: "working" },
            status: "working",
          },
          handoff: { task_id: task.id, from_agent: agent, to_agent: receivingAgent, status: "working" },
          fast: true,
        });
      }

      const { text, model } = await fastChat({ agent, message: instruction, history });
      return res.status(200).json({ chat: { id: `chat_${Date.now()}`, agent_id: agent.id, agent, instruction, result: text, result_type: "fact", result_payload: { mode: "chat", model }, status: "done" }, fast: true });
    } catch (err) {
      console.error("[tasks] fast chat failed:", err.message);
      return res.status(502).json({ error: "Fast chat failed", detail: err.message });
    }
  }

  let realAgent;
  try {
    realAgent = await resolveTaskAgent({ agentId: agent_id, userId });
  } catch (err) {
    return res.status(400).json({ error: "Invalid agent_id", detail: err.message });
  }

  const { data: previousTasks, error: historyError } = await supabaseAdmin.from("tasks")
    .select("instruction, result, result_type, result_payload, status, created_at")
    .eq("user_id", userId).eq("agent_id", realAgent.id).order("created_at", { ascending: false }).limit(12);
  if (historyError) console.warn("[tasks] task history load failed:", historyError.message);

  const history = (previousTasks || []).reverse().flatMap(t => {
    const messages = [];
    if (t.instruction) messages.push({ role: "user", content: t.instruction });
    const assistantText = t.result || t.result_payload?.text || t.result_payload?.summary;
    if (assistantText) messages.push({ role: "assistant", content: String(assistantText).slice(0, 4000) });
    return messages;
  }).slice(-12);

  try {
    const fullAgent = await resolveChatAgent({ agentId: realAgent.id, userId, instruction });
    const receivingAgent = await findBestHandoffAgent({ userId, currentAgentId: fullAgent.id, instruction });
    if (receivingAgent) {
      const task = await createHandoff({ userId, fromAgent: fullAgent, toAgent: receivingAgent, instruction, history });
      return res.status(201).json({ task, handoff: { task_id: task.id, from_agent: fullAgent, to_agent: receivingAgent, status: "working" } });
    }
  } catch (err) {
    console.warn("[tasks] automatic routing skipped:", err.message);
  }

  const { data: task, error } = await supabaseAdmin.from("tasks").insert({
    user_id: userId, agent_id: realAgent.id, instruction, status: "pending", context: { conversation: history }
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  try {
    const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
    await axios.post(`${workerUrl}/enqueue`, { taskId: task.id });
  } catch (err) {
    console.error("[tasks] failed to notify worker:", err.message);
  }
  res.status(201).json({ task });
});

router.post("/:id/approve", async (req, res) => {
  const { data: task, error } = await supabaseAdmin.from("tasks")
    .update({ status: "pending", updated_at: new Date().toISOString() })
    .eq("id", req.params.id).eq("user_id", req.user.id).eq("status", "needs_approval").select().single();
  if (error || !task) return res.status(400).json({ error: error?.message || "Task not awaiting approval" });
  try {
    const workerUrl = process.env.WORKER_URL || "https://agentie-production.up.railway.app";
    await axios.post(`${workerUrl}/enqueue`, { taskId: task.id, resume: true });
  } catch (err) { console.error("[tasks] failed to notify worker on resume:", err.message); }
  res.json({ task });
});

router.post("/:id/reject", async (req, res) => {
  const { data: task, error } = await supabaseAdmin.from("tasks")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("id", req.params.id).eq("user_id", req.user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ task });
});

export default router;