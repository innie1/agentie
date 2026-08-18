import axios from "axios";
import { getModelForRole } from "./modelConfig.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Fast conversational path. Simple chat should not wait for Redis/BullMQ.
 * Returns plain assistant text and keeps credentials server-side.
 */
export async function fastChat({ agent, message }) {
  const model = await getModelForRole("fast");
  const system = agent?.system_prompt ||
    "You are Agentie, a helpful AI assistant. Answer naturally, clearly, and concisely. Do not pretend to have completed actions you have not completed.";

  const response = await axios.post(
    OPENROUTER_URL,
    {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message },
      ],
      max_tokens: 700,
      temperature: 0.5,
    },
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

  const text = response.data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter returned an empty response");
  return { text, model };
}

// Deliberately conservative: action-oriented requests remain on the task queue.
export function isFastChatMessage(message = "") {
  const text = message.trim();
  if (!text || text.length > 280) return false;

  const actionPattern = /\b(create|build|make|start|launch|deploy|send|delete|remove|update|change|edit|research|find|search|analy[sz]e|plan|schedule|book|buy|pay|publish|post|email|message|call|delegate|assign|automate|run|execute|organize|organise|generate a report|set up|setup)\b/i;
  if (actionPattern.test(text)) return false;

  return /^(hi|hello|hey|yo|good morning|good afternoon|good evening|thanks|thank you|ok|okay|what|why|how|when|where|who|can you|could you|tell me|explain|help me understand|is |are |do |does |will |would |should |i |my )/i.test(text);
}
