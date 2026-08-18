import axios from "axios";
import { getModelForRole } from "./modelConfig.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SAFE_FAST_FALLBACK = "google/gemini-2.5-flash";

/**
 * Fast conversational path. Ordinary conversation must never create a task.
 * If the model catalog contains a model the OpenRouter key cannot use, retry
 * once with the known-good fast fallback instead of returning Fast Chat failed.
 */
export async function fastChat({ agent, message, history = [] }) {
  const configuredModel = await getModelForRole("fast");
  const system = agent?.system_prompt ||
    "You are Agentie, a helpful AI assistant. Answer naturally, clearly, and concisely. Do not pretend to have completed actions you have not completed.";

  const safeHistory = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-12)
    : [];

  const payload = {
    messages: [
      { role: "system", content: system },
      ...safeHistory,
      { role: "user", content: message },
    ],
    max_tokens: 700,
    temperature: 0.5,
  };

  const request = (model) => axios.post(
    OPENROUTER_URL,
    { ...payload, model },
    {
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "https://agentie.ai",
        "X-Title": "Agentie",
      },
    }
  );

  let response;
  let model = configuredModel || SAFE_FAST_FALLBACK;
  try {
    response = await request(model);
  } catch (err) {
    // OpenRouter 403 commonly means the selected model is not available to
    // this API key. Retry with the known-good fast model before failing chat.
    if (err.response?.status === 403 && model !== SAFE_FAST_FALLBACK) {
      console.warn(`[fastChat] model ${model} returned 403; retrying with ${SAFE_FAST_FALLBACK}`);
      model = SAFE_FAST_FALLBACK;
      response = await request(model);
    } else {
      throw err;
    }
  }

  const text = response.data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter returned an empty response");
  return { text, model };
}

/**
 * Conservative task boundary: explicit action requests become tasks.
 * Everything else is ordinary conversation and must stay out of the tasks table.
 */
export function isFastChatMessage(message = "") {
  const text = message.trim();
  if (!text || text.length > 4000) return false;

  const explicitTaskPattern = /\b(create a task|create task|add a task|new task|task to|make this a task|turn this into a task|execute|run this|deploy this|send this|delete this|remove this|update this|schedule this|book this|buy this|pay this|publish this|post this|email this|message them|call them|delegate this|assign this|automate this|generate a report|set up this|setup this)\b/i;
  if (explicitTaskPattern.test(text)) return false;

  const leadingActionPattern = /^(create|build|make|start|launch|deploy|send|delete|remove|update|change|edit|research|find|search|analy[sz]e|plan|schedule|book|buy|pay|publish|post|email|message|call|delegate|assign|automate|run|execute|organize|organise)\b/i;
  if (leadingActionPattern.test(text)) return false;

  return true;
}
