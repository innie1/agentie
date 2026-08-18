import { supabaseAdmin } from "../supabaseClient.js";

const cache = { fast: null, reasoning: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getModelForRole(role) {
  const now = Date.now();
  if (cache[role] && now - cache.fetchedAt < CACHE_TTL_MS) return cache[role];

  const defaultModel = role === "reasoning" ? "meta-llama/llama-3.3-70b-instruct" : "openai/gpt-4o-mini";

  const { data, error } = await supabaseAdmin.from("models_config").select("*");
  if (error || !data || data.length === 0) {
    return defaultModel;
  }

  for (const row of data) {
    const key = row.role || row.id || row.tier;
    if (key) cache[key] = row.model_id;
  }
  cache.fetchedAt = now;
  return cache[role] || defaultModel;
}
