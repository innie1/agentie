import { supabaseAdmin } from "../supabaseClient.js";

const DEFAULT_MODELS = {
  fast: "google/gemini-2.5-flash",
  reasoning: "google/gemini-2.5-pro",
};

const cache = { fast: null, reasoning: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Read the live model catalog using the current models_config schema.
 * The schema uses `id` + `tier`; older code incorrectly expected `role`.
 */
export async function getModelForRole(role) {
  const now = Date.now();
  if (cache[role] && now - cache.fetchedAt < CACHE_TTL_MS) return cache[role];

  const { data, error } = await supabaseAdmin
    .from("models_config")
    .select("id, tier, model_id")
    .order("updated_at", { ascending: false });

  if (error || !data) {
    console.error("[modelConfig] failed to load models_config, using current default:", error?.message);
    cache[role] = DEFAULT_MODELS[role] || DEFAULT_MODELS.fast;
    cache.fetchedAt = now;
    return cache[role];
  }

  for (const row of data) {
    const tier = row.tier || row.id;
    if ((tier === "fast" || tier === "reasoning") && row.model_id) {
      cache[tier] = row.model_id;
    }
  }

  cache[role] = cache[role] || DEFAULT_MODELS[role] || DEFAULT_MODELS.fast;
  cache.fetchedAt = now;
  return cache[role];
}
