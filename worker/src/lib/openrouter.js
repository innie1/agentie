import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { getModelForRole } from "./modelConfig.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const openRouterStatus = { lastCallOk: null, lastError: null, lastCheckedAt: null };

function authHeaders() {
  return { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" };
}

async function callModel({ model, messages, max_tokens = 1000, temperature = 0.4, userId, agentId, taskId }) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set in the worker's environment variables.");
  if (!model || typeof model !== "string" || !model.trim()) throw new Error("No valid OpenRouter model is configured for this request.");
  try {
    const res = await axios.post(OPENROUTER_URL, { model: model.trim(), messages, max_tokens, temperature }, { headers: authHeaders() });
    const usage = res.data?.usage || {};
    await supabaseAdmin.from("token_usage").insert({ user_id: userId, agent_id: agentId, task_id: taskId, model_id: model.trim(), prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 });
    const content = res.data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("OpenRouter returned an empty response.");
    openRouterStatus.lastCallOk = true; openRouterStatus.lastError = null; openRouterStatus.lastCheckedAt = new Date().toISOString();
    return content;
  } catch (err) {
    openRouterStatus.lastCallOk = false; openRouterStatus.lastCheckedAt = new Date().toISOString();
    const status = err.response?.status;
    openRouterStatus.lastError = status === 401 ? "OpenRouter rejected the API key (401 Unauthorized)." : status === 429 ? "OpenRouter rate limit hit (429)." : status === 404 || err.response?.data?.error?.message?.includes("not a valid model") ? `Model '${model}' isn't available on OpenRouter.` : err.response?.data?.error?.message || err.message;
    throw new Error(openRouterStatus.lastError);
  }
}

export async function classifyIntent({ instruction, userId, agentId, taskId }) {
  const model = await getModelForRole("fast");
  const raw = await callModel({ model, userId, agentId, taskId, max_tokens: 10, temperature: 0, messages: [
    { role: "system", content: "Classify the user's message as exactly one word: CONVERSATION or TASK. CONVERSATION includes greetings, normal questions, advice, brainstorming, opinions, explanations, discussion, feedback, and requests answerable directly in chat. TASK is only an explicit request for the agent to carry out work beyond replying: create, edit, send, schedule, research current sources, manage files, use a connected service, or complete a multi-step deliverable. When uncertain, choose CONVERSATION. Respond with only one word." },
    { role: "user", content: String(instruction || "") },
  ] });
  const normalized = String(raw || "").trim().toUpperCase();
  return normalized === "TASK" ? "TASK" : "CONVERSATION";
}

export async function conversationReply({ instruction, agent, history = [], userId, agentId, taskId }) {
  const model = await getModelForRole("fast");
  const agentName = agent?.name || "an AI agent";
  const role = agent?.role || "helpful assistant";
  return callModel({ model, userId, agentId, taskId, max_tokens: 500, temperature: 0.5, messages: [
    { role: "system", content: `You are ${agentName}, a ${role}. Hold a natural, helpful conversation. Answer the user's question or idea directly with appropriate detail. Use short, natural paragraphs with compact spacing. Do not emit HTML or inline styles, and avoid document-like formatting for ordinary conversation. When the user mentions a meaningful goal, recurring responsibility, or desired improvement, recognize it and offer up to three useful next choices, such as creating a one-time task, drafting a plan, or setting up a routine/reminder. Never create a task, plan, routine, reminder, calendar event, or external action until the user clearly chooses it. For health, fitness, nutrition, or mental-health goals, be supportive and practical but do not diagnose, prescribe, promise outcomes, or replace a qualified professional. Do not pretend to have performed external work.` },
    ...(Array.isArray(history) ? history.slice(-8).map((m) => ({ role: m.role, content: String(m.content || "") })) : []),
    { role: "user", content: String(instruction || "") },
  ] });
}

export async function fastReply({ instruction, agentName, userId, agentId, taskId }) {
  const model = await getModelForRole("fast");
  return callModel({ model, userId, agentId, taskId, max_tokens: 60, messages: [
    { role: "system", content: `You are ${agentName || "an AI agent"}, a brief, friendly AI agent. Reply naturally in one short sentence.` },
    { role: "user", content: String(instruction || "") },
  ] });
}

export async function reasoningCall({ systemPrompt, conversation, userId, agentId, taskId }) {
  const model = await getModelForRole("reasoning");
  return callModel({ model, userId, agentId, taskId, max_tokens: 1200, temperature: 0.3, messages: [{ role: "system", content: String(systemPrompt || "") }, ...(Array.isArray(conversation) ? conversation.map(m => ({ role: m.role, content: String(m.content || "") })) : [])] });
}

export async function memoryExtractionCall({ transcript, userId, agentId, taskId }) {
  const model = await getModelForRole("fast");
  return callModel({ model, userId, agentId, taskId, max_tokens: 450, temperature: 0, messages: [
    { role: "system", content: "Extract durable user-stated memories as a JSON array only. Each item needs key, value, kind (preference|goal|constraint|profile), and confidence from 0 to 1. Do not infer. Exclude credentials and sensitive health, financial, political, religious, precise-location, or identity facts unless the user explicitly asks to remember that exact fact. Return [] when nothing is useful. Maximum 5 items." },
    { role: "user", content: String(transcript || "").slice(0, 8000) },
  ] });
}
