import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { memoryExtractionCall } from "./openrouter.js";

const meaningfulWords = (text) => new Set(String(text || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []);

async function embedding(text) {
  const model = process.env.OPENROUTER_EMBEDDING_MODEL;
  if (!model || !process.env.OPENROUTER_API_KEY) return null;
  try {
    const { data } = await axios.post("https://openrouter.ai/api/v1/embeddings", { model, input: String(text || "").slice(0, 8000) }, { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" } });
    const vector = data?.data?.[0]?.embedding;
    return Array.isArray(vector) && vector.length === 1536 ? vector : null;
  } catch { return null; }
}

export async function retrieveMemories(agentId, instruction, limit = 12) {
  const vector = await embedding(instruction);
  if (vector) {
    const { data, error } = await supabaseAdmin.rpc("match_agent_memory", { p_agent_id: agentId, p_embedding: vector, p_limit: limit });
    if (!error && data?.length) return data;
  }
  const { data } = await supabaseAdmin.from("agent_memory").select("key,value,content,kind,pinned,confidence").eq("agent_id", agentId).limit(200);
  const words = meaningfulWords(instruction);
  return (data || []).map((memory) => ({ memory, score: memory.pinned ? 100 : [...words].reduce((sum, word) => sum + (String(memory.content || `${memory.key} ${memory.value}`).toLowerCase().includes(word) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map(({ memory }) => memory);
}

function parseArray(raw) {
  const text = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch { return []; }
}

export async function extractAndSaveMemories({ agent, task, conversation }) {
  const transcript = (conversation || []).map((message) => `${message.role}: ${message.content}`).join("\n").slice(0, 8000);
  const raw = await memoryExtractionCall({ transcript, userId: task.user_id, agentId: agent.id, taskId: task.id });
  const items = parseArray(raw).filter((item) => item?.key && item?.value).slice(0, 5);
  for (const item of items) {
    const key = String(item.key).trim().slice(0, 100);
    const value = String(item.value).trim().slice(0, 1000);
    const content = `${key}: ${value}`;
    await supabaseAdmin.from("agent_memory").upsert({
      agent_id: agent.id, key, value, content,
      kind: ["preference", "goal", "constraint", "profile"].includes(item.kind) ? item.kind : "fact",
      confidence: Math.max(0, Math.min(Number(item.confidence) || 0.75, 1)),
      embedding: await embedding(content), source_task_id: task.id,
      metadata: { extractor: "agentie-memory-v2" },
    }, { onConflict: "agent_id,key" });
  }
}
