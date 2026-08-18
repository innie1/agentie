import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.MEMORY_MODEL || process.env.FAST_CHAT_MODEL || "google/gemini-2.5-flash-lite";

function parseItems(raw) {
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const start = text.indexOf("["); const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.memories) ? parsed.memories : [];
}

export async function captureConversationMemory({ agentId, userText, assistantText }) {
  if (!process.env.OPENROUTER_API_KEY || !agentId) return [];
  const source = `USER:\n${String(userText || "").slice(0, 4000)}\n\nASSISTANT:\n${String(assistantText || "").slice(0, 2000)}`;
  const { data } = await axios.post(OPENROUTER_URL, {
    model: MODEL,
    temperature: 0,
    max_tokens: 350,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Extract only stable, useful facts the user explicitly revealed and that would improve future help. Return JSON only: {"memories":[{"key":"snake_case_key","value":"fact","kind":"preference|goal|constraint|profile","confidence":0.0}]}. Do not save greetings, temporary requests, assistant claims, guesses, passwords, authentication codes, payment data, health diagnoses, or highly sensitive secrets. Return an empty memories array when nothing durable was stated.` },
      { role: "user", content: source },
    ],
  }, {
    timeout: 12000,
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL || "https://agentie.ai",
      "X-Title": "Agentie",
    },
  });

  const items = parseItems(data?.choices?.[0]?.message?.content).filter(item => item?.key && item?.value).slice(0, 4);
  for (const item of items) {
    const key = String(item.key).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
    const value = String(item.value).trim().slice(0, 1000);
    if (!key || !value) continue;
    await supabaseAdmin.from("agent_memory").upsert({
      agent_id: agentId,
      key,
      value,
      content: `${key}: ${value}`,
      kind: ["preference", "goal", "constraint", "profile"].includes(item.kind) ? item.kind : "fact",
      confidence: Math.max(0, Math.min(Number(item.confidence) || 0.75, 1)),
      metadata: { extractor: "agentie-conversation-memory-v1" },
      updated_at: new Date().toISOString(),
    }, { onConflict: "agent_id,key" });
  }
  return items;
}
