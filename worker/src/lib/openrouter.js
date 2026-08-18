import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { getModelForRole } from "./modelConfig.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Tracks the outcome of the most recent call so /health can report real status
// without making an extra API call on every health check.
export const openRouterStatus = { lastCallOk: null, lastError: null, lastCheckedAt: null };

function authHeaders() {
  return { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" };
}

async function callModel({ model, messages, max_tokens = 1000, temperature = 0.4, userId, agentId, taskId }) {
  if (!process.env.OPENROUTER_API_KEY) {
    openRouterStatus.lastCallOk = false;
    openRouterStatus.lastError = "OPENROUTER_API_KEY is not set in the worker's environment.";
    openRouterStatus.lastCheckedAt = new Date().toISOString();
    throw new Error(openRouterStatus.lastError);
  }

  try {
    const res = await axios.post(OPENROUTER_URL, { model, messages, max_tokens, temperature }, { headers: authHeaders() });
    const usage = res.data.usage || {};

    await supabaseAdmin.from("token_usage").insert({
      user_id: userId,
      agent_id: agentId,
      task_id: taskId,
      model_id: model,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    });

    openRouterStatus.lastCallOk = true;
    openRouterStatus.lastError = null;
    openRouterStatus.lastCheckedAt = new Date().toISOString();

    return res.data.choices[0].message.content;
  } catch (err) {
    openRouterStatus.lastCallOk = false;
    openRouterStatus.lastCheckedAt = new Date().toISOString();

    const status = err.response?.status;
    if (status === 401) {
      openRouterStatus.lastError = "OpenRouter rejected the API key (401 Unauthorized). Check OPENROUTER_API_KEY in the worker's environment variables.";
    } else if (status === 429) {
      openRouterStatus.lastError = "OpenRouter rate limit hit (429). Too many requests, or the free-tier daily cap was reached.";
    } else if (status === 404 || err.response?.data?.error?.message?.includes("not a valid model")) {
      openRouterStatus.lastError = `Model '${model}' isn't available on OpenRouter (404). It may have been renamed or deprecated — trigger a catalog refresh.`;
    } else {
      openRouterStatus.lastError = err.response?.data?.error?.message || err.message;
    }

    throw new Error(openRouterStatus.lastError);
  }
}

export async function classifyIntent({ instruction, userId, agentId, taskId }) {
  const model = await getModelForRole("fast");
  const raw = await callModel({
    model, userId, agentId, taskId, max_tokens: 10, temperature: 0,
    messages: [
      { role: "system", content: "Classify the user's message as exactly one word: SIMPLE (greeting, thanks, small talk, one-word ack) or TASK (anything requiring actual work, a tool call, or a real answer). Respond with only that one word." },
      { role: "user", content: instruction },
    ],
  });
  return raw.trim().toUpperCase().includes("SIMPLE") ? "SIMPLE" : "TASK";
}

export async function fastReply({ instruction, agentName, userId, agentId, taskId }) {
  const model = await getModelForRole("fast");
  return callModel({
    model, userId, agentId, taskId, max_tokens: 60,
    messages: [
      { role: "system", content: `You are ${agentName}, a brief, friendly AI agent. Reply naturally in one short sentence.` },
      { role: "user", content: instruction },
    ],
  });
}

export async function reasoningCall({ systemPrompt, conversation, userId, agentId, taskId }) {
  const model = await getModelForRole("reasoning");
  return callModel({
    model, userId, agentId, taskId, max_tokens: 1200, temperature: 0.3,
    messages: [{ role: "system", content: systemPrompt }, ...conversation],
  });
}
