import { supabaseAdmin } from "../supabaseClient.js";

const cache = { fast: null, reasoning: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getModelForRole(role) {
  const now = Date.now();
  if ((role === "fast" || role === "reasoning") && cache[role] && now - cache.fetchedAt < CACHE_TTL_MS) return cache[role];

  const defaults = { fast: "openai/gpt-4o-mini", reasoning: "meta-llama/llama-3.3-70b-instruct" };
  const { data, error } = await supabaseAdmin.from("models_config").select("id,tier,model_id,provider,speed_score,context_length,is_pinned,updated_at");

  if (!error && Array.isArray(data)) {
    for (const row of data) {
      const modelId = typeof row?.model_id === "string" ? row.model_id.trim() : "";
      if (!modelId) continue;
      const tier = typeof row?.tier === "string" ? row.tier.trim().toLowerCase() : "";
      if (tier === "fast" || tier === "reasoning") cache[tier] = modelId;
    }
  }
  cache.fetchedAt = now;
  return cache[role] || defaults[role] || defaults.fast;
}
