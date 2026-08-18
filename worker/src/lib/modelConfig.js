import { supabaseAdmin } from "../supabaseClient.js";

const cache = { fast: null, reasoning: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getModelForRole(role) {
  const now = Date.now();
  if (cache[role] && now - cache.fetchedAt < CACHE_TTL_MS) return cache[role];

  const { data, error } = await supabaseAdmin.from("models_config").select("*");
  if (error || !data) {
    console.error("[modelConfig] failed to load, falling back to default:", error?.message);
    return "google/gemini-2.0-flash-001";
  }

  for (const row of data) cache[row.role] = row.model_id;
  cache.fetchedAt = now;
  return cache[role] || "google/gemini-2.0-flash-001";
}
