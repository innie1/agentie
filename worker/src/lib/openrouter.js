import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { getModelForRole } from "./modelConfig.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function authHeaders() {
  return { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" };
}

async function callModel({ model, messages, max_tokens = 1000, temperature = 0.4, userId, agentId, taskId }) {
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

  return res.data.choices[0].message.content;
}

// Cheap, fast pre-check: is this a simple greeting/ack that doesn't need the full
// plan/act/observe pipeline at all? Uses the fast-tier model with a tiny prompt.
export async function classifyIntent({ instruction, userId, agentId, taskId }) {
  const model = await getModelForRole("fast");
  const raw = await callModel({
    model,
    userId,
    agentId,
    taskId,
    max_tokens: 10,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: "Classify the user's message as exactly one word: SIMPLE (greeting, thanks, small talk, one-word ack) or TASK (anything requiring actual work, a tool call, or a real answer). Respond with only that one word.",
      },
      { role: "user", content: instruction },
    ],
  });
  return raw.trim().toUpperCase().includes("SIMPLE") ? "SIMPLE" : "TASK";
}

// Fast-tier reply for SIMPLE messages — skips planning, tool access, everything.
export async function fastReply({ instruction, agentName, userId, agentId, taskId }) {
  const model = await getModelForRole("fast");
  return callModel({
    model,
    userId,
    agentId,
    taskId,
    max_tokens: 60,
    messages: [
      { role: "system", content: `You are ${agentName}, a brief, friendly AI agent. Reply naturally in one short sentence.` },
      { role: "user", content: instruction },
    ],
  });
}

// Reasoning-tier call for real task planning. Expects the model to return JSON
// describing the next step(s) — see agentLoop.js for the schema it's prompted for.
export async function reasoningCall({ systemPrompt, conversation, userId, agentId, taskId }) {
  const model = await getModelForRole("reasoning");
  return callModel({
    model,
    userId,
    agentId,
    taskId,
    max_tokens: 1200,
    temperature: 0.3,
    messages: [{ role: "system", content: systemPrompt }, ...conversation],
  });
}
